import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { open, readdir, readFile, realpath, rename, stat, statfs, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import type { LoadedNeoClawConfig } from "./config"
import type { NeoClawBridge } from "./bridge"
import { mcpRequest, type StdioServer } from "./mcp-client"
import { buildSkillTree, type InvChat, type InvCopy, type InvSpace, type SkillInventory, type SkillTree } from "./skill-tree"

/**
 * Read-only views of the neo-claw stack (skills, memory, hooks, MCP servers,
 * jobs, nodes, ops) for the console pages. Everything is read on request and
 * cached briefly; nothing polls. The only write is SPACE.md (see saveSpaceNotes).
 */

// ------------------------------------------------------------------ masking

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\br8_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[0-9a-fA-F]{48,}\b/g,
]

/** Hide anything that looks like a credential. Used on every file or log the console shows. */
export function maskSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `${m.slice(0, 4)}…[masked]`)
  out = out.replace(/\b(Bearer|Bot|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi, (_m, kind) => `${kind} [masked]`)
  out = out.replace(
    /((?:api[_-]?key|apikey|access[_-]?key|secret|token|passw(?:or)?d|pwd|auth|credential|private[_-]?key|client[_-]?secret|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;}{]{6,})/gi,
    (_m, head) => `${head}[masked]`,
  )
  out = out.replace(/(https?:\/\/[^\s:/@]+:)([^\s@/]{3,})@/g, (_m, head) => `${head}[masked]@`)
  return out
}

// ------------------------------------------------------------------ helpers

const cache = new Map<string, { at: number; value: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

/** Memoise an async read for `ms`; concurrent callers share one read. */
export async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as T
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const p = fn()
    .then((value) => {
      cache.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > 3_600_000) cache.delete(k)
  }
  return p
}

export function forget(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}

async function readJson<T>(file: string): Promise<T | null> {
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

async function readText(file: string, maxBytes = 512 * 1024): Promise<{ text: string; truncated: boolean } | null> {
  const st = await safeStat(file)
  if (!st?.isFile()) return null
  const fh = await open(file, "r")
  try {
    const len = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    return { text: buf.toString("utf8"), truncated: st.size > maxBytes }
  } finally {
    await fh.close()
  }
}

/** Last `lines` lines of a file, reading at most 256 KB from its end. */
export async function tailFile(file: string, lines = 80): Promise<string | null> {
  const st = await safeStat(file)
  if (!st?.isFile()) return null
  const fh = await open(file, "r")
  try {
    const len = Math.min(st.size, 256 * 1024)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, st.size - len)
    return buf.toString("utf8").split("\n").slice(-lines - 1).join("\n")
  } finally {
    await fh.close()
  }
}

function looksBinary(text: string) {
  return text.slice(0, 8000).includes("\u0000")
}

/** Resolve `rel` inside `root`, refusing anything that escapes it (symlinks included). */
export async function resolveInside(root: string, rel: string): Promise<string | null> {
  if (!rel || rel.includes("\0")) return null
  const joined = path.resolve(root, rel)
  if (joined !== root && !joined.startsWith(root + path.sep)) return null
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(joined)])
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null
    return realFile
  } catch {
    return null
  }
}

/** A text file for display: masked, null if missing, binary or outside `root`. */
export async function readViewable(root: string, rel: string) {
  const file = await resolveInside(root, rel)
  if (!file) return null
  const r = await readText(file, 256 * 1024)
  if (!r) return null
  if (looksBinary(r.text)) return { text: "(binary file, not shown)", truncated: false, file }
  return { text: maskSecrets(r.text), truncated: r.truncated, file }
}

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) })
    })
  })
}

export const isSnowflake = (s: string) => /^\d{5,25}$/.test(s)

export class Stack {
  constructor(
    readonly config: LoadedNeoClawConfig,
    readonly bridge: NeoClawBridge,
  ) {}

  channelDir(channelId: string) {
    return path.join(this.config.contextDir, channelId)
  }

  /** Channel ids that have a context folder on disk. */
  async channelIds(): Promise<string[]> {
    return cached("stack:channelIds", 30_000, async () => (await readdir(this.config.contextDir).catch(() => [] as string[])).filter(isSnowflake))
  }

  private neoClawConfig() {
    if (!this.config.neoClawConfigPath) return Promise.resolve(null)
    return cached("ncconf", 60_000, () => readJson<Record<string, unknown>>(this.config.neoClawConfigPath!))
  }

  // ---------------------------------------------------------------- spaces

  spaceDir(categoryId: string) {
    return path.join(this.config.contextDir, ".spaces", categoryId)
  }

  async spaceNotes(categoryId: string) {
    if (!isSnowflake(categoryId)) return null
    const file = path.join(this.spaceDir(categoryId), "SPACE.md")
    const r = await readText(file, 1024 * 1024)
    const text = r?.text ?? ""
    return { file, text, hash: hashText(text), exists: Boolean(r) }
  }

  async spaceHistory(categoryId: string) {
    const dir = path.join(this.spaceDir(categoryId), ".history")
    const names = await readdir(dir).catch(() => [] as string[])
    return names.filter((n) => n.startsWith("SPACE.md.")).sort().reverse().slice(0, 20)
  }

  /**
   * Write SPACE.md atomically after backing up the old copy. Refuses if the file
   * changed since the editor loaded it (baseHash), so two editors can't clobber.
   */
  async saveSpaceNotes(categoryId: string, text: string, baseHash: string, who: string) {
    if (!isSnowflake(categoryId)) throw new Error("bad space id")
    const dir = this.spaceDir(categoryId)
    if (!(await safeStat(dir))?.isDirectory()) throw new Error("this space has no folder yet; run /space init first")
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error("SPACE.md is limited to 512 KB here")
    const current = await this.spaceNotes(categoryId)
    if (!current) throw new Error("bad space id")
    if (current.hash !== baseHash) {
      return { ok: false as const, conflict: true, current }
    }
    const normalized = text.replace(/\r\n/g, "\n")
    if (normalized === current.text) return { ok: true as const, changed: false, backup: null as string | null, before: current.text }
    let backup: string | null = null
    if (current.exists) {
      const hist = path.join(dir, ".history")
      await mkdir(hist, { recursive: true })
      backup = path.join(hist, `SPACE.md.${new Date().toISOString().replace(/[:.]/g, "-")}.${who.replace(/[^a-z0-9_-]/gi, "")}`)
      await writeFile(backup, current.text, { mode: 0o644 })
    }
    const tmp = path.join(dir, `.SPACE.md.${process.pid}.${Date.now()}.tmp`)
    await writeFile(tmp, normalized, { mode: 0o644 })
    await rename(tmp, current.file)
    return { ok: true as const, changed: true, backup, before: current.text }
  }

  /** The space's mcp.json, read-only: server shapes with env and header values masked. */
  async spaceMcp(categoryId: string) {
    if (!isSnowflake(categoryId)) return []
    const m = await readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(path.join(this.spaceDir(categoryId), "mcp.json"))
    const mask = (o: unknown) => Object.fromEntries(Object.keys((o as Record<string, unknown>) ?? {}).map((k) => [k, "••••"]))
    return Object.entries(m?.mcpServers ?? {}).map(([name, def]) => ({
      name,
      type: typeof def.type === "string" ? def.type : def.url ? "http" : "stdio",
      command: maskSecrets(String(def.command ?? def.url ?? "")),
      args: Array.isArray(def.args) ? (def.args as unknown[]).map((a) => maskSecrets(String(a))) : [],
      env: mask(def.env),
      headers: mask(def.headers),
    }))
  }

  /**
   * Change a space's index entry (mission control). neo-claw re-reads
   * .spaces/index.json on every use and writes it with tmp + rename, so an
   * atomic write here is picked up without a restart. Logged to the space's
   * .history/config.log.
   */
  async saveSpaceConfig(categoryId: string, change: { missionControlChannelId?: string }, who: string) {
    if (!isSnowflake(categoryId)) throw new Error("bad space id")
    const file = path.join(this.config.contextDir, ".spaces", "index.json")
    const index = await readJson<{ spaces?: Record<string, Record<string, unknown>>; channels?: Record<string, { categoryId?: string | null }> }>(file)
    const space = index?.spaces?.[categoryId]
    if (!index || !space) throw new Error("this category isn't a space yet; turn it on first")
    const changes: string[] = []
    if (change.missionControlChannelId !== undefined) {
      const mc = change.missionControlChannelId
      if (!isSnowflake(mc)) throw new Error("bad channel id")
      const member = index.channels?.[mc]?.categoryId === categoryId || this.bridge.placement(mc).categoryId === categoryId
      if (!member) throw new Error("mission control must be a channel in this space")
      if (space.missionControlChannelId !== mc) {
        changes.push(`missionControlChannelId ${String(space.missionControlChannelId ?? "none")} -> ${mc}`)
        space.missionControlChannelId = mc
      }
    }
    if (!changes.length) return { ok: true as const, changed: false }
    const tmp = `${file}.kanna.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o644 })
    await rename(tmp, file)
    const hist = path.join(this.spaceDir(categoryId), ".history")
    await mkdir(hist, { recursive: true }).catch(() => {})
    const line = `${new Date().toISOString()} ${who} via Kanna: ${changes.join("; ")}\n`
    await writeFile(path.join(hist, "config.log"), line, { flag: "a", mode: 0o644 }).catch(() => {})
    console.log(`[neoclaw] space ${categoryId} config: ${who}: ${changes.join("; ")}`)
    await this.bridge.refreshSpaceIndex(0)
    forget("skills")
    return { ok: true as const, changed: true, changes }
  }

  /** Per-chat settings straight from .settings.json (read-only; the bot owns this file). */
  async settingsFile() {
    const raw = (await readJson<{ global?: Record<string, unknown>; channels?: Record<string, Record<string, unknown>> }>(path.join(this.config.contextDir, ".settings.json"))) ?? {}
    return { global: raw.global ?? {}, channels: raw.channels ?? {} }
  }

  /** What each key falls back to when neither the chat nor the global default sets it. */
  async settingsFallbacks(): Promise<Record<string, string>> {
    const nc = await this.neoClawConfig()
    const maxTurns = typeof nc?.maxTurns === "number" && nc.maxTurns ? nc.maxTurns : 50
    return {
      model: typeof nc?.model === "string" ? `${nc.model} (neo-claw config)` : "Claude Code default",
      effort: typeof nc?.effort === "string" ? `${nc.effort} (neo-claw config)` : "Claude Code default",
      maxTurns: `${maxTurns} (neo-claw config)`,
      progressCard: typeof nc?.progressCardEnabled === "boolean" ? `${nc.progressCardEnabled ? "on" : "off"} (neo-claw config)` : "on (neo-claw default)",
      voiceMode: "off",
      slashPassthrough: "on",
      workflows: "off",
      tables: "auto",
    }
  }

  // ---------------------------------------------------------------- skills

  /** What's on disk: global, bundled and space skills, and every skill folder inside each chat. */
  async skillInventory(): Promise<SkillInventory> {
    return cached("skills:inv", 60_000, async () => {
      const index = await this.bridge.refreshSpaceIndex()
      const nc = await this.neoClawConfig()
      const root = this.config.neoClawRoot
      const dirIds = (await readdir(this.config.contextDir).catch(() => [] as string[])).filter(isSnowflake)
      const ids = [...new Set([...dirIds, ...Object.keys(index.channels).filter(isSnowflake)])]
      const chats: InvChat[] = []
      for (const id of ids) {
        const skillsDir = path.join(this.channelDir(id), ".claude", "skills")
        const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])
        const copies: InvCopy[] = []
        for (const d of entries) {
          if (!d.isDirectory() || d.name.startsWith(".")) continue
          const dir = path.join(skillsDir, d.name)
          const meta = await skillMeta(dir)
          const marker = (await readText(path.join(dir, ".installed-sha256"), 256))?.text.trim() ?? null
          copies.push({ name: d.name, description: meta.description, hash: meta.hash, marker })
        }
        chats.push({
          id,
          name: this.bridge.channelName(id),
          remoteHost: this.bridge.isRemote(id),
          categoryId: this.bridge.placement(id).categoryId ?? index.channels[id]?.categoryId ?? null,
          copies,
          spaceManaged: await readJson<string[]>(path.join(skillsDir, ".space-managed.json")),
          bundledManaged: await readJson<string[]>(path.join(skillsDir, ".bundled-managed.json")),
        })
      }
      const spaces: InvSpace[] = []
      for (const [catId, sp] of Object.entries(index.spaces)) {
        spaces.push({ id: catId, name: sp.name, enabled: Boolean(sp.enabled), missionControlChannelId: sp.missionControlChannelId ?? null, skills: await findSkills(path.join(this.spaceDir(catId), "skills")) })
      }
      return {
        global: await findSkills(this.config.globalSkillsDir ?? ""),
        bundled: root ? await findSkills(path.join(root, "skills")) : [],
        defaultOn: Array.isArray(nc?.enabledSkills) ? (nc!.enabledSkills as string[]).filter((x) => typeof x === "string") : [],
        shippedHashes: (root ? await readJson<Record<string, unknown>>(path.join(root, "skills", ".shipped-hashes.json")) : null) as Record<string, string[]> ?? {},
        spaces,
        chats,
        remoteSkillHosts: this.remoteSkillHosts(),
      }
    })
  }

  /** Library tree: each skill once, at the level it comes from (see skill-tree.ts). */
  async skillTree(): Promise<SkillTree> {
    return cached("skills:tree", 60_000, async () => buildSkillTree(await this.skillInventory()))
  }

  /** Every skill on the box as a flat list, with the chats it's in effect in. */
  async skills(): Promise<SkillEntry[]> {
    return cached("skills", 60_000, async () => {
      const inv = await this.skillInventory()
      const tree = await this.skillTree()
      const ids = (refs: { id: string }[]) => refs.map((r) => r.id)
      const out: SkillEntry[] = []
      const localChats = inv.chats.filter((c) => !c.remoteHost).length
      for (const s of inv.global) {
        out.push({ ...s, dir: path.join(this.config.globalSkillsDir ?? "", s.id), source: "global", effect: `every chat on this host (${localChats} local chats)`, channels: [] })
      }
      for (const b of tree.bundled) {
        const s = inv.bundled.find((x) => x.id === b.link.id)!
        out.push({
          ...s,
          dir: path.join(this.config.neoClawRoot ?? "", "skills", s.id),
          source: "bundled",
          effect: `${b.defaultOn ? "enabled by default (enabledSkills); " : "opt-in; "}copied into ${b.holders.length} chat${b.holders.length === 1 ? "" : "s"}${b.edited ? ` (+${b.edited} edited cop${b.edited === 1 ? "y" : "ies"})` : ""}`,
          channels: ids(b.holders),
        })
      }
      for (const sp of inv.spaces) {
        const members = inv.chats.filter((c) => c.categoryId === sp.id).map((c) => c.id)
        for (const s of sp.skills) {
          out.push({
            ...s,
            dir: path.join(this.spaceDir(sp.id), "skills", s.id),
            source: "space",
            spaceId: sp.id,
            spaceName: sp.name,
            effect: sp.enabled ? `member chats of space ${sp.name} (${members.length})` : `space ${sp.name} is off: not in effect`,
            channels: sp.enabled ? members : [],
          })
        }
      }
      // Chat copies that aren't bundled or space-managed, plus retired bundled leftovers.
      const localRows = [
        ...tree.shared,
        ...tree.spaces.flatMap((s) => [...s.shared, ...s.channels.flatMap((c) => c.skills)]),
        ...tree.noSpace.flatMap((c) => c.skills),
      ]
      for (const r of localRows) {
        for (const h of r.holders) {
          out.push({
            id: `${h.id}/${r.name}`,
            name: r.name,
            description: r.description,
            dir: path.join(this.channelDir(h.id), ".claude", "skills", r.name),
            source: "channel",
            channelId: h.id,
            effect: r.shadows ? `this chat only (local copy, shadows ${r.shadows})` : "this chat only",
            channels: [h.id],
          })
        }
      }
      for (const r of tree.retired) {
        for (const h of r.holders) {
          out.push({
            id: `${h.id}/${r.name}`,
            name: r.name,
            description: r.description,
            dir: path.join(this.channelDir(h.id), ".claude", "skills", r.name),
            source: "channel",
            channelId: h.id,
            effect: "left over from a bundled skill neo-claw no longer ships; pruned the next time this chat runs",
            channels: [h.id],
          })
        }
      }
      return out
    })
  }
  /** Skills on remote hosts aren't readable from here. */
  remoteSkillHosts(): string[] {
    return [...new Set(Object.values(this.config.remoteRouting))]
  }

  async skill(source: string, id: string) {
    const all = await this.skills()
    const hit = all.find((s) => s.source === source && s.id === id)
    if (hit || source !== "channel") return hit ?? null
    // Any skill folder inside a chat (e.g. a bundled or space copy) has a page too.
    const m = /^(\d{5,25})\/([\w.-]{1,100})$/.exec(id)
    if (!m) return null
    const dir = await resolveInside(path.join(this.channelDir(m[1]!), ".claude", "skills"), m[2]!)
    if (!dir || !(await safeStat(path.join(dir, "SKILL.md")))?.isFile()) return null
    const meta = await skillMeta(dir)
    return { id, name: meta.name || m[2]!, description: meta.description, dir, source: "channel", channelId: m[1]!, effect: "a copy inside this chat", channels: [m[1]!] } satisfies SkillEntry
  }

  // ---------------------------------------------------------------- memory

  memoryDir(channelId: string) {
    return path.join(this.config.claudeProjectsDir, this.channelDir(channelId).replace(/[^a-zA-Z0-9]/g, "-"), "memory")
  }

  async memory(channelId: string) {
    const memDir = this.memoryDir(channelId)
    const files = (await readdir(memDir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)))
    const index = await readText(path.join(memDir, "MEMORY.md"), 128 * 1024)
    const disc = path.join(this.channelDir(channelId), "discord")
    const summary = await readText(path.join(disc, "summaries", "rolling-summary.md"), 256 * 1024)
    const decisions = await readText(path.join(disc, "summaries", "decisions.md"), 128 * 1024)
    const entities = await readJson<unknown>(path.join(disc, "summaries", "entities.json"))
    const importState = await readJson<Record<string, unknown>>(path.join(disc, "import-state.json"))
    const archive = await this.archiveStats(path.join(disc, "messages.jsonl"))
    return {
      memDir,
      files,
      index: index ? maskSecrets(index.text) : null,
      summary: summary ? maskSecrets(summary.text) : null,
      decisions: decisions ? maskSecrets(decisions.text) : null,
      entityCount: Array.isArray(entities) ? entities.length : entities && typeof entities === "object" ? Object.keys(entities).length : null,
      lastArchivedAt: typeof importState?.lastArchivedAt === "string" ? importState.lastArchivedAt : null,
      archive,
    }
  }

  /** Size and event count of a channel's message archive, counted once per size. */
  private async archiveStats(file: string) {
    const st = await safeStat(file)
    if (!st) return null
    return cached(`archive:${file}:${st.size}`, 3_600_000, async () => {
      let lines = 0
      let messages = 0
      await new Promise<void>((resolve) => {
        let rest = ""
        createReadStream(file, { encoding: "utf8", highWaterMark: 256 * 1024 })
          .on("data", (chunk: string | Buffer) => {
            const parts = (rest + chunk.toString()).split("\n")
            rest = parts.pop() ?? ""
            for (const l of parts) {
              lines++
              if (l.includes('"message_create"')) messages++
            }
          })
          .on("end", () => resolve())
          .on("error", () => resolve())
      })
      return { bytes: st.size, events: lines, messages, mtime: st.mtimeMs }
    })
  }

  async memorySidecar(channelId: string) {
    const url = this.config.memorySidecarUrl
    if (!url) return { configured: false as const }
    const health = await cached("sidecar:health", 30_000, async () => {
      try {
        const r = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1500) })
        return r.ok
      } catch {
        return false
      }
    })
    if (!health) return { configured: true as const, up: false as const }
    const get = async (p: string) => {
      try {
        const r = await fetch(new URL(p, url), { signal: AbortSignal.timeout(4000) })
        return r.ok ? ((await r.json()) as Record<string, unknown>[]) : null
      } catch {
        return null
      }
    }
    return cached(`sidecar:${channelId}`, 60_000, async () => ({
      configured: true as const,
      up: true as const,
      facts: await get(`/channels/${encodeURIComponent(channelId)}/facts?limit=25`),
      episodes: await get(`/channels/${encodeURIComponent(channelId)}/episodes?limit=15`),
    }))
  }

  // ---------------------------------------------------------------- hooks + settings

  async settings() {
    return cached("settings", 30_000, async () => {
      const s = (await readJson<Record<string, unknown>>(this.config.claudeSettingsPath ?? "")) ?? {}
      const envKeys = Object.keys((s.env as Record<string, unknown>) ?? {})
      const compactRaw = (s.env as Record<string, unknown> | undefined)?.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      const nc = await this.neoClawConfig()
      const ncWindow = typeof nc?.autoCompactWindow === "number" ? nc.autoCompactWindow : null
      const compact =
        typeof compactRaw === "string" && /^\d{4,8}$/.test(compactRaw)
          ? { tokens: Number(compactRaw), from: "CLAUDE_CODE_AUTO_COMPACT_WINDOW in Claude Code settings env" }
          : ncWindow
            ? { tokens: ncWindow, from: "autoCompactWindow in neo-claw.config.json" }
            : { tokens: 200_000, from: "neo-claw default" }

      const hooks: HookEntry[] = []
      for (const [event, groups] of Object.entries((s.hooks as Record<string, unknown>) ?? {})) {
        if (!Array.isArray(groups)) continue
        for (const g of groups as { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]) {
          for (const h of g.hooks ?? []) {
            const command = h.command ?? ""
            const script = command.trim().split(/\s+/)[0] ?? ""
            const src = script.startsWith("/") ? await readText(script, 128 * 1024) : null
            hooks.push({
              event,
              matcher: g.matcher ?? null,
              command: maskSecrets(command),
              timeout: h.timeout ?? null,
              script: src ? script : null,
              description: src ? describeScript(src.text) : null,
              source: src && !looksBinary(src.text) ? maskSecrets(src.text) : null,
            })
          }
        }
      }
      const perms = (s.permissions as Record<string, unknown>) ?? {}
      const channelSettings = (await readJson<{ global?: Record<string, unknown>; channels?: Record<string, Record<string, unknown>> }>(path.join(this.config.contextDir, ".settings.json"))) ?? {}
      return {
        file: this.config.claudeSettingsPath,
        envKeys,
        compact,
        hooks,
        permissions: {
          defaultMode: typeof perms.defaultMode === "string" ? perms.defaultMode : null,
          allow: Array.isArray(perms.allow) ? (perms.allow as string[]).map(maskSecrets) : [],
          deny: Array.isArray(perms.deny) ? (perms.deny as string[]).map(maskSecrets) : [],
        },
        mcpServerNames: Object.keys((s.mcpServers as Record<string, unknown>) ?? {}),
        channelGlobal: pickSettings(channelSettings.global),
        channelSettings: Object.fromEntries(Object.entries(channelSettings.channels ?? {}).map(([k, v]) => [k, pickSettings(v)])),
      }
    })
  }

  // ---------------------------------------------------------------- MCP servers

  /** Configured MCP servers: user-level (settings.json) and per-chat (.mcp.json), grouped by name and shape. */
  async mcpServers(): Promise<McpServerEntry[]> {
    return cached("mcp", 120_000, async () => {
      const out = new Map<string, McpServerEntry>()
      const add = (scope: "user" | "chat", name: string, def: Record<string, unknown>, channelId: string | null, cwd: string | null) => {
        const args = Array.isArray(def.args) ? (def.args as string[]).map(String) : []
        const shapeArgs = args.map((a) => (isSnowflake(a) ? "<channel>" : a))
        const key = `${scope}|${name}|${String(def.command ?? def.url ?? "")}|${shapeArgs.join(" ")}`
        const entry = out.get(key) ?? {
          key: createHash("sha1").update(key).digest("hex").slice(0, 12),
          scope,
          name,
          type: typeof def.type === "string" ? def.type : def.url ? "http" : "stdio",
          command: maskSecrets(String(def.command ?? def.url ?? "")),
          args: shapeArgs.map(maskSecrets),
          envKeys: Object.keys((def.env as Record<string, unknown>) ?? {}),
          headerKeys: Object.keys((def.headers as Record<string, unknown>) ?? {}),
          channels: [],
          sample: null,
        }
        if (channelId) entry.channels.push(channelId)
        if (!entry.sample && typeof def.command === "string") {
          entry.sample = { command: def.command, args, env: (def.env as Record<string, string>) ?? {}, cwd: cwd ?? undefined }
        }
        out.set(key, entry)
      }
      const s = (await readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(this.config.claudeSettingsPath ?? "")) ?? {}
      for (const [name, def] of Object.entries(s.mcpServers ?? {})) add("user", name, def, null, null)
      const channels = (await readdir(this.config.contextDir).catch(() => [] as string[])).filter(isSnowflake)
      for (const id of channels) {
        const m = await readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(path.join(this.channelDir(id), ".mcp.json"))
        for (const [name, def] of Object.entries(m?.mcpServers ?? {})) add("chat", name, def, id, this.channelDir(id))
      }
      return [...out.values()].sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : 1))
    })
  }

  /** Start one server briefly and list its tools. On demand only; cached for an hour. */
  async mcpTools(key: string) {
    const entry = (await this.mcpServers()).find((e) => e.key === key)
    if (!entry) return { error: "unknown server" }
    if (!entry.sample) return { error: `${entry.type} server: tools aren't listed from here (it would mean calling the remote service)` }
    const sample = entry.sample
    return cached(`mcptools:${key}`, 3_600_000, async () => {
      try {
        const r = await mcpRequest<{ tools?: { name: string; description?: string }[] }>(sample, "tools/list", {}, 25_000)
        return { tools: (r.tools ?? []).map((t) => ({ name: t.name, description: maskSecrets(t.description ?? "") })) }
      } catch (e) {
        return { error: maskSecrets(e instanceof Error ? e.message : String(e)) }
      }
    }).then((r) => {
      if ("error" in r) forget(`mcptools:${key}`) // don't remember failures
      return r
    })
  }

  // ---------------------------------------------------------------- search

  /**
   * search_channels, exactly as a chat would call it: the channel's own
   * channel-search MCP, so space scoping matches (scope "space" searches the
   * other chats in the caller's space).
   */
  async search(query: string, opts: { fromChannelId: string | null; scope: "space" | "all"; maxResults: number }) {
    const servers = await this.mcpServers()
    const base = servers.find((s) => s.name === "channel-search" && s.sample)
    if (!base?.sample) return { error: "no chat has the channel-search MCP configured" }
    const args = [...(base.sample.args ?? [])]
    const i = args.indexOf("--current-channel-id")
    if (opts.fromChannelId) {
      if (i >= 0) args[i + 1] = opts.fromChannelId
      else args.push("--current-channel-id", opts.fromChannelId)
    } else if (i >= 0) {
      args.splice(i, 2)
    }
    const server: StdioServer = { command: base.sample.command, args, env: base.sample.env, cwd: this.config.contextDir }
    try {
      const r = await mcpRequest<{ content?: { type: string; text?: string }[]; isError?: boolean }>(
        server,
        "tools/call",
        { name: "search_channels", arguments: { query, scope: opts.scope, max_results: opts.maxResults, max_per_channel: 3 } },
        20_000,
      )
      const text = (r.content ?? []).map((c) => c.text ?? "").join("\n")
      return r.isError ? { error: maskSecrets(text) } : { text: maskSecrets(text) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ---------------------------------------------------------------- jobs

  async jobs() {
    return cached("jobs", 10_000, async () => {
      const dir = path.join(this.config.contextDir, ".neo-claw-wakes")
      const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"))
      const wakes: WakeEntry[] = []
      for (const n of names) {
        const w = await readJson<Record<string, unknown>>(path.join(dir, n))
        if (!w || typeof w.id !== "string") continue
        wakes.push({
          id: w.id,
          kind: String(w.kind ?? ""),
          status: String(w.status ?? ""),
          host: typeof w.host === "string" ? w.host : null,
          channelId: typeof w.channelId === "string" ? w.channelId : null,
          note: maskSecrets(String(w.note ?? "")),
          jobName: typeof w.jobName === "string" ? w.jobName : null,
          command: typeof w.command === "string" ? maskSecrets(w.command) : null,
          createdAt: String(w.createdAt ?? ""),
          fireAt: typeof w.fireAt === "string" ? w.fireAt : null,
          firedAt: typeof w.firedAt === "string" ? w.firedAt : null,
          logFile: typeof w.logFile === "string" ? w.logFile : null,
          pid: typeof w.pid === "number" ? w.pid : null,
        })
      }
      wakes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const t = await readJson<unknown>(path.join(this.config.contextDir, ".terminals.json"))
      const list = Array.isArray(t) ? t : Array.isArray((t as { list?: unknown })?.list) ? (t as { list: unknown[] }).list : []
      const terminals = (list as Record<string, unknown>[]).map((x) => ({
        terminalId: String(x.terminalId ?? ""),
        channelId: typeof x.channelId === "string" ? x.channelId : null,
        name: String(x.name ?? ""),
        command: maskSecrets([x.command, ...(Array.isArray(x.args) ? x.args : [])].join(" ")),
        status: String(x.status ?? ""),
        mode: String(x.mode ?? ""),
        restartPolicy: String(x.restartPolicy ?? ""),
        updatedAt: String(x.updatedAt ?? x.startedAt ?? ""),
      }))
      terminals.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt.localeCompare(a.updatedAt))
      return { wakes, terminals }
    })
  }

  /** A local job log under the context dir; remote logs stay remote. */
  async jobLog(id: string) {
    const w = (await this.jobs()).wakes.find((x) => x.id === id)
    if (!w?.logFile) return null
    if (w.host && w.host !== "local") return { remote: w.host, text: null }
    const file = await resolveInside(this.config.contextDir, path.relative(this.config.contextDir, w.logFile))
    if (!file) return { remote: null, text: "(log is outside the context dir; not shown)" }
    const t = await tailFile(file, 200)
    return { remote: null, text: t == null ? "(log file is gone)" : maskSecrets(t) }
  }

  // ---------------------------------------------------------------- nodes

  async nodes() {
    const cli = this.config.nodeCli
    if (!cli) return { configured: false as const }
    return cached("nodes", 30_000, async () => {
      const r = await run(cli, ["list", "--json"], 20_000)
      if (!r.ok) return { configured: true as const, error: maskSecrets(r.stderr.slice(-400)) }
      try {
        const j = JSON.parse(r.stdout) as { nodes?: Record<string, unknown>[] }
        return { configured: true as const, nodes: j.nodes ?? [] }
      } catch {
        return { configured: true as const, error: "unreadable output" }
      }
    })
  }

  async nodeJobs(node: string) {
    const cli = this.config.nodeCli
    if (!cli || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(node)) return null
    return cached(`nodejobs:${node}`, 60_000, async () => {
      const r = await run(cli, ["jobs", node], 20_000)
      return maskSecrets((r.stdout || r.stderr).slice(-20_000))
    })
  }

  // ---------------------------------------------------------------- ops

  async ops() {
    return cached("ops", 15_000, async () => {
      const services: { name: string; state: string }[] = []
      for (const name of this.config.services ?? []) {
        if (!/^[\w@.-]+$/.test(name)) continue
        const r = await run("systemctl", ["is-active", name], 5000)
        services.push({ name, state: r.stdout.trim() || "unknown" })
      }
      const load = (await readFile("/proc/loadavg", "utf8").catch(() => "")).split(" ").slice(0, 3).join(" ")
      const mem: Record<string, number> = {}
      for (const line of (await readFile("/proc/meminfo", "utf8").catch(() => "")).split("\n")) {
        const m = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)/.exec(line)
        if (m) mem[m[1]!] = Number(m[2]) * 1024
      }
      let disk: { total: number; free: number } | null = null
      try {
        const s = await statfs(this.config.contextDir)
        disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
      } catch {
        disk = null
      }
      const root = this.config.neoClawRoot
      const queue = (await readJson<unknown[]>(path.join(this.config.contextDir, ".deploy-queue.json"))) ?? []
      const deployLog = root ? await tailFile(path.join(root, "logs", "deploy-when-idle.log"), 25) : null
      return {
        services,
        load,
        mem,
        disk,
        // deploy-when-idle writes naive local timestamps; parse them in this server's zone.
        queue: (Array.isArray(queue) ? queue : []).map((q) =>
          q && typeof q === "object" && typeof (q as { queued_at?: unknown }).queued_at === "string"
            ? { ...(q as object), queuedAtMs: Date.parse((q as { queued_at: string }).queued_at) || null }
            : q
        ),
        deployLog: deployLog ? maskSecrets(deployLog) : null,
      }
    })
  }
}

// ------------------------------------------------------------------ types + small helpers

export interface SkillEntry {
  id: string
  name: string
  description: string
  dir: string
  source: "global" | "bundled" | "space" | "channel"
  effect: string
  channels: string[]
  spaceId?: string
  spaceName?: string
  channelId?: string
}

export interface HookEntry {
  event: string
  matcher: string | null
  command: string
  timeout: number | null
  script: string | null
  description: string | null
  source: string | null
}

export interface McpServerEntry {
  key: string
  scope: "user" | "chat"
  name: string
  type: string
  command: string
  args: string[]
  envKeys: string[]
  headerKeys: string[]
  channels: string[]
  sample: StdioServer | null
}

export interface WakeEntry {
  id: string
  kind: string
  status: string
  host: string | null
  channelId: string | null
  note: string
  jobName: string | null
  command: string | null
  createdAt: string
  fireAt: string | null
  firedAt: string | null
  logFile: string | null
  pid: number | null
}

export function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function pickSettings(v: Record<string, unknown> | undefined) {
  if (!v) return {}
  const out: Record<string, string> = {}
  for (const k of ["model", "effort", "maxTurns"]) if (v[k] != null) out[k] = String(v[k])
  return out
}

/** First comment or docstring paragraph of a script. */
function describeScript(src: string) {
  const doc = /^(?:#!.*\n)?\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/.exec(src)
  if (doc) return (doc[1] ?? doc[2] ?? "").trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").slice(0, 600)
  const lines: string[] = []
  for (const l of src.split("\n").slice(0, 40)) {
    if (l.startsWith("#!")) continue
    const m = /^\s*(?:#|\/\/)\s?(.*)$/.exec(l)
    if (m) {
      if (m[1]!.trim() === "" && lines.length) break
      if (m[1]!.trim()) lines.push(m[1]!.trim())
    } else if (l.trim() && lines.length) break
  }
  return lines.length ? lines.join(" ").slice(0, 600) : null
}

async function skillMeta(dir: string) {
  const r = await readText(path.join(dir, "SKILL.md"), 1024 * 1024)
  const fm = r ? /^---\n([\s\S]*?)\n---/.exec(r.text)?.[1] ?? "" : ""
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "")
  const raw = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? ""
  // Unquote YAML scalars: "…" keeps \" escapes, '…' doubles single quotes.
  const description = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw
  // Full sha256, comparable with neo-claw's .installed-sha256 and shipped hashes.
  const hash = r && !r.truncated ? createHash("sha256").update(r.text, "utf8").digest("hex") : null
  return { name, description, hasSkillMd: Boolean(r), hash }
}

/** Skill folders (holding SKILL.md) up to three levels under `root`. */
async function findSkills(root: string): Promise<{ id: string; name: string; description: string; dir: string; hash: string | null }[]> {
  if (!root) return []
  const out: { id: string; name: string; description: string; dir: string; hash: string | null }[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue
      const sub = path.join(dir, e.name)
      const meta = await skillMeta(sub)
      if (meta.hasSkillMd) {
        const id = path.relative(root, sub)
        out.push({ id, name: meta.name || e.name, description: meta.description, dir: sub, hash: meta.hash })
      } else if (depth < 3) {
        await walk(sub, depth + 1)
      }
    }
  }
  await walk(root, 1)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Files under a skill folder for the tree view (bounded). */
export async function fileTree(root: string, limit = 300) {
  const out: { rel: string; size: number; dir: boolean }[] = []
  const walk = async (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.name === "node_modules" || e.name === ".git") continue
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full)
      if (e.isDirectory()) {
        out.push({ rel, size: 0, dir: true })
        await walk(full, depth + 1)
      } else if (e.isFile()) {
        out.push({ rel, size: (await safeStat(full))?.size ?? 0, dir: false })
      }
    }
  }
  await walk(root, 0)
  return { files: out, truncated: out.length >= limit }
}
