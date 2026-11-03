import { diffLines } from "diff"
import { stat } from "node:fs/promises"
import { open } from "node:fs/promises"
import path from "node:path"
import type { NeoClawBridge } from "./bridge"
import type { SessionUser } from "./auth"
import { DiscordDirectory, snowflakeTime, type DiscordThread } from "./discord-rest"
import { listRunFiles, runDetail, runSummary, isRunId, type RunSummary } from "./runs"
import { cached, fileTree, forget, isSnowflake, maskSecrets, readViewable, type Stack } from "./stack"

/**
 * JSON API for the neo-claw app (`/api/nc/*`). Everything sits behind the login
 * gate in server.ts; writes also need a same-origin Origin header. Reads are
 * cached briefly; nothing here polls on its own.
 */

export interface AppContext {
  stack: Stack
  bridge: NeoClawBridge
  directory: DiscordDirectory
  user: SessionUser
  validateOrigin: (req: Request) => boolean
}

// ------------------------------------------------------------------ model

export interface ThreadNode {
  id: string
  name: string
  archived: boolean
  lastActivityAt: number | null
  messageCount: number | null
}

export interface ChannelNode {
  id: string
  name: string
  guildId: string | null
  categoryId: string | null
  position: number
  kind: "text" | "forum" | "announcement"
  topic: string | null
  remoteHost: string | null
  running: boolean
  queued: number
  chatId: string | null
  lastActivityAt: number | null
  hasHistory: boolean
  spaceId: string | null
  isMission: boolean
  threadCount: number
  threads: ThreadNode[]
  gone: boolean
}

export interface CategoryNode {
  id: string
  name: string
  guildId: string | null
  position: number
  isSpace: boolean
  spaceEnabled: boolean
  missionControlChannelId: string | null
  channels: ChannelNode[]
}

export interface Tree {
  guildName: string | null
  directory: "discord" | "cache"
  apiReachable: boolean
  spaces: CategoryNode[]
  categories: CategoryNode[]
  uncategorized: ChannelNode[]
  gone: ChannelNode[]
  generatedAt: number
}

const THREADS_IN_TREE = 6

async function mtime(file: string) {
  const st = await stat(file).catch(() => null)
  return st ? st.mtimeMs : null
}

/** Last Discord message in a channel's archive (author, text, time), cached per size. */
async function lastMessage(channelDir: string) {
  const file = path.join(channelDir, "discord", "messages.jsonl")
  const st = await stat(file).catch(() => null)
  if (!st) return null
  return cached(`lastmsg:${file}:${st.size}`, 3_600_000, async () => {
    const len = Math.min(st.size, 96 * 1024)
    const fh = await open(file, "r")
    let text = ""
    try {
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, st.size - len)
      text = buf.toString("utf8")
    } finally {
      await fh.close()
    }
    const lines = text.split("\n").reverse()
    for (const line of lines) {
      if (!line.includes('"message_create"')) continue
      try {
        const ev = JSON.parse(line) as { createdAt?: string; cleanContent?: string; content?: string; authorName?: string; authorGlobalName?: string; authorBot?: boolean }
        const body = (ev.cleanContent ?? ev.content ?? "").replace(/\s+/g, " ").trim()
        if (!body) continue
        return { author: ev.authorGlobalName || ev.authorName || "someone", bot: Boolean(ev.authorBot), text: maskSecrets(body.slice(0, 240)), at: ev.createdAt ? Date.parse(ev.createdAt) : st.mtimeMs }
      } catch {
        // skip
      }
    }
    return null
  })
}

export async function buildTree(ctx: Pick<AppContext, "stack" | "bridge" | "directory">): Promise<Tree> {
  return cached("app:tree", 4000, async () => {
    const { bridge, stack, directory } = ctx
    const index = await bridge.refreshSpaceIndex()
    const guilds = await directory.directory()
    const threads = await directory.activeThreads()
    const contextIds = new Set(bridge.knownChannelIds().filter(isSnowflake))
    for (const id of await stack.channelIds()) contextIds.add(id)

    const threadsBy = new Map<string, DiscordThread[]>()
    for (const t of threads) {
      const list = threadsBy.get(t.parentId) ?? []
      list.push(t)
      threadsBy.set(t.parentId, list)
    }

    const node = async (id: string, base: { name: string | null; guildId: string | null; categoryId: string | null; position: number; type: number; topic: string | null; gone: boolean }): Promise<ChannelNode> => {
      const st = bridge.channelState(id)
      const chats = bridge.sessionChats(id)
      const archiveAt = await mtime(path.join(stack.channelDir(id), "discord", "messages.jsonl"))
      const chatAt = chats.reduce((m, c) => Math.max(m, c.lastMessageAt ?? 0), 0)
      const ts = (threadsBy.get(id) ?? []).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      const threadAt = ts[0]?.lastMessageAt ?? 0
      const last = Math.max(archiveAt ?? 0, chatAt, threadAt) || null
      const space = base.categoryId ? index.spaces[base.categoryId] : undefined
      return {
        id,
        name: base.name ?? "unnamed channel",
        guildId: base.guildId,
        categoryId: base.categoryId,
        position: base.position,
        kind: base.type === 15 ? "forum" : base.type === 5 ? "announcement" : "text",
        topic: base.topic,
        remoteHost: bridge.isRemote(id),
        running: st.running,
        queued: st.queued,
        chatId: bridge.currentChat(id),
        lastActivityAt: last,
        hasHistory: contextIds.has(id),
        spaceId: space?.enabled ? base.categoryId : null,
        isMission: Boolean(space?.enabled && space.missionControlChannelId === id),
        threadCount: ts.length,
        threads: ts.slice(0, THREADS_IN_TREE).map((t) => ({ id: t.id, name: t.name, archived: t.archived, lastActivityAt: t.lastMessageAt, messageCount: t.messageCount })),
        gone: base.gone,
      }
    }

    const categories = new Map<string, CategoryNode>()
    const uncategorized: ChannelNode[] = []
    const gone: ChannelNode[] = []
    const seen = new Set<string>()
    let guildName: string | null = null

    if (guilds.length > 0) {
      guildName = guilds.length === 1 ? guilds[0]!.name : null
      for (const g of guilds) {
        for (const c of g.categories) {
          const space = index.spaces[c.id]
          categories.set(c.id, {
            id: c.id,
            name: c.name,
            guildId: g.id,
            position: c.position,
            isSpace: Boolean(space?.enabled),
            spaceEnabled: Boolean(space?.enabled),
            missionControlChannelId: space?.missionControlChannelId ?? null,
            channels: [],
          })
        }
        for (const c of g.channels) {
          seen.add(c.id)
          const n = await node(c.id, { name: c.name, guildId: g.id, categoryId: c.parentId, position: c.position, type: c.type, topic: c.topic ? maskSecrets(c.topic) : null, gone: false })
          const cat = c.parentId ? categories.get(c.parentId) : undefined
          if (cat) cat.channels.push(n)
          else uncategorized.push(n)
        }
      }
    }

    // Channels known only from disk / neo-claw (Discord REST down, or channel deleted).
    for (const id of contextIds) {
      if (seen.has(id)) continue
      const p = bridge.placement(id)
      const name = bridge.channelName(id)
      const knownName = name && name !== id ? name : null
      if (guilds.length > 0) {
        // Discord answered and doesn't list it: deleted, or a thread/DM context.
        if (!knownName) continue
        gone.push(await node(id, { name: knownName, guildId: null, categoryId: null, position: 0, type: 0, topic: null, gone: true }))
        continue
      }
      const n = await node(id, { name: knownName, guildId: null, categoryId: p.categoryId, position: p.position ?? 0, type: 0, topic: null, gone: false })
      if (p.categoryId) {
        let cat = categories.get(p.categoryId)
        if (!cat) {
          const space = index.spaces[p.categoryId]
          cat = {
            id: p.categoryId,
            name: p.categoryName ?? space?.name ?? "Other",
            guildId: space?.guildId ?? null,
            position: p.categoryPosition ?? 999,
            isSpace: Boolean(space?.enabled),
            spaceEnabled: Boolean(space?.enabled),
            missionControlChannelId: space?.missionControlChannelId ?? null,
            channels: [],
          }
          categories.set(p.categoryId, cat)
        }
        cat.channels.push(n)
      } else uncategorized.push(n)
    }

    const byPos = (a: ChannelNode, b: ChannelNode) => Number(b.isMission) - Number(a.isMission) || a.position - b.position || a.name.localeCompare(b.name)
    const cats = [...categories.values()].filter((c) => c.channels.length > 0 || c.isSpace)
    for (const c of cats) c.channels.sort(byPos)
    cats.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    uncategorized.sort(byPos)
    gone.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    return {
      guildName,
      directory: guilds.length > 0 ? "discord" : "cache",
      apiReachable: bridge.isApiReachable(),
      spaces: cats.filter((c) => c.isSpace),
      categories: cats.filter((c) => !c.isSpace),
      uncategorized,
      gone,
      generatedAt: Date.now(),
    }
  })
}

function allChannels(tree: Tree) {
  return [...tree.spaces.flatMap((c) => c.channels), ...tree.categories.flatMap((c) => c.channels), ...tree.uncategorized, ...tree.gone]
}

function findChannel(tree: Tree, id: string) {
  return allChannels(tree).find((c) => c.id === id) ?? null
}

function categoryOf(tree: Tree, id: string | null) {
  if (!id) return null
  return [...tree.spaces, ...tree.categories].find((c) => c.id === id) ?? null
}

// ------------------------------------------------------------------ runs

async function channelRuns(ctx: AppContext, channelId: string, limit = 20) {
  const files = (await listRunFiles(ctx.stack.channelDir(channelId))).slice(0, limit)
  const running = ctx.bridge.channelState(channelId).running
  const summaries = (await Promise.all(files.map((f, i) => runSummary(f.file, running, i === 0)))).filter((s): s is RunSummary => Boolean(s))
  const triggers = await ctx.bridge.runTriggers(channelId, summaries.map((s) => ({ id: s.id, startedAt: s.startedAt })))
  return summaries.map((s) => {
    const t = triggers.get(s.id)
    return { ...s, channelId, trigger: t ? { ...t, text: maskSecrets(t.text.replace(/\s+/g, " ").slice(0, 300)) } : null }
  })
}

/** Newest runs across many channels: newest 3 files per channel by name, then summarised. */
async function recentRuns(ctx: AppContext, channelIds: string[], limit: number) {
  const candidates: { channelId: string; file: string; startedAt: number; newest: boolean }[] = []
  for (const id of channelIds) {
    const files = (await listRunFiles(ctx.stack.channelDir(id))).slice(0, 3)
    files.forEach((f, i) => candidates.push({ channelId: id, file: f.file, startedAt: f.startedAt, newest: i === 0 }))
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt)
  const top = candidates.slice(0, limit)
  const out = []
  const byChannel = new Map<string, { id: string; startedAt: number }[]>()
  const summaries = []
  for (const c of top) {
    const s = await runSummary(c.file, ctx.bridge.channelState(c.channelId).running, c.newest)
    if (!s) continue
    summaries.push({ ...s, channelId: c.channelId })
    const l = byChannel.get(c.channelId) ?? []
    l.push({ id: s.id, startedAt: s.startedAt })
    byChannel.set(c.channelId, l)
  }
  const triggerMaps = new Map<string, Awaited<ReturnType<NeoClawBridge["runTriggers"]>>>()
  for (const [id, runs] of byChannel) {
    // Include the run before the oldest one listed so each trigger window is bounded.
    const all = (await listRunFiles(ctx.stack.channelDir(id))).slice(0, 4).map((f) => ({ id: f.id, startedAt: f.startedAt }))
    triggerMaps.set(id, await ctx.bridge.runTriggers(id, all.length ? all : runs))
  }
  for (const s of summaries) {
    const t = triggerMaps.get(s.channelId)?.get(s.id)
    out.push({ ...s, trigger: t ? { ...t, text: maskSecrets(t.text.replace(/\s+/g, " ").slice(0, 200)) } : null })
  }
  return out
}

// ------------------------------------------------------------------ views

async function contextOf(ctx: AppContext, channelId: string) {
  const live = ctx.bridge.liveContextTokens(channelId)
  if (live != null) return live
  const files = await listRunFiles(ctx.stack.channelDir(channelId))
  if (!files[0]) return null
  const s = await runSummary(files[0].file, false, false)
  return s?.contextTokens ?? null
}

async function card(ctx: AppContext, n: ChannelNode) {
  const files = await listRunFiles(ctx.stack.channelDir(n.id))
  const latest = files[0] ? await runSummary(files[0].file, n.running, true) : null
  return {
    ...n,
    contextTokens: ctx.bridge.liveContextTokens(n.id) ?? latest?.contextTokens ?? null,
    lastMessage: await lastMessage(ctx.stack.channelDir(n.id)),
    latestRun: latest ? { id: latest.id, status: latest.status, startedAt: latest.startedAt, durationMs: latest.durationMs } : null,
    runCount: files.length,
  }
}

async function home(ctx: AppContext) {
  return cached("app:home", 8000, async () => {
    const tree = await buildTree(ctx)
    const chans = allChannels(tree)
    const withRuns = chans.filter((c) => c.hasHistory).map((c) => c.id)
    const runs = await recentRuns(ctx, withRuns, 14)
    const liveIds = new Set(runs.filter((r) => r.status === "running").map((r) => r.channelId))
    const active = chans.filter((c) => c.running || c.queued > 0 || liveIds.has(c.id))
    const ops = await ctx.stack.ops()
    const nodes = await ctx.stack.nodes()
    const attention: { level: "warn" | "info"; text: string; href?: string }[] = []
    for (const s of ops.services) if (s.state !== "active") attention.push({ level: "warn", text: `${s.name} is ${s.state}`, href: "/infra" })
    const memAvail = ops.mem.MemAvailable && ops.mem.MemTotal ? ops.mem.MemAvailable / ops.mem.MemTotal : null
    if (memAvail != null && memAvail < 0.1) attention.push({ level: "warn", text: `Memory is low: ${Math.round(memAvail * 100)}% available`, href: "/infra" })
    if (ops.disk && ops.disk.free / ops.disk.total < 0.1) attention.push({ level: "warn", text: `Disk is ${Math.round((1 - ops.disk.free / ops.disk.total) * 100)}% full`, href: "/infra" })
    if (!ctx.bridge.isApiReachable()) attention.push({ level: "info", text: "neo-claw's web API is down: sending from here, creating channels and space actions wait for the next bot deploy", href: "/infra" })
    for (const r of runs) {
      if (r.status === "error" && Date.now() - r.startedAt < 24 * 3600_000) {
        attention.push({ level: "warn", text: `Run failed in #${findChannel(tree, r.channelId)?.name ?? "a channel"}`, href: `/c/${r.channelId}/runs/${r.id}` })
      }
    }
    if ("nodes" in nodes && Array.isArray(nodes.nodes)) {
      for (const n of nodes.nodes as Record<string, unknown>[]) {
        const state = String(n.state ?? n.status ?? "")
        if (state && state !== "online") attention.push({ level: "info", text: `Node ${String(n.name ?? "?")} is ${state}`, href: "/infra?tab=nodes" })
      }
    }
    const jobs = await ctx.stack.jobs()
    const waiting = jobs.wakes.filter((w) => w.status === "pending" || w.status === "running" || w.status === "waiting").slice(0, 8)
    const deployLine = (ops.deployLog ?? "").trim().split("\n").filter(Boolean).pop() ?? null
    return {
      guildName: tree.guildName,
      apiReachable: ctx.bridge.isApiReachable(),
      active: await Promise.all(active.map((c) => card(ctx, c))),
      runs: runs.map((r) => ({ ...r, channelName: findChannel(tree, r.channelId)?.name ?? null })),
      attention,
      deploy: { queue: ops.queue, last: deployLine ? maskSecrets(deployLine) : null },
      waiting: waiting.map((w) => ({ ...w, channelName: w.channelId ? findChannel(tree, w.channelId)?.name ?? null : null })),
      terminals: jobs.terminals.filter((t) => t.status === "running").length,
      counts: { spaces: tree.spaces.length, channels: chans.filter((c) => !c.gone).length, withHistory: withRuns.length },
      links: ctx.bridge.overviewLinks(),
    }
  })
}

async function spaceView(ctx: AppContext, categoryId: string) {
  const tree = await buildTree(ctx)
  const index = ctx.bridge.getSpaceIndex()
  const s = index.spaces[categoryId]
  const cat = categoryOf(tree, categoryId)
  if (!s && !cat) return null
  const members = cat?.channels ?? []
  const notes = await ctx.stack.spaceNotes(categoryId)
  const history = await ctx.stack.spaceHistory(categoryId)
  const skills = (await ctx.stack.skills()).filter((k) => k.source === "space" && k.spaceId === categoryId).map((k) => ({ id: k.id, name: k.name, description: k.description }))
  const mc = s?.missionControlChannelId ?? null
  const settings = await ctx.stack.settings()
  const memory = mc ? await ctx.stack.memory(mc) : null
  return {
    id: categoryId,
    name: cat?.name ?? s?.name ?? "Space",
    enabled: Boolean(s?.enabled),
    isSpace: Boolean(s),
    createdAt: s?.createdAt ?? null,
    missionControlChannelId: mc,
    folder: ctx.stack.spaceDir(categoryId),
    notes: notes ? { text: maskSecrets(notes.text), hash: notes.hash, exists: notes.exists } : null,
    history,
    skills,
    mcp: await ctx.stack.spaceMcp(categoryId),
    notesLimit: 14_000,
    members: await Promise.all(members.map((m) => card(ctx, m))),
    compactWindow: settings.compact.tokens,
    memory: memory
      ? { channelId: mc, index: memory.index, summary: memory.summary ? memory.summary.slice(0, 6000) : null, files: memory.files, archive: memory.archive }
      : null,
    activity: await recentRuns(ctx, members.filter((m) => m.hasHistory).map((m) => m.id), 20).then((runs) => runs.map((r) => ({ ...r, channelName: findChannel(tree, r.channelId)?.name ?? null }))),
    apiReachable: ctx.bridge.isApiReachable(),
  }
}

async function categoryView(ctx: AppContext, categoryId: string) {
  const tree = await buildTree(ctx)
  const cat = categoryOf(tree, categoryId)
  if (!cat) return null
  const settings = await ctx.stack.settings()
  return {
    ...cat,
    channels: await Promise.all(cat.channels.map((c) => card(ctx, c))),
    compactWindow: settings.compact.tokens,
    spaceOff: Boolean(ctx.bridge.getSpaceIndex().spaces[categoryId] && !cat.isSpace),
  }
}

async function channelView(ctx: AppContext, channelId: string) {
  const tree = await buildTree(ctx)
  const n = findChannel(tree, channelId)
  if (!n) return null
  const settings = await ctx.stack.settings()
  const cat = categoryOf(tree, n.categoryId)
  const archived = n.guildId && !n.gone ? await ctx.directory.archivedThreads(channelId, n.guildId) : []
  const active = (await ctx.directory.activeThreads()).filter((t) => t.parentId === channelId)
  const threads = [...active, ...archived.filter((a) => !active.some((t) => t.id === a.id))]
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    .slice(0, 40)
    .map((t) => ({ id: t.id, name: t.name, archived: t.archived, lastActivityAt: t.lastMessageAt, messageCount: t.messageCount, createdAt: t.createdAt }))
  const skills = await ctx.stack.skills()
  const inEffect = skills.filter((k) => k.source === "global" || k.channels.includes(channelId)).map((k) => ({ id: k.id, name: k.name, description: k.description, source: k.source, spaceName: k.spaceName ?? null }))
  const mcp = (await ctx.stack.mcpServers()).filter((m) => m.scope === "user" || m.channels.includes(channelId)).map((m) => ({ key: m.key, name: m.name, scope: m.scope, type: m.type }))
  return {
    ...n,
    category: cat ? { id: cat.id, name: cat.name, isSpace: cat.isSpace } : null,
    contextTokens: await contextOf(ctx, channelId),
    compactWindow: settings.compact.tokens,
    settings: { ...settings.channelGlobal, ...(settings.channelSettings[channelId] ?? {}) },
    settingsScope: settings.channelSettings[channelId] ? "channel" : "global",
    sessions: ctx.bridge.sessionChats(channelId),
    threads,
    runs: await channelRuns(ctx, channelId),
    skills: inEffect,
    mcp,
    lastMessage: await lastMessage(ctx.stack.channelDir(channelId)),
    discordUrl: n.guildId ? `https://discord.com/channels/${n.guildId}/${channelId}` : null,
    apiReachable: ctx.bridge.isApiReachable(),
  }
}

async function channelMemory(ctx: AppContext, channelId: string) {
  const m = await ctx.stack.memory(channelId)
  const sidecar = await ctx.stack.memorySidecar(channelId)
  return { ...m, memDir: undefined, sidecar }
}

async function memoryFile(ctx: AppContext, channelId: string, file: string) {
  if (!/^[\w.-]{1,120}$/.test(file)) return null
  return readViewable(ctx.stack.memoryDir(channelId), file)
}

async function library(ctx: AppContext) {
  const [settings, mcp] = await Promise.all([ctx.stack.settings(), ctx.stack.mcpServers()])
  const tree = await buildTree(ctx)
  const name = (id: string) => findChannel(tree, id)?.name ?? null
  return {
    skillTree: await ctx.stack.skillTree(),
    remoteSkillHosts: ctx.stack.remoteSkillHosts(),
    hooks: settings.hooks,
    envKeys: settings.envKeys,
    compact: settings.compact,
    permissions: settings.permissions,
    channelGlobal: settings.channelGlobal,
    // `sample` holds the launch env: never sent.
    mcp: mcp.map(({ sample: _s, ...m }) => ({ ...m, channelNames: m.channels.slice(0, 40).map((id) => name(id) ?? "unnamed"), canList: Boolean(_s) })),
  }
}

const SETTINGS_KEYS = ["model", "effort", "maxTurns", "progressCard", "voiceMode", "slashPassthrough", "workflows", "tables"]
const SETTINGS_PENDING = "Editing needs the neo-claw settings API (queued deploy)."

type SettingsMap = Record<string, unknown>

/**
 * Per-chat settings. Live from neo-claw's /api/settings when the bot has it;
 * otherwise read from .settings.json and marked read-only (Kanna never writes
 * that file: the bot holds it in memory and would overwrite it).
 */
async function settingsView(ctx: AppContext) {
  const fallbacks = await ctx.stack.settingsFallbacks()
  const live = await ctx.bridge.apiGetStatus<{ global: SettingsMap; channels: Record<string, SettingsMap>; keys?: string[]; effortLevels?: string[]; tableModes?: string[] }>("/api/settings")
  const base = {
    keys: SETTINGS_KEYS,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    tableModes: ["auto", "image", "text"],
    fallbacks,
  }
  if (live.status === 200 && live.body) {
    return { ...base, ...{ keys: live.body.keys ?? base.keys, effortLevels: live.body.effortLevels ?? base.effortLevels, tableModes: live.body.tableModes ?? base.tableModes }, global: live.body.global ?? {}, channels: live.body.channels ?? {}, editable: true, reason: null }
  }
  const file = await ctx.stack.settingsFile()
  return {
    ...base,
    global: file.global,
    channels: file.channels,
    editable: false,
    reason: live.status === 0 ? "neo-claw's web API isn't reachable right now, so settings are read-only (from .settings.json)." : SETTINGS_PENDING,
  }
}

async function skillView(ctx: AppContext, source: string, id: string, file: string | null) {
  const k = await ctx.stack.skill(source, id)
  if (!k) return null
  const tree = await fileTree(k.dir)
  const rel = file ?? "SKILL.md"
  const doc = await readViewable(k.dir, rel)
  const t = await buildTree(ctx)
  return {
    id: k.id,
    name: k.name,
    description: k.description,
    source: k.source,
    effect: k.effect,
    spaceName: k.spaceName ?? null,
    channelName: k.channelId ? findChannel(t, k.channelId)?.name ?? null : null,
    channels: k.channels.slice(0, 60).map((c) => ({ id: c, name: findChannel(t, c)?.name ?? "unnamed" })),
    files: tree.files,
    truncatedTree: tree.truncated,
    file: rel,
    text: doc?.text ?? null,
    truncated: doc?.truncated ?? false,
  }
}

async function infra(ctx: AppContext) {
  const [ops, nodes, jobs] = await Promise.all([ctx.stack.ops(), ctx.stack.nodes(), ctx.stack.jobs()])
  const tree = await buildTree(ctx)
  const name = (id: string | null) => (id ? findChannel(tree, id)?.name ?? null : null)
  return {
    ops,
    // Always send a list: hosts without a node CLI (or with a failing one) used to blank the page.
    nodes: { configured: nodes.configured, nodes: "nodes" in nodes ? nodes.nodes : [], error: "error" in nodes ? nodes.error : null },
    wakes: jobs.wakes.slice(0, 60).map((w) => ({ ...w, logFile: w.logFile ? path.basename(w.logFile) : null, channelName: name(w.channelId) })),
    terminals: jobs.terminals.map((t) => ({ ...t, channelName: name(t.channelId) })),
    links: ctx.bridge.overviewLinks(),
    apiReachable: ctx.bridge.isApiReachable(),
  }
}

function diffRows(before: string, after: string) {
  const out: { t: "add" | "del" | "same" | "gap"; text: string }[] = []
  for (const p of diffLines(before, after)) {
    const lines = p.value.replace(/\n$/, "").split("\n")
    if (p.added) out.push(...lines.map((text) => ({ t: "add" as const, text })))
    else if (p.removed) out.push(...lines.map((text) => ({ t: "del" as const, text })))
    else if (lines.length > 7) {
      out.push(...lines.slice(0, 3).map((text) => ({ t: "same" as const, text })))
      out.push({ t: "gap", text: `${lines.length - 6} unchanged lines` })
      out.push(...lines.slice(-3).map((text) => ({ t: "same" as const, text })))
    } else out.push(...lines.map((text) => ({ t: "same" as const, text })))
  }
  return out.map((r) => ({ ...r, text: maskSecrets(r.text) }))
}

// ------------------------------------------------------------------ router

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
const err = (status: number, message: string, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status)

async function body(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? 0)
  if (len > 1024 * 1024) throw new Error("request too large")
  const text = await req.text()
  if (text.length > 1024 * 1024) throw new Error("request too large")
  try {
    const v = JSON.parse(text || "{}")
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "")

export async function handleAppApi(req: Request, url: URL, ctx: AppContext): Promise<Response | null> {
  const p = url.pathname.replace(/^\/api\/nc/, "") || "/"
  const parts = p.split("/").filter(Boolean)
  const method = req.method.toUpperCase()

  if (method === "POST" || method === "PUT" || method === "DELETE") {
    // Same-origin only: Origin must be present and match (cookie is SameSite too).
    if (!req.headers.get("origin") || !ctx.validateOrigin(req)) return err(403, "cross-origin request refused")
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return err(415, "JSON only")
  } else if (method !== "GET" && method !== "HEAD") {
    return err(405, "method not allowed")
  }

  try {
    if (method === "GET") {
      if (p === "/tree") return json(await buildTree(ctx))
      if (p === "/home") return json(await home(ctx))
      if (p === "/library") return json(await library(ctx))
      if (p === "/infra") return json(await infra(ctx))
      if (p === "/settings") return json(await settingsView(ctx))
      if (p === "/skill") {
        const v = await skillView(ctx, str(url.searchParams.get("source"), 20), str(url.searchParams.get("id"), 400), url.searchParams.get("file"))
        return v ? json(v) : err(404, "no such skill")
      }
      if (parts[0] === "space" && parts[1] && isSnowflake(parts[1])) {
        if (parts[2] === "history" && parts[3]) {
          const name = parts[3]
          if (!/^SPACE\.md\.[\w.-]+$/.test(name)) return err(400, "bad version")
          const hist = await ctx.stack.spaceHistory(parts[1])
          if (!hist.includes(name)) return err(404, "no such version")
          const before = await readViewable(path.join(ctx.stack.spaceDir(parts[1]), ".history"), name)
          const now = await ctx.stack.spaceNotes(parts[1])
          return json({ version: name, rows: diffRows(before?.text ?? "", now?.text ?? "") })
        }
        const v = await spaceView(ctx, parts[1])
        return v ? json(v) : err(404, "no such space")
      }
      if (parts[0] === "category" && parts[1] && isSnowflake(parts[1])) {
        const v = await categoryView(ctx, parts[1])
        return v ? json(v) : err(404, "no such category")
      }
      if (parts[0] === "channel" && parts[1] && isSnowflake(parts[1])) {
        const id = parts[1]
        if (parts[2] === "memory") {
          if (parts[3]) {
            const f = await memoryFile(ctx, id, decodeURIComponent(parts[3]))
            return f ? json({ text: f.text, truncated: f.truncated }) : err(404, "no such file")
          }
          return json(await channelMemory(ctx, id))
        }
        if (parts[2] === "runs" && parts[3]) {
          if (!isRunId(parts[3])) return err(400, "bad run id")
          const file = path.join(ctx.stack.channelDir(id), ".neo-claw", "runs", `${parts[3]}.jsonl`)
          const newest = (await listRunFiles(ctx.stack.channelDir(id)))[0]?.id === parts[3]
          const d = await runDetail(file, ctx.bridge.channelState(id).running, newest)
          if (!d) return err(404, "no such run (neo-claw keeps the newest 20 per channel)")
          const trig = (await ctx.bridge.runTriggers(id, (await listRunFiles(ctx.stack.channelDir(id))).map((f) => ({ id: f.id, startedAt: f.startedAt })))).get(d.id) ?? null
          const tree = await buildTree(ctx)
          return json({ ...d, channelId: id, channelName: findChannel(tree, id)?.name ?? null, trigger: trig ? { ...trig, text: maskSecrets(trig.text) } : null })
        }
        const v = await channelView(ctx, id)
        return v ? json(v) : err(404, "no such channel")
      }
      if (p === "/chat-channel") {
        const chatId = str(url.searchParams.get("chatId"), 100)
        return json({ channelId: ctx.bridge.channelForChat(chatId) })
      }
      if (p === "/search") {
        const q = str(url.searchParams.get("q"), 300).trim()
        if (!q) return err(400, "empty query")
        const space = url.searchParams.get("space")
        let from: string | null = str(url.searchParams.get("from"), 30) || null
        let scope: "space" | "all" = url.searchParams.get("scope") === "space" ? "space" : "all"
        if (space && isSnowflake(space)) {
          from = ctx.bridge.getSpaceIndex().spaces[space]?.missionControlChannelId ?? null
          if (!from) return err(400, "this space has no mission control chat to search from")
          scope = "space"
        }
        if (from && !isSnowflake(from)) return err(400, "bad channel")
        return json(await ctx.stack.search(q, { fromChannelId: from, scope, maxResults: 20 }))
      }
      if (parts[0] === "job" && parts[1] && parts[2] === "log") {
        if (!/^[\w-]{1,80}$/.test(parts[1])) return err(400, "bad id")
        const l = await ctx.stack.jobLog(parts[1])
        return l ? json(l) : err(404, "no log")
      }
      if (parts[0] === "node" && parts[1] && parts[2] === "jobs") {
        const j = await ctx.stack.nodeJobs(parts[1])
        return j == null ? err(400, "bad node") : json({ text: j })
      }
      if (p === "/usage") {
        const refresh = url.searchParams.get("refresh") === "1"
        const u = await ctx.bridge.apiGet<unknown>(`/api/usage${refresh ? "?refresh=1" : ""}`, 170_000)
        return u ? json(u) : err(503, "usage comes from neo-claw's web API, which isn't reachable right now")
      }
      return err(404, "not found")
    }

    // ---------------------------------------------------------------- writes
    const b = await body(req)
    const mirror = b.mirror !== false
    if (p === "/turn") {
      const channelId = str(b.channelId, 30)
      const threadId = str(b.threadId, 30) || undefined
      const text = str(b.text, 20_000).trim()
      if (!isSnowflake(channelId) || (threadId && !isSnowflake(threadId))) return err(400, "bad channel")
      if (!text) return err(400, "empty message")
      const r = await ctx.bridge.sendTurn({ channelId, threadId, text, user: ctx.user, mirror, steer: b.steer === true })
      forget("app:")
      return json({ ok: true, chatId: r.chatId, steered: r.steered })
    }
    if (p === "/stop") {
      const channelId = str(b.channelId, 30)
      if (!isSnowflake(channelId)) return err(400, "bad channel")
      await ctx.bridge.stopTurn(channelId)
      return json({ ok: true })
    }
    if (p === "/channel") {
      const categoryId = str(b.categoryId, 30)
      const name = str(b.name, 100).trim()
      const topic = str(b.topic, 1000).trim()
      if (!isSnowflake(categoryId)) return err(400, "pick a category")
      if (!name) return err(400, "name the channel")
      try {
        const r = await ctx.bridge.apiPost("/api/channel/create", { categoryId, name, topic: topic || undefined, discordUserId: ctx.user.discordId, displayName: ctx.user.displayName })
        ctx.directory.invalidate()
        forget("app:")
        await ctx.bridge.afterDiscordChange()
        return json(r)
      } catch (e) {
        const status = (e as { status?: number }).status ?? 502
        return err(status === 403 ? 403 : status >= 400 && status < 500 ? status : 502, e instanceof Error ? e.message : String(e))
      }
    }
    if (p === "/thread") {
      const channelId = str(b.channelId, 30)
      const name = str(b.name, 100).trim()
      const text = str(b.text, 20_000).trim()
      if (!isSnowflake(channelId)) return err(400, "bad channel")
      if (!name && !text) return err(400, "give the conversation a name or a first message")
      try {
        const r = (await ctx.bridge.apiPost("/api/thread/create", { channelId, name: name || text.slice(0, 90), discordUserId: ctx.user.discordId, displayName: ctx.user.displayName })) as { threadId?: string }
        ctx.directory.invalidate()
        forget("app:")
        let chatId: string | null = null
        if (text && r.threadId) chatId = (await ctx.bridge.sendTurn({ channelId, threadId: r.threadId, text, user: ctx.user, mirror: true, steer: false })).chatId
        return json({ ...r, chatId })
      } catch (e) {
        const status = (e as { status?: number }).status ?? 502
        return err(status >= 400 && status < 500 ? status : 502, e instanceof Error ? e.message : String(e))
      }
    }
    if (parts[0] === "space" && parts[1] && isSnowflake(parts[1])) {
      const categoryId = parts[1]
      if (parts[2] === "notes") {
        const r = await ctx.stack.saveSpaceNotes(categoryId, str(b.text, 600 * 1024), str(b.baseHash, 64), ctx.user.username)
        forget("app:")
        if (!r.ok) return json({ ok: false, conflict: true, current: { text: r.current.text, hash: r.current.hash } }, 409)
        const now = await ctx.stack.spaceNotes(categoryId)
        return json({ ok: true, changed: r.changed, backup: r.backup ? path.basename(r.backup) : null, hash: now?.hash ?? null, rows: r.changed ? diffRows(r.before, now?.text ?? "") : [] })
      }
      if (parts[2] === "config") {
        const mc = str(b.missionControlChannelId, 30)
        if (!mc) return err(400, "nothing to change")
        try {
          const r = await ctx.stack.saveSpaceConfig(categoryId, { missionControlChannelId: mc }, `${ctx.user.username} (${ctx.user.discordId})`)
          forget("app:")
          return json(r)
        } catch (e) {
          return err(400, e instanceof Error ? e.message : String(e))
        }
      }
      if (parts[2] === "action") {
        const action = str(b.action, 20)
        if (action === "backfill") {
          const mc = ctx.bridge.getSpaceIndex().spaces[categoryId]?.missionControlChannelId
          if (!mc) return err(400, "this space has no mission control chat")
          await ctx.bridge.startBackfill(categoryId, mc, ctx.user, mirror)
          forget("app:")
          return json({ ok: true, chatId: ctx.bridge.currentChat(mc), channelId: mc })
        }
        if (action === "init" || action === "off") {
          const payload: Record<string, unknown> = { categoryId }
          if (action === "init") {
            const mode = str(b.mode, 20)
            const ch = str(b.channelId, 30)
            // neo-claw expects "this-channel" (mission control = that channel) or "create".
            if ((mode === "this" || mode === "this-channel") && isSnowflake(ch)) {
              payload.channelId = ch
              payload.mode = "this-channel"
            } else payload.mode = "create"
          }
          const r = await ctx.bridge.spaceAction(action, payload, ctx.user, mirror)
          forget("app:")
          return json({ ok: true, result: r })
        }
        return err(400, "unknown action")
      }
    }
    if (p === "/settings" || p === "/settings/reset") {
      const scope = b.scope === "channel" ? "channel" : b.scope === "global" ? "global" : null
      const channelId = str(b.channelId, 30)
      if (!scope) return err(400, "scope must be global or channel")
      if (scope === "channel" && !isSnowflake(channelId)) return err(400, "bad channel")
      const payload: Record<string, unknown> = { scope, discordUserId: ctx.user.discordId, displayName: ctx.user.displayName }
      if (scope === "channel") payload.channelId = channelId
      if (p === "/settings") {
        const key = str(b.key, 40)
        if (!SETTINGS_KEYS.includes(key)) return err(400, "unknown setting")
        payload.key = key
        payload.value = b.value === undefined ? null : b.value
      }
      try {
        const r = await ctx.bridge.apiPost(p === "/settings" ? "/api/settings" : "/api/settings/reset", payload, 15_000)
        forget("app:")
        forget("settings")
        console.log(`[neoclaw] settings ${p === "/settings" ? `${String(payload.key)}=${JSON.stringify(payload.value)}` : "reset"} (${scope}${scope === "channel" ? ` ${channelId}` : ""}) by ${ctx.user.username}`)
        return json(r)
      } catch (e) {
        const status = (e as { status?: number }).status
        if (status === 404) return err(503, SETTINGS_PENDING)
        return err(status && status >= 400 && status < 500 ? status : 502, e instanceof Error ? e.message : String(e))
      }
    }
    if (parts[0] === "mcp" && parts[1] && parts[2] === "tools") {
      if (!/^[0-9a-f]{12}$/.test(parts[1])) return err(400, "bad key")
      return json(await ctx.stack.mcpTools(parts[1]))
    }
    return err(404, "not found")
  } catch (e) {
    return err(500, maskSecrets(e instanceof Error ? e.message : String(e)))
  }
}

export { snowflakeTime }
