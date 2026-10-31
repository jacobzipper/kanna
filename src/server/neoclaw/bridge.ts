import { createReadStream, existsSync } from "node:fs"
import { open, readdir, readFile, stat, writeFile, rename } from "node:fs/promises"
import path from "node:path"
import { createGunzip } from "node:zlib"
import type { EventStore } from "../event-store"
import type { KannaStatus, TranscriptEntry } from "../../shared/types"
import type { LoadedNeoClawConfig } from "./config"
import type { SessionUser } from "./auth"
import { createParseState, parseLine, type ParseState } from "./transcript"

/**
 * Maps neo-claw's world onto Kanna's: one Kanna project per Discord channel
 * (its context dir), one chat per Claude session (local channels) or one
 * chat built from run traces (channels routed to a remote host, whose
 * session files live on that host).
 *
 * Transcripts are imported lazily: a chat is filled from the tail of its
 * session file the first time someone opens it, then followed live by
 * polling the file (and its subagent files) for appended lines. Kanna's own
 * store keeps the imported entries, so windowing, search and rendering all
 * work unchanged.
 *
 * Web turns never run through Kanna's agent: they go to neo-claw's local web
 * API, which runs them in the channel exactly like a Discord message.
 */

const CHANNEL_ID = /^\d{5,25}$/
const SCAN_MS = 20_000
const TAIL_MS = 2_000
const STATUS_MS = 3_000
const CHANNEL_INFO_MS = 5 * 60_000
const REMOTE_TRACES_ON_IMPORT = 6
const LAST_MESSAGE_THROTTLE_MS = 60_000

interface ChatLink {
  chatId: string
  channelId: string
  kind: "session" | "remote"
  sessionId?: string
  imported: boolean
  /** Source key (absolute path, or `agent:<id>`) -> bytes consumed; -1 = fully read (gz). */
  offsets: Record<string, number>
  lastMessageAt?: number
}

/** Where a channel sits in Discord, remembered so grouping survives the API being down. */
interface ChannelPlacement {
  categoryId: string | null
  categoryName: string | null
  categoryPosition: number | null
  position: number | null
}

interface PersistedState {
  projects: Record<string, string>
  chats: Record<string, ChatLink>
  placements?: Record<string, ChannelPlacement>
}

interface ChannelInfo {
  id: string
  name: string | null
  guildName: string | null
  categoryId?: string | null
  categoryName: string | null
  categoryPosition?: number | null
  position?: number | null
  remoteHost: string | null
}

export interface SpaceIndexFile {
  spaces: Record<string, { name: string; guildId: string; enabled: boolean; missionControlChannelId?: string; createdAt: string }>
  channels: Record<string, { categoryId: string | null; name: string; lastSeenAt: string }>
}

export interface ChannelSummary {
  channelId: string
  name: string
  projectId: string | null
  chatId: string | null
  remoteHost: string | null
  running: boolean
  queued: number
  contextTokens: number | null
  categoryId: string | null
  categoryName: string | null
}

interface ChannelStatus {
  running: boolean
  queued: number
  sessionId: string | null
  remoteHost: string | null
}

type WebTurnPhase = "sending" | "queued" | "running"

export interface NeoClawOverview {
  apiReachable: boolean
  links: { label: string; url: string }[]
  channels: {
    channelId: string
    name: string
    projectId: string | null
    remoteHost: string | null
    running: boolean
    queued: number
    sessionId: string | null
    contextTokens: number | null
    lastCompactAt: number | null
  }[]
  deployQueue: unknown[] | null
}

export interface NeoClawBridgeDeps {
  store: EventStore
  config: LoadedNeoClawConfig
  /** A chat's transcript or status changed. */
  onChatChanged: (chatId: string) => void
  /** Projects/chats were added or renamed, or statuses moved. */
  onSidebarChanged: () => void
}

function encodeProjectDir(dir: string) {
  return dir.replace(/[^a-zA-Z0-9]/g, "-")
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

async function safeStat(file: string) {
  try {
    return await stat(file)
  } catch {
    return null
  }
}

/** Read [start, end) of a file as text; returns the text up to the last newline and the new offset. */
async function readRange(file: string, start: number, end: number, dropPartialFirstLine: boolean) {
  const handle = await open(file, "r")
  try {
    const length = Math.max(0, end - start)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    let text = buf.toString("utf8")
    let consumedStart = 0
    if (dropPartialFirstLine) {
      const nl = text.indexOf("\n")
      consumedStart = nl === -1 ? text.length : nl + 1
      text = text.slice(consumedStart)
    }
    const lastNl = text.lastIndexOf("\n")
    if (lastNl === -1) return { text: "", offset: dropPartialFirstLine ? start + Buffer.byteLength(buf.toString("utf8").slice(0, consumedStart)) : start }
    const complete = text.slice(0, lastNl + 1)
    const prefix = buf.toString("utf8").slice(0, consumedStart)
    return { text: complete, offset: start + Buffer.byteLength(prefix) + Buffer.byteLength(complete) }
  } finally {
    await handle.close()
  }
}

async function readGzip(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    createReadStream(file).pipe(createGunzip()).on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))).on("error", reject)
  })
}

export class NeoClawBridge {
  private readonly store: EventStore
  private readonly config: LoadedNeoClawConfig
  private readonly statePath: string
  private state: PersistedState = { projects: {}, chats: {} }
  private chatKeyById = new Map<string, string>()
  private parseStates = new Map<string, ParseState>()
  private channelInfo = new Map<string, ChannelInfo>()
  private channelInfoAt = 0
  private statuses = new Map<string, ChannelStatus>()
  private apiReachable = false
  private webTurns = new Map<string, WebTurnPhase>()
  private authorNames = new Map<string, string>()
  private sessionsMap: Record<string, string> = {}
  private lastStatusSignature = ""
  private busy = new Set<string>()
  private importing = new Map<string, Promise<void>>()
  private timers: ReturnType<typeof setInterval>[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSessions = new Set<string>()
  private archiveCache = new Map<string, { size: number; name: string | null }>()
  private contextTokens = new Map<string, number>()
  private lastCompactAt = new Map<string, number>()
  private spaceIndex: SpaceIndexFile = { spaces: {}, channels: {} }
  private spaceIndexAt = 0
  private sidebarOrder: string[] = []
  /** Bumps when the neo-claw sidebar order changes (part of the router's sidebar memo key). */
  orderVersion = 0

  constructor(private readonly deps: NeoClawBridgeDeps) {
    this.store = deps.store
    this.config = deps.config
    this.statePath = path.join(this.store.dataDir, "neoclaw-bridge.json")
    for (const user of this.config.users) this.authorNames.set(user.discordId, user.displayName)
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    const saved = await readJsonFile<PersistedState>(this.statePath)
    if (saved?.projects && saved.chats) this.state = saved
    // Drop links whose chat no longer exists in the store.
    for (const [key, link] of Object.entries(this.state.chats)) {
      if (!this.store.getChat(link.chatId)) delete this.state.chats[key]
      else this.chatKeyById.set(link.chatId, key)
    }
    await this.guard("status", () => this.refreshStatus())
    // Waits out a scan the status poll may have kicked off, then runs one.
    while (this.busy.has("scan")) await new Promise((r) => setTimeout(r, 100))
    await this.guard("scan", () => this.scan())
    this.timers.push(setInterval(() => void this.guard("scan", () => this.scan()), SCAN_MS))
    this.timers.push(setInterval(() => void this.guard("tail", () => this.tailAll()), TAIL_MS))
    this.timers.push(setInterval(() => void this.guard("status", () => this.refreshStatus()), STATUS_MS))
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  private async guard(name: string, fn: () => Promise<void>) {
    if (this.busy.has(name)) return
    this.busy.add(name)
    try {
      await fn()
    } catch (error) {
      console.warn(`[neo-claw bridge] ${name} failed:`, error)
    } finally {
      this.busy.delete(name)
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const tmp = `${this.statePath}.tmp`
      void writeFile(tmp, JSON.stringify(this.state), "utf8").then(() => rename(tmp, this.statePath)).catch((error) => {
        console.warn("[neo-claw bridge] save failed:", error)
      })
    }, 500)
  }

  // ---------------------------------------------------------------- lookups

  get mirrorDefault() {
    return this.config.mirrorDefault ?? true
  }

  managesChat(chatId: string) {
    return this.chatKeyById.has(chatId)
  }

  managesProject(projectId: string) {
    return Object.values(this.state.projects).includes(projectId)
  }

  managedChatIds() {
    return new Set(this.chatKeyById.keys())
  }

  private linkFor(chatId: string) {
    const key = this.chatKeyById.get(chatId)
    return key ? this.state.chats[key] ?? null : null
  }

  private channelForProject(projectId: string) {
    for (const [channelId, id] of Object.entries(this.state.projects)) if (id === projectId) return channelId
    return null
  }

  private remoteHostFor(channelId: string) {
    return this.config.remoteRouting[channelId] ?? this.channelInfo.get(channelId)?.remoteHost ?? null
  }

  private channelDir(channelId: string) {
    return path.join(this.config.contextDir, channelId)
  }

  private sessionDir(channelId: string) {
    return path.join(this.config.claudeProjectsDir, encodeProjectDir(this.channelDir(channelId)))
  }

  private authorName = (discordId: string) => this.authorNames.get(discordId) ?? null

  /** The chat a new message to this channel lands in. */
  private currentChatFor(channelId: string) {
    if (this.remoteHostFor(channelId)) return this.state.chats[`remote:${channelId}`]?.chatId ?? null
    const sessionId = this.statuses.get(channelId)?.sessionId ?? this.sessionsMap[channelId]
    return sessionId ? this.state.chats[`session:${sessionId}`]?.chatId ?? null : null
  }

  // ---------------------------------------------------------------- statuses

  getStatuses(): Map<string, KannaStatus> {
    const out = new Map<string, KannaStatus>()
    const channels = new Set([...this.statuses.keys(), ...this.webTurns.keys()])
    for (const channelId of channels) {
      const chatId = this.currentChatFor(channelId)
      if (!chatId) continue
      const s = this.statuses.get(channelId)
      const web = this.webTurns.get(channelId)
      if (s?.running || web === "running") out.set(chatId, "running")
      else if ((s?.queued ?? 0) > 0 || web === "queued" || web === "sending") out.set(chatId, "starting")
    }
    return out
  }

  private async api(pathname: string, init?: RequestInit) {
    if (!this.config.apiUrl || !this.config.apiSecret) throw new Error("neo-claw web API is not configured")
    const headers = new Headers(init?.headers)
    headers.set("X-Neo-Claw-Secret", this.config.apiSecret)
    if (init?.body) headers.set("Content-Type", "application/json")
    return await fetch(new URL(pathname, this.config.apiUrl), { ...init, headers })
  }

  private async refreshStatus() {
    let next = new Map<string, ChannelStatus>()
    this.sessionsMap = (await readJsonFile<Record<string, string>>(path.join(this.config.contextDir, ".sessions.json"))) ?? this.sessionsMap
    try {
      const res = await this.api("/api/status", { signal: AbortSignal.timeout(2000) })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const body = (await res.json()) as { channels: Record<string, ChannelStatus> }
      for (const [id, s] of Object.entries(body.channels ?? {})) next.set(id, s)
      this.apiReachable = true
    } catch {
      this.apiReachable = false
      // Fallback: a session file written in the last 20s means a run is going.
      next = new Map()
      const now = Date.now()
      for (const [channelId, sessionId] of Object.entries(this.sessionsMap)) {
        const remote = this.remoteHostFor(channelId)
        const file = remote ? null : path.join(this.sessionDir(channelId), `${sessionId}.jsonl`)
        const st = file ? await safeStat(file) : null
        next.set(channelId, { running: Boolean(st && now - st.mtimeMs < 20_000), queued: 0, sessionId, remoteHost: remote })
      }
    }
    this.statuses = next
    // New session for a channel (reset/compaction recovery): pick it up now
    // rather than at the next full scan, once its transcript exists.
    for (const [channelId, s] of next) {
      if (!s.sessionId || s.remoteHost || this.remoteHostFor(channelId) || this.state.chats[`session:${s.sessionId}`]) continue
      if (this.pendingSessions.has(s.sessionId)) continue
      if (!existsSync(path.join(this.sessionDir(channelId), `${s.sessionId}.jsonl`))) continue
      this.pendingSessions.add(s.sessionId)
      void this.guard("scan", () => this.scan()).finally(() => this.pendingSessions.delete(s.sessionId!))
      break
    }
    const signature = JSON.stringify([...this.getStatuses().entries()].sort())
    if (signature !== this.lastStatusSignature) {
      const before = new Set<string>(JSON.parse(this.lastStatusSignature || "[]").map((e: [string, string]) => e[0]))
      this.lastStatusSignature = signature
      for (const chatId of new Set([...before, ...this.getStatuses().keys()])) this.deps.onChatChanged(chatId)
      this.deps.onSidebarChanged()
    }
  }

  // ---------------------------------------------------------------- scanning

  private async refreshChannelInfo() {
    if (Date.now() - this.channelInfoAt < CHANNEL_INFO_MS && this.channelInfo.size > 0) return
    this.channelInfoAt = Date.now()
    const info = new Map<string, ChannelInfo>()
    try {
      const res = await this.api("/api/channels", { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const body = (await res.json()) as { channels: ChannelInfo[] }
        for (const c of body.channels ?? []) info.set(c.id, c)
      }
    } catch {
      // API not up yet: fall back to files below
    }
    await this.refreshSpaceIndex(0)
    for (const [id, c] of Object.entries(this.spaceIndex.channels)) {
      if (!info.has(id) && c.name) info.set(id, { id, name: c.name, guildName: null, categoryName: null, remoteHost: null })
    }
    // Remember placements the API reported; they group the sidebar while it's down.
    const placements = (this.state.placements ??= {})
    for (const c of info.values()) {
      if (c.categoryId === undefined) continue
      const next: ChannelPlacement = { categoryId: c.categoryId ?? null, categoryName: c.categoryName ?? null, categoryPosition: c.categoryPosition ?? null, position: c.position ?? null }
      if (JSON.stringify(placements[c.id]) !== JSON.stringify(next)) {
        placements[c.id] = next
        this.scheduleSave()
      }
    }
    this.channelInfo = info
  }

  /** Name from the channel's Discord archive (first message carries channelName); also learns author names. */
  private async archiveInfo(channelId: string): Promise<string | null> {
    const file = path.join(this.channelDir(channelId), "discord", "messages.jsonl")
    const st = await safeStat(file)
    if (!st) return null
    const cached = this.archiveCache.get(channelId)
    if (cached && cached.size === st.size) return cached.name
    try {
      const { text } = await readRange(file, Math.max(0, st.size - 256 * 1024), st.size, st.size > 256 * 1024)
      let name: string | null = null
      for (const line of text.split("\n")) {
        if (!line.includes('"message_create"')) continue
        try {
          const ev = JSON.parse(line) as { channelName?: string; authorId?: string; authorName?: string; authorGlobalName?: string; authorBot?: boolean }
          if (ev.channelName) name = ev.channelName
          if (ev.authorId && !ev.authorBot && !this.config.users.some((u) => u.discordId === ev.authorId)) {
            this.authorNames.set(ev.authorId, ev.authorGlobalName || ev.authorName || ev.authorId)
          }
        } catch {
          // skip
        }
      }
      this.archiveCache.set(channelId, { size: st.size, name })
      return name
    } catch {
      return null
    }
  }

  private async scan() {
    await this.refreshChannelInfo()
    let entries: string[] = []
    try {
      entries = (await readdir(this.config.contextDir, { withFileTypes: true })).filter((d) => d.isDirectory() && CHANNEL_ID.test(d.name)).map((d) => d.name)
    } catch {
      return
    }
    let changed = false
    const perChannel = this.config.sessionsPerChannel ?? 5
    for (const channelId of entries) {
      const remote = this.remoteHostFor(channelId)
      const archiveName = await this.archiveInfo(channelId)
      // Which sessions to show.
      let sessions: { id: string; file: string; mtime: number }[] = []
      let remoteTraces: string[] = []
      if (remote) {
        remoteTraces = await this.listTraces(channelId)
        if (remoteTraces.length === 0) continue
      } else {
        const dir = this.sessionDir(channelId)
        try {
          const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"))
          const stats = await Promise.all(files.map(async (f) => ({ id: f.slice(0, -6), file: path.join(dir, f), st: await safeStat(path.join(dir, f)) })))
          sessions = stats.filter((s) => s.st && s.st.size > 0).map((s) => ({ id: s.id, file: s.file, mtime: s.st!.mtimeMs }))
        } catch {
          sessions = []
        }
        if (sessions.length === 0) continue
        sessions.sort((a, b) => b.mtime - a.mtime)
        const current = this.sessionsMap[channelId]
        const keep = sessions.slice(0, perChannel)
        const cur = sessions.find((s) => s.id === current)
        if (cur && !keep.includes(cur)) keep.unshift(cur)
        sessions = keep
      }

      const info = this.channelInfo.get(channelId)
      const name = info?.name ?? archiveName ?? channelId
      const title = this.titleFor(channelId, name, remote)
      let projectId = this.state.projects[channelId]
      if (!projectId || !this.store.getProject(projectId)) {
        const project = await this.store.openProject(this.channelDir(channelId), title)
        projectId = project.id
        this.state.projects[channelId] = projectId
        changed = true
      } else if ((this.store.getProject(projectId)?.sidebarTitle ?? this.store.getProject(projectId)?.title) !== title) {
        await this.store.renameProjectSidebarTitle(projectId, title).catch(() => undefined)
        changed = true
      }

      if (remote) {
        const key = `remote:${channelId}`
        if (!this.state.chats[key]) {
          const chat = await this.store.createChat(projectId, undefined, { hidden: false })
          await this.store.renameChat(chat.id, `Runs on ${remote}`)
          this.state.chats[key] = { chatId: chat.id, channelId, kind: "remote", imported: false, offsets: {} }
          this.chatKeyById.set(chat.id, key)
          changed = true
        }
        const latest = remoteTraces[remoteTraces.length - 1]
        const st = latest ? await safeStat(latest) : null
        if (st) changed = (await this.noteActivity(this.state.chats[key]!, st.mtimeMs)) || changed
        continue
      }

      for (const s of sessions) {
        const key = `session:${s.id}`
        let link = this.state.chats[key]
        if (!link) {
          const chat = await this.store.createChat(projectId, undefined, { hidden: false })
          await this.store.renameChat(chat.id, await this.sessionTitle(s.file, s.id))
          link = { chatId: chat.id, channelId, kind: "session", sessionId: s.id, imported: false, offsets: {} }
          this.state.chats[key] = link
          this.chatKeyById.set(chat.id, key)
          changed = true
        }
        changed = (await this.noteActivity(link, s.mtime)) || changed
      }
    }
    if (this.updateSidebarOrder()) changed = true
    if (changed) {
      this.scheduleSave()
      this.deps.onSidebarChanged()
    }
  }

  // ---------------------------------------------------------------- grouping

  /** Category, space and position for a channel, from the API, the spaces index or memory. */
  placement(channelId: string) {
    const saved = this.state.placements?.[channelId]
    const categoryId = saved?.categoryId ?? this.spaceIndex.channels[channelId]?.categoryId ?? null
    const space = categoryId ? this.spaceIndex.spaces[categoryId] : undefined
    const isSpace = Boolean(space?.enabled)
    const categoryName = (isSpace ? space?.name : null) ?? saved?.categoryName ?? space?.name ?? null
    return {
      categoryId,
      categoryName,
      categoryPosition: saved?.categoryPosition ?? null,
      position: saved?.position ?? null,
      isSpace,
      isMission: isSpace && space?.missionControlChannelId === channelId,
    }
  }

  private titleFor(channelId: string, name: string, remote: string | null) {
    const p = this.placement(channelId)
    const suffix = remote ? ` (${remote})` : ""
    if (p.isSpace) {
      return p.isMission
        ? `◆ ${p.categoryName} › ★ #${name} · mission control${suffix}`
        : `◆ ${p.categoryName} › #${name}${suffix}`
    }
    if (p.categoryId) return `${p.categoryName ?? `category …${p.categoryId.slice(-4)}`} › #${name}${suffix}`
    return `#${name}${suffix}`
  }

  /** Spaces first, then categories in Discord order, then the rest; mission control leads its space. */
  private updateSidebarOrder() {
    const rows = Object.entries(this.state.projects).map(([channelId, projectId]) => {
      const p = this.placement(channelId)
      const title = this.store.getProject(projectId)?.sidebarTitle ?? this.store.getProject(projectId)?.title ?? channelId
      return { projectId, p, title }
    })
    const groupRank = (p: ReturnType<NeoClawBridge["placement"]>) => (p.isSpace ? 0 : p.categoryId ? 1 : 2)
    rows.sort((a, b) =>
      groupRank(a.p) - groupRank(b.p) ||
      (a.p.categoryPosition ?? 1e9) - (b.p.categoryPosition ?? 1e9) ||
      (a.p.categoryName ?? a.p.categoryId ?? "").localeCompare(b.p.categoryName ?? b.p.categoryId ?? "") ||
      Number(b.p.isMission) - Number(a.p.isMission) ||
      (a.p.position ?? 1e9) - (b.p.position ?? 1e9) ||
      a.title.localeCompare(b.title))
    const order = rows.map((r) => r.projectId)
    if (order.join(",") === this.sidebarOrder.join(",")) return false
    this.sidebarOrder = order
    this.orderVersion++
    return true
  }

  /** Project order for the sidebar in neo-claw mode. */
  getSidebarOrder() {
    return this.sidebarOrder
  }

  // ---------------------------------------------------------------- console helpers

  getSpaceIndex() {
    return this.spaceIndex
  }

  /** Re-read .spaces/index.json if the copy in memory is older than maxAgeMs (it's small). */
  async refreshSpaceIndex(maxAgeMs = 3000) {
    if (Date.now() - this.spaceIndexAt < maxAgeMs) return this.spaceIndex
    const spaces = await readJsonFile<Partial<SpaceIndexFile>>(path.join(this.config.contextDir, ".spaces", "index.json"))
    this.spaceIndex = { spaces: spaces?.spaces ?? {}, channels: spaces?.channels ?? {} }
    this.spaceIndexAt = Date.now()
    return this.spaceIndex
  }

  isApiReachable() {
    return this.apiReachable
  }

  overviewLinks() {
    return this.config.links ?? []
  }

  channelName(channelId: string) {
    const projectId = this.state.projects[channelId]
    const fromApi = this.channelInfo.get(channelId)?.name
    return fromApi ?? this.spaceIndex.channels[channelId]?.name ?? (projectId ? this.store.getProject(projectId)?.title?.replace(/^.*#/, "") : null) ?? channelId
  }

  isRemote(channelId: string) {
    return this.remoteHostFor(channelId)
  }

  /** Every channel the console knows: mirrored ones, plus API and spaces-index channels. */
  knownChannelIds() {
    return [...new Set([...Object.keys(this.state.projects), ...this.channelInfo.keys(), ...Object.keys(this.spaceIndex.channels)])]
  }

  channelSummary(channelId: string): ChannelSummary {
    const s = this.statuses.get(channelId)
    const p = this.placement(channelId)
    return {
      channelId,
      name: this.channelName(channelId),
      projectId: this.state.projects[channelId] ?? null,
      chatId: this.currentChatFor(channelId),
      remoteHost: this.remoteHostFor(channelId),
      running: Boolean(s?.running) || this.webTurns.get(channelId) === "running",
      queued: s?.queued ?? 0,
      contextTokens: this.contextTokens.get(channelId) ?? null,
      categoryId: p.categoryId,
      categoryName: p.categoryName,
    }
  }

  /** GET a neo-claw API endpoint as JSON; null when the API is down. */
  async apiGet<T>(pathname: string, timeoutMs = 4000): Promise<T | null> {
    try {
      const res = await this.api(pathname, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      return null
    }
  }

  /** GET with the HTTP status, so callers can tell "endpoint missing" (404) from "API down" (status 0). */
  async apiGetStatus<T>(pathname: string, timeoutMs = 4000): Promise<{ status: number; body: T | null }> {
    try {
      const res = await this.api(pathname, { signal: AbortSignal.timeout(timeoutMs) })
      const body = res.ok ? ((await res.json().catch(() => null)) as T | null) : null
      return { status: res.status, body }
    } catch {
      return { status: 0, body: null }
    }
  }

  /** /space init | off through neo-claw. Returns the API's JSON or throws with its error. */
  async spaceAction(action: "init" | "off", body: Record<string, unknown>, user: SessionUser, mirror: boolean) {
    let res: Response
    try {
      res = await this.api(`/api/space/${action}`, {
        method: "POST",
        body: JSON.stringify({ ...body, discordUserId: user.discordId, displayName: user.displayName, mirror }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error("neo-claw's web API isn't reachable, so space actions are unavailable until the bot runs a build with it.")
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String(json.error ?? `neo-claw refused (${res.status})`))
    await this.refreshSpacesSoon()
    return json
  }

  /** /space backfill: a normal turn in mission control, streamed like a web turn. */
  async startBackfill(categoryId: string, missionChannelId: string, user: SessionUser, mirror: boolean) {
    this.webTurns.set(missionChannelId, "sending")
    this.deps.onSidebarChanged()
    let res: Response
    try {
      res = await this.api("/api/space/backfill", {
        method: "POST",
        body: JSON.stringify({ categoryId, discordUserId: user.discordId, displayName: user.displayName, mirror }),
      })
    } catch {
      this.webTurns.delete(missionChannelId)
      this.deps.onSidebarChanged()
      throw new Error("neo-claw's web API isn't reachable, so backfill is unavailable until the bot runs a build with it.")
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      this.webTurns.delete(missionChannelId)
      this.deps.onSidebarChanged()
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `neo-claw refused the backfill (${res.status})`)
    }
    void this.consumeTurnStream(missionChannelId, res)
  }

  private async refreshSpacesSoon() {
    await this.refreshSpaceIndex(0)
    this.channelInfoAt = 0
    void this.guard("scan", () => this.scan())
  }

  private async noteActivity(link: ChatLink, at: number) {
    if (link.lastMessageAt && at - link.lastMessageAt < LAST_MESSAGE_THROTTLE_MS) return false
    link.lastMessageAt = at
    // Private on the store; it only appends a "last message at" event.
    await (this.store as unknown as { recordLastMessageAt(chatId: string, at: number): Promise<void> }).recordLastMessageAt(link.chatId, Math.floor(at))
    this.scheduleSave()
    return true
  }

  private async sessionTitle(file: string, sessionId: string) {
    const st = await safeStat(file)
    if (!st) return `Session ${sessionId.slice(0, 8)}`
    let title: string | null = null
    let firstPrompt: string | null = null
    try {
      const { text } = await readRange(file, Math.max(0, st.size - 512 * 1024), st.size, st.size > 512 * 1024)
      for (const line of text.split("\n")) {
        if (line.includes('"ai-title"')) {
          try {
            title = (JSON.parse(line) as { aiTitle?: string }).aiTitle ?? title
          } catch {
            // ignore
          }
        }
      }
      if (!title) {
        const head = await readRange(file, 0, Math.min(st.size, 256 * 1024), false)
        const state = createParseState({ source: "title", authorName: this.authorName })
        for (const line of head.text.split("\n")) {
          const prompt = parseLine(line, state).find((e) => e.kind === "user_prompt")
          if (prompt && prompt.kind === "user_prompt" && prompt.content.trim()) {
            firstPrompt = prompt.content.trim().replace(/\s+/g, " ").slice(0, 60)
            break
          }
        }
      }
    } catch {
      // fall through
    }
    const date = new Date(st.birthtimeMs || st.mtimeMs).toISOString().slice(0, 10)
    return `${title ?? firstPrompt ?? `Session ${sessionId.slice(0, 8)}`} · ${date}`
  }

  private async listTraces(channelId: string) {
    const dir = path.join(this.channelDir(channelId), ".neo-claw", "runs")
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(dir, f))
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- import + tail

  /** Called before Kanna loads a chat's transcript. */
  async ensureImported(chatId: string) {
    const link = this.linkFor(chatId)
    if (!link || link.imported) return
    const pending = this.importing.get(chatId)
    if (pending) return await pending
    const job = (async () => {
      const entries = link.kind === "remote" ? await this.initialRemoteEntries(link) : await this.initialSessionEntries(link)
      for (const entry of entries) await this.store.appendMessage(chatId, entry)
      link.imported = true
      this.scheduleSave()
    })().finally(() => this.importing.delete(chatId))
    this.importing.set(chatId, job)
    await job
  }

  private parseStateFor(link: ChatLink, source: string, parentToolUseId?: string) {
    const key = `${link.chatId}|${source}`
    let state = this.parseStates.get(key)
    if (!state) {
      state = createParseState({
        source: `${link.chatId}|${source}`,
        parentToolUseId,
        trackContext: !parentToolUseId,
        authorName: this.authorName,
      })
      this.parseStates.set(key, state)
    }
    return state
  }

  private noteEntries(link: ChatLink, entries: TranscriptEntry[]) {
    for (const e of entries) {
      if (e.kind === "context_window_updated") this.contextTokens.set(link.channelId, e.usage.usedTokens)
      if (e.kind === "compact_boundary") this.lastCompactAt.set(link.channelId, e.createdAt)
    }
  }

  private parseText(link: ChatLink, source: string, text: string, parentToolUseId?: string, offset = 0) {
    const state = this.parseStateFor(link, source, parentToolUseId)
    // Ids must stay unique across restarts (parse state is in memory), so
    // they include where in the file this chunk started.
    const base = `${link.chatId}|${source}`
    state.source = `${base}@${offset}`
    state.lineCounter = 0
    const out: TranscriptEntry[] = []
    for (const line of text.split("\n")) out.push(...parseLine(line, state))
    state.source = base
    // Prompts this console sent show as "web", not "Discord".
    const web = this.webPrompts.get(link.channelId)
    if (web?.length) {
      for (const e of out) {
        if (e.kind !== "user_prompt" || e.parentToolUseId) continue
        const match = web.find((p) => p.text === e.content.trim() && Math.abs(p.at - e.createdAt) < 30 * 60_000)
        if (match) e.author = { name: match.user.displayName, discordId: match.user.discordId, via: "web" }
      }
    }
    this.noteEntries(link, out)
    return out
  }

  private async subagentFiles(link: ChatLink) {
    const dir = path.join(this.sessionDir(link.channelId), link.sessionId!, "subagents")
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const out: { agentId: string; file: string; gz: boolean; toolUseId?: string }[] = []
    for (const f of files) {
      const m = /^agent-([A-Za-z0-9_-]+)\.jsonl(\.gz)?$/.exec(f)
      if (!m) continue
      const meta = await readJsonFile<{ toolUseId?: string }>(path.join(dir, `agent-${m[1]}.meta.json`))
      out.push({ agentId: m[1]!, file: path.join(dir, f), gz: Boolean(m[2]), toolUseId: meta?.toolUseId })
    }
    return out
  }

  private async initialSessionEntries(link: ChatLink): Promise<TranscriptEntry[]> {
    const file = path.join(this.sessionDir(link.channelId), `${link.sessionId}.jsonl`)
    const st = await safeStat(file)
    if (!st) return []
    const tailBytes = this.config.tailBytes ?? 4 * 1024 * 1024
    const start = Math.max(0, st.size - tailBytes)
    const { text, offset } = await readRange(file, start, st.size, start > 0)
    link.offsets[file] = offset
    const main = this.parseText(link, "main", text, undefined, start)
    const windowStart = main.find((e) => e.createdAt)?.createdAt ?? 0
    const merged: TranscriptEntry[] = []
    if (start > 0) {
      merged.push({
        _id: `nc-trunc-${link.chatId}`,
        createdAt: Math.max(0, windowStart - 1),
        kind: "status",
        status: `Earlier history (${Math.round(start / 1024 / 1024)} MB of transcript) is not shown here.`,
      } as TranscriptEntry)
    }
    merged.push(...main)
    for (const sub of await this.subagentFiles(link)) {
      const sst = await safeStat(sub.file)
      if (!sst || sst.mtimeMs < windowStart) {
        link.offsets[`agent:${sub.agentId}`] = sub.gz ? -1 : sst?.size ?? 0
        continue
      }
      if (sub.gz) {
        merged.push(...this.parseText(link, `agent:${sub.agentId}`, await readGzip(sub.file).catch(() => ""), sub.toolUseId))
        link.offsets[`agent:${sub.agentId}`] = -1
      } else {
        const r = await readRange(sub.file, 0, sst.size, false)
        merged.push(...this.parseText(link, `agent:${sub.agentId}`, r.text, sub.toolUseId))
        link.offsets[`agent:${sub.agentId}`] = r.offset
      }
    }
    // Stable merge by time: subagent work lands between its Agent call and the result.
    return merged.map((e, i) => [e, i] as const).sort((a, b) => a[0].createdAt - b[0].createdAt || a[1] - b[1]).map(([e]) => e)
  }

  private async tailAll() {
    const now = Date.now()
    for (const link of Object.values(this.state.chats)) {
      if (!link.imported || this.importing.has(link.chatId)) continue
      // Only follow chats with recent activity, plus whatever runs now.
      const status = this.statuses.get(link.channelId)
      const recent = (link.lastMessageAt ?? 0) > now - 30 * 60_000
      if (!recent && !status?.running && !this.webTurns.has(link.channelId)) continue
      const appended = link.kind === "remote" ? await this.tailRemote(link) : await this.tailSession(link)
      if (appended.length > 0) {
        for (const entry of appended) await this.store.appendMessage(link.chatId, entry)
        await this.noteActivity(link, now)
        this.scheduleSave()
        this.deps.onChatChanged(link.chatId)
      }
    }
  }

  private async tailSession(link: ChatLink) {
    const out: TranscriptEntry[] = []
    const file = path.join(this.sessionDir(link.channelId), `${link.sessionId}.jsonl`)
    const st = await safeStat(file)
    if (st) {
      const offset = link.offsets[file] ?? 0
      if (st.size < offset) link.offsets[file] = 0
      if (st.size > (link.offsets[file] ?? 0)) {
        const from = link.offsets[file] ?? 0
        const r = await readRange(file, from, st.size, false)
        link.offsets[file] = r.offset
        out.push(...this.parseText(link, "main", r.text, undefined, from))
      }
    }
    for (const sub of await this.subagentFiles(link)) {
      const key = `agent:${sub.agentId}`
      const offset = link.offsets[key]
      if (offset === -1) continue
      if (sub.gz) {
        // Compressed after we last looked: read whatever we hadn't.
        const text = await readGzip(sub.file).catch(() => "")
        const rest = offset ? Buffer.from(text).subarray(offset).toString("utf8") : text
        out.push(...this.parseText(link, key, rest, sub.toolUseId, offset ?? 0))
        link.offsets[key] = -1
        continue
      }
      const sst = await safeStat(sub.file)
      if (!sst || sst.size <= (offset ?? 0)) continue
      const r = await readRange(sub.file, offset ?? 0, sst.size, false)
      link.offsets[key] = r.offset
      out.push(...this.parseText(link, key, r.text, sub.toolUseId, offset ?? 0))
    }
    return out
  }

  // Remote channels: neo-claw keeps each run's raw stream-json locally
  // (`.neo-claw/runs/<stamp>-<session8>.jsonl`). Those carry no prompt, so
  // the prompt comes from the channel's Discord archive (or the web send).

  private webPrompts = new Map<string, { at: number; text: string; user: SessionUser; threadId?: string | null }[]>()
  private triggerCache = new Map<string, { size: number; triggers: { at: number; text: string; authorId: string; authorName: string; threadId: string | null }[] }>()

  private traceStart(file: string) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(path.basename(file))
    return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0
  }

  private async archiveTriggers(channelId: string) {
    const file = path.join(this.channelDir(channelId), "discord", "messages.jsonl")
    const st = await safeStat(file)
    if (!st) return []
    const hit = this.triggerCache.get(channelId)
    if (hit && hit.size === st.size) return hit.triggers
    const { text } = await readRange(file, Math.max(0, st.size - 2 * 1024 * 1024), st.size, st.size > 2 * 1024 * 1024)
    const out: { at: number; text: string; authorId: string; authorName: string; threadId: string | null }[] = []
    for (const line of text.split("\n")) {
      if (!line.includes('"triggerType":"') || !line.includes('"message_create"')) continue
      try {
        const ev = JSON.parse(line) as { createdAt: string; channelId?: string; cleanContent?: string; content?: string; authorId: string; authorName: string; authorGlobalName?: string; triggerType?: string | null }
        if (!ev.triggerType) continue
        out.push({ at: Date.parse(ev.createdAt), text: (ev.cleanContent ?? ev.content ?? "").replace(/^@neo-claw\s*/, ""), authorId: ev.authorId, authorName: ev.authorGlobalName || ev.authorName, threadId: ev.channelId && ev.channelId !== channelId ? ev.channelId : null })
      } catch {
        // skip
      }
    }
    this.triggerCache.set(channelId, { size: st.size, triggers: out })
    return out
  }

  private async traceEntries(link: ChatLink, file: string, fromOffset: number, prevStart: number) {
    const st = await safeStat(file)
    if (!st) return { entries: [] as TranscriptEntry[], offset: fromOffset }
    const startAt = this.traceStart(file)
    const entries: TranscriptEntry[] = []
    if (fromOffset === 0) {
      // The prompt that started this run: newest trigger between the previous run and this one.
      const web = (this.webPrompts.get(link.channelId) ?? []).filter((p) => p.at <= startAt + 5000 && p.at > prevStart)
      if (web.length === 0) {
        const triggers = (await this.archiveTriggers(link.channelId)).filter((t) => t.at <= startAt + 2000 && t.at > prevStart)
        const t = triggers[triggers.length - 1]
        if (t) {
          entries.push({ _id: `nc-tp-${path.basename(file)}`, createdAt: t.at, kind: "user_prompt", content: t.text, author: { name: this.authorNames.get(t.authorId) ?? t.authorName, discordId: t.authorId, via: "discord" } } as TranscriptEntry)
        }
      }
    }
    if (st.size <= fromOffset) return { entries, offset: fromOffset }
    const r = await readRange(file, fromOffset, st.size, false)
    const parsed = this.parseText(link, `trace:${path.basename(file)}`, r.text, undefined, fromOffset)
    // stream-json has no timestamps. Historic runs: space entries out from
    // the run start. Live tail: "now" (the parser's default), kept monotonic.
    let t = Math.max(startAt, ...entries.map((e) => e.createdAt))
    for (const e of parsed) {
      t = fromOffset > 0 ? Math.max(t + 1, e.createdAt) : t + 1
      e.createdAt = t
    }
    entries.push(...parsed)
    return { entries, offset: r.offset }
  }

  private async initialRemoteEntries(link: ChatLink) {
    const traces = (await this.listTraces(link.channelId)).slice(-REMOTE_TRACES_ON_IMPORT)
    const all: TranscriptEntry[] = []
    let prev = 0
    for (const file of traces) {
      const { entries, offset } = await this.traceEntries(link, file, 0, prev)
      link.offsets[file] = offset
      all.push(...entries)
      prev = this.traceStart(file)
    }
    return all
  }

  private async tailRemote(link: ChatLink) {
    const traces = await this.listTraces(link.channelId)
    const out: TranscriptEntry[] = []
    let prev = 0
    for (const file of traces) {
      const known = link.offsets[file]
      if (known === undefined) {
        // Only runs newer than the import are followed.
        const latestKnown = Math.max(0, ...Object.keys(link.offsets).map((f) => this.traceStart(f)))
        if (this.traceStart(file) <= latestKnown) {
          prev = this.traceStart(file)
          continue
        }
      }
      const { entries, offset } = await this.traceEntries(link, file, known ?? 0, prev)
      link.offsets[file] = offset
      out.push(...entries)
      prev = this.traceStart(file)
    }
    // Forget traces neo-claw has rotated away.
    for (const f of Object.keys(link.offsets)) if (!traces.includes(f)) delete link.offsets[f]
    return out
  }

  // ---------------------------------------------------------------- turns

  /** Resolve a target channel for a send from a chat or a project. */
  resolveChannel(args: { chatId?: string; projectId?: string }) {
    if (args.chatId) {
      const link = this.linkFor(args.chatId)
      if (link) return link.channelId
    }
    if (args.projectId) return this.channelForProject(args.projectId)
    return null
  }

  async sendTurn(args: { channelId: string; text: string; user: SessionUser; mirror: boolean; steer: boolean; threadId?: string }): Promise<{ chatId: string | null; steered: boolean }> {
    const text = args.text.trim()
    if (!text) throw new Error("Empty message")
    if (!this.config.apiUrl || !this.config.apiSecret) throw new Error("neo-claw web API is not configured on this server")
    this.webTurns.set(args.channelId, "sending")
    this.deps.onSidebarChanged()
    let res: Response
    try {
      res = await this.api("/api/turn", {
        method: "POST",
        body: JSON.stringify({ channelId: args.channelId, threadId: args.threadId, text, discordUserId: args.user.discordId, displayName: args.user.displayName, mirror: args.mirror, steer: args.steer }),
      })
    } catch {
      this.webTurns.delete(args.channelId)
      this.deps.onSidebarChanged()
      throw new Error("neo-claw's web API isn't reachable (is the bot running a build with the web API?)")
    }
    if (!res.ok) {
      this.webTurns.delete(args.channelId)
      this.deps.onSidebarChanged()
      const body = await res.text().catch(() => "")
      throw new Error(`neo-claw refused the turn (${res.status}): ${body.slice(0, 200)}`)
    }
    const remote = this.remoteHostFor(args.channelId)
    const sent = (this.webPrompts.get(args.channelId) ?? this.webPrompts.set(args.channelId, []).get(args.channelId)!)
    sent.push({ at: Date.now(), text, user: args.user, threadId: args.threadId ?? null })
    if (sent.length > 20) sent.splice(0, sent.length - 20)
    const chatId = this.currentChatFor(args.channelId)
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      // Steered into the running turn.
      this.webTurns.delete(args.channelId)
      this.deps.onSidebarChanged()
      return { chatId, steered: true }
    }
    if (remote && chatId) {
      await this.store.appendMessage(chatId, {
        _id: `nc-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        kind: "user_prompt",
        content: text,
        author: { name: args.user.displayName, discordId: args.user.discordId, via: "web" },
      } as TranscriptEntry)
      this.deps.onChatChanged(chatId)
    }
    void this.consumeTurnStream(args.channelId, res)
    return { chatId, steered: false }
  }

  private async consumeTurnStream(channelId: string, res: Response) {
    const reader = res.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ""
    const handle = (event: string, data: string) => {
      if (event === "queued") {
        const pos = (() => {
          try {
            return (JSON.parse(data) as { position?: number }).position ?? 0
          } catch {
            return 0
          }
        })()
        this.webTurns.set(channelId, pos > 0 ? "queued" : "running")
      } else if (event === "started") {
        this.webTurns.set(channelId, "running")
        // A web turn can mint a session (new channel): rescan soon.
        void this.guard("scan", () => this.scan())
      } else if (event === "done" || event === "error") {
        this.webTurns.delete(channelId)
        if (event === "error") {
          const chatId = this.currentChatFor(channelId)
          let message = data
          try {
            message = (JSON.parse(data) as { error?: string }).error ?? data
          } catch {
            // raw
          }
          if (chatId) {
            void this.store.appendMessage(chatId, { _id: `nc-err-${Date.now()}`, createdAt: Date.now(), kind: "status", status: `neo-claw: ${message}` } as TranscriptEntry).then(() => this.deps.onChatChanged(chatId))
          }
        }
      } else {
        return
      }
      const chatId = this.currentChatFor(channelId)
      if (chatId) this.deps.onChatChanged(chatId)
      this.deps.onSidebarChanged()
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          let event = "message"
          let data = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7)
            else if (line.startsWith("data: ")) data += line.slice(6)
          }
          handle(event, data)
        }
      }
    } catch {
      // stream broke: status polling takes over
    } finally {
      if (this.webTurns.has(channelId)) {
        this.webTurns.delete(channelId)
        this.deps.onSidebarChanged()
      }
    }
  }

  async stopTurn(channelId: string) {
    const res = await this.api("/api/stop", { method: "POST", body: JSON.stringify({ channelId }) }).catch(() => null)
    if (!res) throw new Error("neo-claw's web API isn't reachable")
    if (res.status === 409) throw new Error("Nothing is running in this channel")
    if (!res.ok) throw new Error(`neo-claw refused to stop (${res.status})`)
  }

  // ---------------------------------------------------------------- app API helpers

  /** The Kanna chat a new message to this channel lands in (its current session). */
  currentChat(channelId: string) {
    return this.currentChatFor(channelId)
  }

  /** Run state for a channel, merged with web turns in flight. */
  channelState(channelId: string) {
    const s = this.statuses.get(channelId)
    const web = this.webTurns.get(channelId)
    return {
      running: Boolean(s?.running) || web === "running",
      queued: (s?.queued ?? 0) + (web === "queued" || web === "sending" ? 1 : 0),
      sessionId: s?.sessionId ?? this.sessionsMap[channelId] ?? null,
    }
  }

  liveContextTokens(channelId: string) {
    return this.contextTokens.get(channelId) ?? null
  }

  /** Kanna chats mirrored for a channel: one per Claude session (newest first). */
  sessionChats(channelId: string) {
    const current = this.currentChatFor(channelId)
    const out: { chatId: string; sessionId: string | null; kind: "session" | "remote"; title: string; lastMessageAt: number | null; current: boolean }[] = []
    for (const link of Object.values(this.state.chats)) {
      if (link.channelId !== channelId) continue
      const chat = this.store.getChat(link.chatId)
      if (!chat) continue
      out.push({
        chatId: link.chatId,
        sessionId: link.sessionId ?? null,
        kind: link.kind,
        title: chat.title ?? "Session",
        lastMessageAt: link.lastMessageAt ?? chat.lastMessageAt ?? null,
        current: link.chatId === current,
      })
    }
    out.sort((a, b) => Number(b.current) - Number(a.current) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    return out
  }

  /** Channel a Kanna chat belongs to. */
  channelForChat(chatId: string) {
    return this.linkFor(chatId)?.channelId ?? null
  }

  /** Who started each run: a web prompt from here, or the Discord message that triggered it. */
  async runTriggers(channelId: string, runs: { id: string; startedAt: number }[]) {
    const out = new Map<string, { author: string; authorId: string | null; text: string; via: "web" | "discord"; threadId: string | null }>()
    if (runs.length === 0) return out
    const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt)
    const archive = await this.archiveTriggers(channelId)
    const web = this.webPrompts.get(channelId) ?? []
    let prev = 0
    for (const r of sorted) {
      const floor = Math.max(prev, r.startedAt - 6 * 3600_000)
      const w = web.filter((p) => p.at <= r.startedAt + 5000 && p.at > floor).pop()
      const a = archive.filter((t) => t.at <= r.startedAt + 2000 && t.at > floor).pop()
      if (w && (!a || w.at >= a.at)) out.set(r.id, { author: w.user.displayName, authorId: w.user.discordId, text: w.text, via: "web", threadId: w.threadId ?? null })
      else if (a) out.set(r.id, { author: this.authorNames.get(a.authorId) ?? a.authorName, authorId: a.authorId, text: a.text, via: "discord", threadId: a.threadId })
      prev = r.startedAt
    }
    return out
  }

  /** POST to the neo-claw API, returning its JSON or throwing its error message. */
  async apiPost(pathname: string, body: Record<string, unknown>, timeoutMs = 30_000) {
    let res: Response
    try {
      res = await this.api(pathname, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new Error("neo-claw's web API isn't reachable right now (it comes up with the next bot deploy).")
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const err = new Error(String(json.error ?? `neo-claw refused (${res.status})`)) as Error & { status?: number; detail?: unknown }
      err.status = res.status
      err.detail = json
      throw err
    }
    return json
  }

  /** Something was created on Discord: re-read names and spaces soon. */
  async afterDiscordChange() {
    await this.refreshSpacesSoon()
  }

  // ---------------------------------------------------------------- overview panel

  async overview(): Promise<NeoClawOverview> {
    const channels: NeoClawOverview["channels"] = []
    for (const [channelId, projectId] of Object.entries(this.state.projects)) {
      const s = this.statuses.get(channelId)
      channels.push({
        channelId,
        name: this.store.getProject(projectId)?.title ?? channelId,
        projectId,
        remoteHost: this.remoteHostFor(channelId),
        running: Boolean(s?.running) || this.webTurns.get(channelId) === "running",
        queued: s?.queued ?? 0,
        sessionId: s?.sessionId ?? this.sessionsMap[channelId] ?? null,
        contextTokens: this.contextTokens.get(channelId) ?? null,
        lastCompactAt: this.lastCompactAt.get(channelId) ?? null,
      })
    }
    channels.sort((a, b) => Number(b.running) - Number(a.running) || b.queued - a.queued || a.name.localeCompare(b.name))
    const deployQueue = await readJsonFile<unknown[]>(path.join(this.config.contextDir, ".deploy-queue.json"))
    return { apiReachable: this.apiReachable, links: this.config.links ?? [], channels, deployQueue }
  }
}
