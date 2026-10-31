import { diffLines } from "diff"
import { Marked } from "marked"
import path from "node:path"
import type { NeoClawBridge, NeoClawOverview } from "./bridge"
import type { SessionUser } from "./auth"
import { fileTree, isSnowflake, maskSecrets, readViewable, type SkillEntry, type Stack } from "./stack"

/**
 * The neo-claw console: plain server-rendered pages (no scripts) for spaces,
 * skills, memory, hooks and settings, MCP servers, jobs, nodes, ops and search.
 * All of it sits behind the login gate in server.ts; POSTs also check Origin.
 */

export interface ConsoleContext {
  stack: Stack
  bridge: NeoClawBridge
  user: SessionUser
  /** Same-origin check for POSTs (the session cookie is SameSite=Strict too). */
  validateOrigin: (req: Request) => boolean
}

// ------------------------------------------------------------------ rendering helpers

export function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function ago(at: number | string | null | undefined) {
  if (at == null || at === "") return "–"
  const ms = typeof at === "number" ? at : Date.parse(at)
  if (!Number.isFinite(ms)) return "–"
  const s = Math.round((Date.now() - ms) / 1000)
  const a = Math.abs(s)
  const v = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : a < 129600 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`
  return s >= 0 ? `${v} ago` : `in ${v}`
}

function bytes(n: number | null | undefined) {
  if (n == null) return "–"
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

const markdown = new Marked({ gfm: true, async: false })
markdown.use({
  renderer: {
    // Raw HTML in notes is shown as text, never rendered.
    html(token) {
      // Comments are authoring hints in SPACE.md templates: hide them; show any other HTML as text.
      const t = token.text.replace(/<!--[\s\S]*?-->/g, "")
      return t.trim() ? esc(t) : ""
    },
  },
  walkTokens(token) {
    if (token.type === "link" || token.type === "image") {
      const href = String(token.href ?? "").trim()
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase()
      if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "mailto") token.href = "#"
    }
  },
})

export function renderMarkdown(text: string) {
  return `<div class="md">${markdown.parse(text) as string}</div>`
}

function renderDiff(before: string, after: string) {
  const parts = diffLines(before, after)
  if (parts.every((p) => !p.added && !p.removed)) return `<p class="dim">No changes.</p>`
  const out: string[] = []
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, "").split("\n")
    if (p.added) out.push(...lines.map((l) => `<span class="add">+ ${esc(l)}</span>`))
    else if (p.removed) out.push(...lines.map((l) => `<span class="del">- ${esc(l)}</span>`))
    else if (lines.length > 7) {
      out.push(...lines.slice(0, 3).map((l) => `  ${esc(l)}`))
      out.push(`<span class="dim">  … ${lines.length - 6} unchanged lines …</span>`)
      out.push(...lines.slice(-3).map((l) => `  ${esc(l)}`))
    } else out.push(...lines.map((l) => `  ${esc(l)}`))
  }
  return `<pre class="diff">${out.join("\n")}</pre>`
}

const NAV: [string, string][] = [
  ["/neoclaw", "Overview"],
  ["/neoclaw/spaces", "Spaces"],
  ["/neoclaw/skills", "Skills"],
  ["/neoclaw/memory", "Memory"],
  ["/neoclaw/settings", "Hooks & settings"],
  ["/neoclaw/mcp", "MCP"],
  ["/neoclaw/jobs", "Jobs"],
  ["/neoclaw/nodes", "Nodes"],
  ["/neoclaw/ops", "Ops"],
  ["/neoclaw/search", "Search"],
]

const STYLE = `
body{margin:0;background:#0b0b0c;color:#e8e8ea;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{padding:18px 24px 48px;max-width:1150px}
nav{display:flex;flex-wrap:wrap;gap:4px 14px;padding:10px 24px;border-bottom:1px solid #222;background:#111114;position:sticky;top:0}
nav a{color:#b9b9c2;text-decoration:none}nav a.on{color:#fff;font-weight:600}nav .me{margin-left:auto;color:#77777f}
a{color:#8ab4ff}h1{font-size:19px;margin:6px 0 12px}h2{font-size:15px;margin:26px 0 8px}h3{font-size:14px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%}td,th{padding:5px 9px;border-bottom:1px solid #222;text-align:left;vertical-align:top}
th{color:#9a9aa2;font-weight:500}tr.run td{background:#11241a}.dim{color:#8a8a92}.warn{color:#ffb35c}.err{color:#ff7b7b}.ok{color:#7bd88f}
code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d6d6dc}pre{background:#141418;border:1px solid #242428;padding:10px;overflow:auto;max-height:640px;white-space:pre-wrap;word-break:break-word}
.md{background:#121215;border:1px solid #232327;padding:4px 16px;border-radius:6px}.md pre{max-height:none}.md table{width:auto}
.tag{display:inline-block;padding:0 6px;border-radius:4px;background:#232330;color:#c2c2ff;font-size:12px;margin-right:4px}
.space{background:#2a2140;color:#d9c2ff}.mc{background:#3a2d10;color:#ffd27a}
.card{border:1px solid #242428;border-radius:6px;padding:10px 14px;margin:10px 0;background:#101013}
textarea{width:100%;min-height:380px;background:#0f0f12;color:#e8e8ea;border:1px solid #333;font:13px/1.45 ui-monospace,monospace;padding:8px;box-sizing:border-box}
input[type=text],input[type=search],select{background:#0f0f12;color:#e8e8ea;border:1px solid #333;padding:5px 8px;border-radius:4px}
button{background:#2b4a8a;color:#fff;border:0;padding:6px 12px;border-radius:4px;cursor:pointer}button.danger{background:#7a2b2b}button.quiet{background:#2a2a30}
form.inline{display:inline}details>summary{cursor:pointer;color:#b9b9c2}
.diff .add{color:#7bd88f}.diff .del{color:#ff7b7b}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 16px;margin:0}dt{color:#9a9aa2}dd{margin:0}
`

function page(title: string, ctx: Pick<ConsoleContext, "user"> | null, active: string, body: string, opts: { status?: number; refresh?: number } = {}) {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="on"' : ""}>${esc(label)}</a>`).join("")
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · neo-claw</title>${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ""}<style>${STYLE}</style></head><body>
<nav><a href="/">← console</a>${nav}<span class="me">${ctx ? esc(ctx.user.displayName) : ""}</span></nav>
<main>${body}</main></body></html>`
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "same-origin",
    },
  })
}

function notFound(ctx: ConsoleContext, what = "Not found") {
  return page(what, ctx, "", `<h1>${esc(what)}</h1>`, { status: 404 })
}

function redirect(to: string) {
  return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } })
}

function chanLink(ctx: ConsoleContext, channelId: string) {
  const s = ctx.bridge.channelSummary(channelId)
  const name = `#${esc(s.name)}`
  if (s.chatId) return `<a href="/chat/${esc(s.chatId)}">${name}</a>`
  if (s.projectId) return `<a href="/project/${esc(s.projectId)}">${name}</a>`
  return name
}

function stateOf(s: { running: boolean; queued: number }) {
  return s.running ? `<span class="ok">running</span>` : s.queued > 0 ? `queued (${s.queued})` : `<span class="dim">idle</span>`
}

/** Limit concurrent child processes started from the console (search, MCP tool listings). */
let spawning = 0
async function withSpawnSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (spawning >= 2) return null
  spawning++
  try {
    return await fn()
  } finally {
    spawning--
  }
}

// ------------------------------------------------------------------ router

export async function handleConsole(req: Request, url: URL, ctx: ConsoleContext): Promise<Response | null> {
  const p = url.pathname.replace(/\/+$/, "") || "/"
  if (!p.startsWith("/neoclaw")) return null
  // Browsers always send Origin on a form POST; require it and require it to be ours.
  if (req.method === "POST" && (!req.headers.get("origin") || !ctx.validateOrigin(req))) return new Response("Forbidden", { status: 403 })
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return new Response(null, { status: 405 })
  const parts = p.split("/").slice(2) // after /neoclaw
  try {
    await ctx.bridge.refreshSpaceIndex()
    if (parts.length === 0) return req.method === "GET" ? overviewPage(ctx, await ctx.bridge.overview()) : null
    switch (parts[0]) {
      case "spaces":
        if (parts.length === 1) return await spacesPage(ctx)
        if (!isSnowflake(parts[1]!)) return notFound(ctx)
        if (parts.length === 2) return await spacePage(ctx, parts[1]!)
        if (parts[2] === "notes" && req.method === "POST") return await saveNotes(req, ctx, parts[1]!)
        if (parts[2] === "action" && req.method === "POST") return await spaceAction(req, ctx, parts[1]!)
        if (parts[2] === "history" && parts[3]) return await historyPage(ctx, parts[1]!, parts[3])
        return notFound(ctx)
      case "skills":
        if (parts.length === 1) return await skillsPage(ctx)
        if (parts[1] === "view") return await skillPage(ctx, url)
        return notFound(ctx)
      case "memory":
        if (parts.length === 1) return memoryIndex(ctx)
        if (isSnowflake(parts[1]!)) return await memoryPage(ctx, parts[1]!, url.searchParams.get("file"))
        return notFound(ctx)
      case "settings":
        return await settingsPage(ctx)
      case "mcp":
        return await mcpPage(ctx, req.method === "POST" ? String((await req.formData()).get("key") ?? "") : null)
      case "jobs":
        return await jobsPage(ctx, url.searchParams.get("log"))
      case "nodes":
        return await nodesPage(ctx, url.searchParams.get("jobs"))
      case "ops":
        return await opsPage(ctx, url.searchParams.get("usage"))
      case "search":
        return await searchPage(ctx, url)
      default:
        return notFound(ctx)
    }
  } catch (error) {
    const msg = maskSecrets(error instanceof Error ? error.message : String(error))
    return page("Error", ctx, "", `<h1>Something went wrong</h1><pre>${esc(msg)}</pre>`, { status: 500 })
  }
}

// ------------------------------------------------------------------ overview

function overviewPage(ctx: ConsoleContext, o: NeoClawOverview) {
  const rows = o.channels
    .map((c) => {
      const state = stateOf(c)
      const ctxTok = c.contextTokens != null ? `${Math.round(c.contextTokens / 1000)}k` : "–"
      return `<tr class="${c.running ? "run" : ""}"><td>${c.projectId ? `<a href="/project/${esc(c.projectId)}">${esc(c.name)}</a>` : esc(c.name)}</td><td>${state}</td><td>${esc(c.remoteHost ?? "local")}</td><td>${esc(ctxTok)}</td><td>${esc(c.lastCompactAt ? ago(c.lastCompactAt) : "–")}</td><td><code>${esc((c.sessionId ?? "").slice(0, 8))}</code></td></tr>`
    })
    .join("")
  const links = o.links.length ? `<p>${o.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(" · ")}</p>` : ""
  return page(
    "Overview",
    ctx,
    "/neoclaw",
    `<h1>neo-claw overview</h1>
<p>neo-claw API: ${o.apiReachable ? `<span class="ok">reachable</span>` : `<b class="warn">not reachable</b> <span class="dim">(statuses are guessed from file activity; web turns and space actions are off)</span>`}</p>
${links}
<h2>Channels</h2>
<table><tr><th>Channel</th><th>State</th><th>Runs on</th><th>Context (last seen)</th><th>Last compaction</th><th>Session</th></tr>${rows}</table>
<p class="dim">Context and compaction are known for sessions opened in the console since it started. Refreshes every 15s.</p>`,
    { refresh: 15 },
  )
}

// ------------------------------------------------------------------ spaces

interface SpaceView {
  id: string
  name: string
  guildId: string | null
  enabled: boolean
  createdAt: string | null
  missionControlChannelId: string | null
  members: { id: string; name: string; lastSeenAt: string | null }[]
}

function categories(ctx: ConsoleContext) {
  const cats = new Map<string, { id: string; name: string | null; position: number | null; channels: string[] }>()
  for (const id of ctx.bridge.knownChannelIds()) {
    const pl = ctx.bridge.placement(id)
    if (!pl.categoryId) continue
    const c = cats.get(pl.categoryId) ?? { id: pl.categoryId, name: pl.categoryName, position: pl.categoryPosition, channels: [] }
    c.channels.push(id)
    cats.set(pl.categoryId, c)
  }
  return cats
}

function spaceView(ctx: ConsoleContext, categoryId: string): SpaceView | null {
  const index = ctx.bridge.getSpaceIndex()
  const sp = index.spaces[categoryId]
  if (!sp) return null
  const members = new Map<string, { id: string; name: string; lastSeenAt: string | null }>()
  for (const [id, c] of Object.entries(index.channels)) {
    if (c.categoryId === categoryId) members.set(id, { id, name: ctx.bridge.channelName(id), lastSeenAt: c.lastSeenAt ?? null })
  }
  for (const id of categories(ctx).get(categoryId)?.channels ?? []) {
    if (!members.has(id)) members.set(id, { id, name: ctx.bridge.channelName(id), lastSeenAt: null })
  }
  const mc = sp.missionControlChannelId ?? null
  const list = [...members.values()].sort((a, b) => Number(b.id === mc) - Number(a.id === mc) || a.name.localeCompare(b.name))
  return { id: categoryId, name: sp.name, guildId: sp.guildId ?? null, enabled: Boolean(sp.enabled), createdAt: sp.createdAt ?? null, missionControlChannelId: mc, members: list }
}

async function spacesPage(ctx: ConsoleContext) {
  const index = ctx.bridge.getSpaceIndex()
  const cats = categories(ctx)
  const spaces = Object.keys(index.spaces)
    .map((id) => spaceView(ctx, id)!)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  const rows = spaces
    .map((s) => {
      const running = s.members.filter((m) => ctx.bridge.channelSummary(m.id).running).length
      return `<tr><td><a href="/neoclaw/spaces/${esc(s.id)}">◆ ${esc(s.name)}</a></td><td>${s.enabled ? `<span class="ok">on</span>` : `<span class="dim">off</span>`}</td><td>${s.missionControlChannelId ? `★ ${chanLink(ctx, s.missionControlChannelId)}` : `<span class="dim">none</span>`}</td><td>${s.members.length}${running ? ` <span class="ok">(${running} running)</span>` : ""}</td><td>${esc(ago(s.createdAt))}</td></tr>`
    })
    .join("")
  const others = [...cats.values()]
    .filter((c) => !index.spaces[c.id])
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
    .map((c) => `<tr><td><a href="/neoclaw/spaces/${esc(c.id)}">${esc(c.name ?? `category …${c.id.slice(-4)}`)}</a></td><td>${c.channels.length}</td><td class="dim">${c.channels.slice(0, 6).map((id) => `#${esc(ctx.bridge.channelName(id))}`).join(", ")}${c.channels.length > 6 ? " …" : ""}</td></tr>`)
    .join("")
  return page(
    "Spaces",
    ctx,
    "/neoclaw/spaces",
    `<h1>Spaces</h1>
<p class="dim">A space is a Discord category whose chats share notes (SPACE.md), a skill library and space-scoped search, coordinated from a mission-control chat. Same as <code>/space</code> in Discord.</p>
<table><tr><th>Space</th><th>State</th><th>Mission control</th><th>Member chats</th><th>Created</th></tr>${rows || `<tr><td colspan="5" class="dim">No spaces yet.</td></tr>`}</table>
<h2>Other categories</h2>
<p class="dim">Open one to turn it into a space.</p>
<table><tr><th>Category</th><th>Chats seen</th><th></th></tr>${others || `<tr><td colspan="3" class="dim">None known yet (category names come from the neo-claw API).</td></tr>`}</table>`,
  )
}

async function spacePage(ctx: ConsoleContext, categoryId: string, flash = "") {
  const s = spaceView(ctx, categoryId)
  const mirror = ctx.bridge.mirrorDefault
  const api = ctx.bridge.isApiReachable()
  const apiNote = api ? "" : `<p class="warn">The neo-claw web API isn't reachable right now, so actions will fail until the bot runs a build with it.</p>`
  if (!s) {
    const cat = categories(ctx).get(categoryId)
    if (!cat) return notFound(ctx, "Unknown space or category")
    const options = cat.channels.map((id) => `<option value="${esc(id)}">#${esc(ctx.bridge.channelName(id))}</option>`).join("")
    return page(
      cat.name ?? "Category",
      ctx,
      "/neoclaw/spaces",
      `${flash}<h1>${esc(cat.name ?? categoryId)} <span class="dim">(not a space)</span></h1>
<p>Chats in this category: ${cat.channels.map((id) => chanLink(ctx, id)).join(", ")}</p>
<h2>Make it a space</h2>${apiNote}
<form method="post" action="/neoclaw/spaces/${esc(categoryId)}/action" class="card">
<input type="hidden" name="action" value="init">
<p><label><input type="radio" name="mode" value="create" checked> Create a <code>#space-chat</code> channel as mission control</label> <span class="dim">(the bot needs Manage Channels)</span><br>
<label><input type="radio" name="mode" value="this-channel"> Use an existing chat as mission control:</label> <select name="channelId">${options}</select></p>
<p><label><input type="checkbox" name="mirror" value="1"${mirror ? " checked" : ""}> Post the result to Discord</label></p>
<button>Init space</button></form>`,
    )
  }
  const notes = await ctx.stack.spaceNotes(categoryId)
  const history = await ctx.stack.spaceHistory(categoryId)
  const skills = (await ctx.stack.skills()).filter((k) => k.source === "space" && k.spaceId === categoryId)
  const settings = await ctx.stack.settings()
  const windowK = Math.round(settings.compact.tokens / 1000)
  const members = s.members
    .map((m) => {
      const sum = ctx.bridge.channelSummary(m.id)
      const isMc = m.id === s.missionControlChannelId
      return `<tr class="${sum.running ? "run" : ""}"><td>${isMc ? `<span class="tag mc">★ mission control</span>` : ""}${chanLink(ctx, m.id)}</td><td>${stateOf(sum)}</td><td>${sum.contextTokens != null ? `${Math.round(sum.contextTokens / 1000)}k / ${windowK}k` : "–"}</td><td>${esc(sum.remoteHost ?? "local")}</td><td>${esc(ago(m.lastSeenAt))}</td><td><a href="/neoclaw/memory/${esc(m.id)}">memory</a></td></tr>`
    })
    .join("")
  const skillRows = skills.map((k) => `<li><a href="/neoclaw/skills/view?source=space&id=${encodeURIComponent(k.id)}">${esc(k.name)}</a> <span class="dim">${esc(k.description.slice(0, 160))}</span></li>`).join("")
  const histRows = history.map((h) => `<li><a href="/neoclaw/spaces/${esc(categoryId)}/history/${encodeURIComponent(h)}">${esc(h.replace(/^SPACE\.md\./, ""))}</a></li>`).join("")
  const mc = s.missionControlChannelId
  const actions = `${apiNote}
<div class="card"><form method="post" action="/neoclaw/spaces/${esc(categoryId)}/action" class="inline">
<input type="hidden" name="action" value="backfill">
<button${mc && s.enabled ? "" : " disabled"}>Backfill</button> <span class="dim">Mission control reads every member chat's history and writes SPACE.md. A long turn: it streams in the mission-control chat.</span>
<label><input type="checkbox" name="mirror" value="1"${mirror ? " checked" : ""}> mirror to Discord</label></form></div>
${s.enabled
    ? `<div class="card"><form method="post" action="/neoclaw/spaces/${esc(categoryId)}/action" class="inline"><input type="hidden" name="action" value="off">
<button class="danger">Turn space off</button> <span class="dim">Keeps the notes and skills; chats stop sharing them.</span> <label><input type="checkbox" name="mirror" value="1"${mirror ? " checked" : ""}> post to Discord</label></form></div>`
    : `<div class="card"><form method="post" action="/neoclaw/spaces/${esc(categoryId)}/action" class="inline"><input type="hidden" name="action" value="init"><input type="hidden" name="mode" value="create">
<button>Turn space back on</button> <label><input type="checkbox" name="mirror" value="1"${mirror ? " checked" : ""}> post to Discord</label></form></div>`}`
  const body = `${flash}<h1>◆ ${esc(s.name)} ${s.enabled ? `<span class="tag space">space</span>` : `<span class="tag">off</span>`}</h1>
<h2>Info</h2>
<dl><dt>Category</dt><dd><code>${esc(s.id)}</code></dd><dt>Server</dt><dd><code>${esc(s.guildId ?? "–")}</code></dd>
<dt>State</dt><dd>${s.enabled ? "on" : "off"}</dd><dt>Created</dt><dd>${esc(s.createdAt ?? "–")} (${esc(ago(s.createdAt))})</dd>
<dt>Mission control</dt><dd>${mc ? chanLink(ctx, mc) : `<span class="dim">none</span>`}</dd>
<dt>Member chats</dt><dd>${s.members.length}</dd><dt>Shared skills</dt><dd>${skills.length}</dd>
<dt>SPACE.md</dt><dd>${notes?.exists ? bytes(Buffer.byteLength(notes.text)) : `<span class="dim">not written yet</span>`}</dd>
<dt>Folder</dt><dd><code>${esc(ctx.stack.spaceDir(categoryId))}</code></dd></dl>
<h2>Actions</h2>${actions}
<h2>Search this space</h2>
<form method="get" action="/neoclaw/search"><input type="hidden" name="space" value="${esc(categoryId)}"><input type="search" name="q" size="50" placeholder="search_channels query (FTS5)"> <button>Search</button></form>
<h2>Member chats</h2>
<table><tr><th>Chat</th><th>State</th><th>Context</th><th>Runs on</th><th>Last seen in space</th><th></th></tr>${members}</table>
<h2>Shared skills</h2>${skillRows ? `<ul>${skillRows}</ul>` : `<p class="dim">None. Chats add them under <code>.spaces/${esc(categoryId)}/skills/</code>.</p>`}
<h2>SPACE.md</h2>
${notes?.text.trim() ? renderMarkdown(notes.text) : `<p class="dim">Empty. Run a backfill or write it below.</p>`}
<details${notes?.text.trim() ? "" : " open"}><summary>Edit SPACE.md</summary>
<form method="post" action="/neoclaw/spaces/${esc(categoryId)}/notes">
<input type="hidden" name="base" value="${esc(notes?.hash ?? "")}">
<textarea name="text" spellcheck="false">${esc(notes?.text ?? "")}</textarea>
<p><button>Save</button> <span class="dim">Saved atomically; the previous version is kept under <code>.history/</code>. Every member chat reads it on its next turn.</span></p></form></details>
${histRows ? `<h3>Earlier versions</h3><ul>${histRows}</ul>` : ""}`
  return page(s.name, ctx, "/neoclaw/spaces", body)
}

async function saveNotes(req: Request, ctx: ConsoleContext, categoryId: string) {
  if (!spaceView(ctx, categoryId)) return notFound(ctx, "Not a space")
  const form = await req.formData()
  const text = String(form.get("text") ?? "")
  const base = String(form.get("base") ?? "")
  const r = await ctx.stack.saveSpaceNotes(categoryId, text, base, ctx.user.username)
  if (!r.ok) {
    const flash = `<div class="card err"><b>Not saved:</b> SPACE.md changed since you opened it (a chat or another editor wrote it). Your text is below the current version's diff; copy it, then edit again.</div>
<h3>What changed since you loaded it vs. your text</h3>${renderDiff(r.current.text, text.replace(/\r\n/g, "\n"))}`
    return spacePage(ctx, categoryId, flash)
  }
  const flash = r.changed
    ? `<div class="card ok">Saved SPACE.md${r.backup ? `; previous version kept as <code>${esc(path.basename(r.backup))}</code>` : ""}.<details><summary>Diff</summary>${renderDiff(r.before, text.replace(/\r\n/g, "\n"))}</details></div>`
    : `<div class="card dim">No changes to save.</div>`
  return spacePage(ctx, categoryId, flash)
}

async function historyPage(ctx: ConsoleContext, categoryId: string, name: string) {
  if (!/^SPACE\.md\.[\w.-]+$/.test(name)) return notFound(ctx)
  const old = await readViewable(path.join(ctx.stack.spaceDir(categoryId), ".history"), name)
  const cur = await ctx.stack.spaceNotes(categoryId)
  if (!old || !cur) return notFound(ctx)
  return page(
    "SPACE.md history",
    ctx,
    "/neoclaw/spaces",
    `<h1>SPACE.md: ${esc(name.replace(/^SPACE\.md\./, ""))} → now</h1><p><a href="/neoclaw/spaces/${esc(categoryId)}">← space</a></p>${renderDiff(old.text, cur.text)}<details><summary>That version in full</summary><pre>${esc(old.text)}</pre></details>`,
  )
}

async function spaceAction(req: Request, ctx: ConsoleContext, categoryId: string) {
  const form = await req.formData()
  const action = String(form.get("action") ?? "")
  const mirror = form.get("mirror") === "1"
  const fail = (msg: string) => spacePage(ctx, categoryId, `<div class="card err"><b>${esc(action)} failed:</b> ${esc(maskSecrets(msg))}</div>`)
  try {
    if (action === "init") {
      const mode = form.get("mode") === "this-channel" ? "this-channel" : "create"
      const channelId = String(form.get("channelId") ?? "")
      const body: Record<string, unknown> = mode === "this-channel" ? { channelId, mode } : { categoryId, mode }
      if (mode === "this-channel" && !isSnowflake(channelId)) return fail("pick a chat")
      const r = await ctx.bridge.spaceAction("init", body, ctx.user, mirror)
      const warning = typeof r.warning === "string" && r.warning ? `<br><span class="warn">${esc(r.warning)}</span>` : ""
      return spacePage(ctx, categoryId, `<div class="card ok">Space is on.${r.createdMissionControl ? " Created a mission-control channel." : ""}${warning}</div>`)
    }
    if (action === "off") {
      const r = await ctx.bridge.spaceAction("off", { categoryId }, ctx.user, mirror)
      return spacePage(ctx, categoryId, `<div class="card ok">${r.changed === false ? "The space was already off." : "Space turned off. Notes and skills are kept."}</div>`)
    }
    if (action === "backfill") {
      const s = spaceView(ctx, categoryId)
      const mc = s?.missionControlChannelId
      if (!s || !mc) return fail("this space has no mission-control chat")
      await ctx.bridge.startBackfill(categoryId, mc, ctx.user, mirror)
      const sum = ctx.bridge.channelSummary(mc)
      return redirect(sum.chatId ? `/chat/${sum.chatId}` : sum.projectId ? `/project/${sum.projectId}` : `/neoclaw/spaces/${categoryId}`)
    }
    return fail("unknown action")
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ------------------------------------------------------------------ skills

const SOURCE_LABEL: Record<SkillEntry["source"], string> = {
  global: "Global (~/.claude/skills)",
  bundled: "neo-claw bundled (repo skills/)",
  space: "Space skills",
  channel: "Per-chat skills (.claude/skills)",
}

function skillHref(k: SkillEntry, file?: string) {
  return `/neoclaw/skills/view?source=${k.source}&id=${encodeURIComponent(k.id)}${file ? `&file=${encodeURIComponent(file)}` : ""}`
}

async function skillsPage(ctx: ConsoleContext) {
  const all = await ctx.stack.skills()
  const sections = (Object.keys(SOURCE_LABEL) as SkillEntry["source"][])
    .map((src) => {
      const list = all.filter((k) => k.source === src)
      const rows = list
        .map((k) => {
          const where = k.source === "space" ? `<span class="tag space">◆ ${esc(k.spaceName)}</span>` : k.source === "channel" ? `<span class="tag">#${esc(ctx.bridge.channelName(k.channelId!))}</span>` : ""
          return `<tr><td>${where}<a href="${skillHref(k)}">${esc(k.name)}</a></td><td class="dim">${esc(k.description.slice(0, 220))}</td><td>${esc(k.effect)}</td></tr>`
        })
        .join("")
      return `<h2>${esc(SOURCE_LABEL[src])} <span class="dim">(${list.length})</span></h2><table><tr><th>Skill</th><th>Description</th><th>In effect</th></tr>${rows || `<tr><td colspan="3" class="dim">None.</td></tr>`}</table>`
    })
    .join("")
  const remote = ctx.stack.remoteSkillHosts()
  const remoteNote = remote.length ? `<h2>Remote hosts</h2><ul>${remote.map((h) => `<li><b>${esc(h)}</b>: remote, not shown <span class="dim">(no read path from here; chats routed there use that host's skills)</span></li>`).join("")}</ul>` : ""
  return page("Skills", ctx, "/neoclaw/skills", `<h1>Skills</h1><p class="dim">Read-only. "In effect" is where Claude Code loads the skill: global skills in every local chat, bundled ones in chats that hold a copy, space skills in the space's member chats, per-chat skills in that chat.</p>${sections}${remoteNote}`)
}

async function skillPage(ctx: ConsoleContext, url: URL) {
  const k = await ctx.stack.skill(url.searchParams.get("source") ?? "", url.searchParams.get("id") ?? "")
  if (!k) return notFound(ctx, "Unknown skill")
  const file = url.searchParams.get("file") ?? "SKILL.md"
  const tree = await fileTree(k.dir)
  const view = await readViewable(k.dir, file)
  const treeHtml = tree.files
    .map((f) => {
      const depth = f.rel.split(path.sep).length - 1
      const pad = "&nbsp;".repeat(depth * 3)
      return f.dir ? `${pad}<span class="dim">${esc(path.basename(f.rel))}/</span>` : `${pad}<a href="${skillHref(k, f.rel)}">${f.rel === file ? `<b>${esc(path.basename(f.rel))}</b>` : esc(path.basename(f.rel))}</a> <span class="dim">${bytes(f.size)}</span>`
    })
    .join("<br>")
  const chats = k.channels.slice(0, 60).map((id) => chanLink(ctx, id)).join(", ")
  const content = !view
    ? `<p class="dim">Not readable.</p>`
    : /\.md$/i.test(file)
      ? `${renderMarkdown(view.text)}${view.truncated ? `<p class="dim">(truncated)</p>` : ""}`
      : `<pre>${esc(view.text)}</pre>${view.truncated ? `<p class="dim">(truncated)</p>` : ""}`
  return page(
    k.name,
    ctx,
    "/neoclaw/skills",
    `<p><a href="/neoclaw/skills">← skills</a></p><h1>${esc(k.name)} <span class="tag">${esc(k.source)}</span>${k.spaceName ? `<span class="tag space">◆ ${esc(k.spaceName)}</span>` : ""}</h1>
<p>${esc(k.description)}</p>
<dl><dt>Folder</dt><dd><code>${esc(k.dir)}</code></dd><dt>In effect</dt><dd>${esc(k.effect)}</dd>${chats ? `<dt>Chats</dt><dd>${chats}${k.channels.length > 60 ? " …" : ""}</dd>` : ""}</dl>
<h2>Files</h2><div class="card"><code>${treeHtml}</code>${tree.truncated ? `<p class="dim">(first ${tree.files.length} entries)</p>` : ""}</div>
<h2>${esc(file)}</h2>${content}`,
  )
}

// ------------------------------------------------------------------ memory

function memoryIndex(ctx: ConsoleContext) {
  const ids = ctx.bridge.knownChannelIds().filter(isSnowflake)
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const pl = ctx.bridge.placement(id)
    const g = pl.isSpace ? `◆ ${pl.categoryName}` : pl.categoryName ?? (pl.categoryId ? `category …${pl.categoryId.slice(-4)}` : "Other")
    groups.set(g, [...(groups.get(g) ?? []), id])
  }
  const body = [...groups.entries()]
    .sort(([a], [b]) => Number(b.startsWith("◆")) - Number(a.startsWith("◆")) || a.localeCompare(b))
    .map(([g, list]) => `<h3>${esc(g)}</h3><p>${list.map((id) => ({ id, name: ctx.bridge.channelName(id) })).sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<a href="/neoclaw/memory/${esc(c.id)}">#${esc(c.name)}</a>${ctx.bridge.isRemote(c.id) ? ` <span class="dim">(${esc(ctx.bridge.isRemote(c.id))})</span>` : ""}`).join(" · ")}</p>`)
    .join("")
  return page("Memory", ctx, "/neoclaw/memory", `<h1>Memory</h1><p class="dim">Per chat: Claude Code's auto-memory folder, the rolling summary of the Discord history, and memory-search facts when the sidecar runs.</p>${body}`)
}

async function memoryPage(ctx: ConsoleContext, channelId: string, file: string | null) {
  const name = ctx.bridge.channelName(channelId)
  const remote = ctx.bridge.isRemote(channelId)
  const m = await ctx.stack.memory(channelId)
  const head = `<p><a href="/neoclaw/memory">← memory</a></p><h1>#${esc(name)} <span class="dim">memory</span></h1>`
  if (file) {
    if (!/^[\w.-]+$/.test(file)) return notFound(ctx)
    const v = await readViewable(m.memDir, file)
    return page(`${name} · ${file}`, ctx, "/neoclaw/memory", `${head}<p><a href="/neoclaw/memory/${esc(channelId)}">← #${esc(name)}</a></p><h2>${esc(file)}</h2>${v ? (/\.md$/i.test(file) ? renderMarkdown(v.text) : `<pre>${esc(v.text)}</pre>`) : `<p class="dim">Not found.</p>`}`)
  }
  const side = await ctx.stack.memorySidecar(channelId)
  const sideHtml = !side.configured
    ? `<p class="dim">No memory sidecar configured.</p>`
    : !side.up
      ? `<p class="warn">The memory-search sidecar isn't running, so facts and episodes aren't available.</p>`
      : `<h3>Facts</h3>${side.facts?.length ? `<ul>${side.facts.map((f) => `<li>${esc(maskSecrets(String(f.fact ?? f.name ?? "")))} <span class="dim">${esc(String(f.valid_at ?? ""))}</span></li>`).join("")}</ul>` : `<p class="dim">None.</p>`}
<h3>Episodes</h3>${side.episodes?.length ? `<ul>${side.episodes.map((e) => `<li><b>${esc(String(e.name ?? ""))}</b> <span class="dim">${esc(String(e.valid_at ?? e.created_at ?? "").slice(0, 19))}</span><br><span class="dim">${esc(maskSecrets(String(e.content ?? "")).slice(0, 300))}</span></li>`).join("")}</ul>` : `<p class="dim">None.</p>`}`
  const body = `${head}
${remote ? `<p class="warn">This chat runs on <b>${esc(remote)}</b>; its auto-memory lives there (remote, not shown). The Discord history below is local.</p>` : ""}
<h2>Auto-memory</h2>
<p class="dim"><code>${esc(m.memDir)}</code></p>
${m.files.length ? `<p>${m.files.map((f) => `<a href="/neoclaw/memory/${esc(channelId)}?file=${encodeURIComponent(f)}">${esc(f)}</a>`).join(" · ")}</p>` : `<p class="dim">No memory files.</p>`}
${m.index ? renderMarkdown(m.index) : ""}
<h2>Channel knowledge</h2>
<dl><dt>Archive</dt><dd>${m.archive ? `${m.archive.messages.toLocaleString()} messages, ${m.archive.events.toLocaleString()} events, ${bytes(m.archive.bytes)} (last write ${esc(ago(m.archive.mtime))})` : `<span class="dim">none</span>`}</dd>
<dt>Last archived</dt><dd>${esc(m.lastArchivedAt ?? "–")}</dd><dt>Entities</dt><dd>${m.entityCount ?? "–"}</dd></dl>
${m.summary ? `<details open><summary>Rolling summary</summary>${renderMarkdown(m.summary)}</details>` : `<p class="dim">No rolling summary yet.</p>`}
${m.decisions ? `<details><summary>Decisions</summary>${renderMarkdown(m.decisions)}</details>` : ""}
<h2>memory-search</h2>${sideHtml}`
  return page(`${name} · memory`, ctx, "/neoclaw/memory", body)
}

// ------------------------------------------------------------------ hooks + settings

async function settingsPage(ctx: ConsoleContext) {
  const s = await ctx.stack.settings()
  const hooks = s.hooks
    .map(
      (h) => `<div class="card"><b>${esc(h.event)}</b>${h.matcher ? ` <span class="tag">matcher: ${esc(h.matcher)}</span>` : ""}${h.timeout ? ` <span class="dim">timeout ${h.timeout}s</span>` : ""}
<p><code>${esc(h.command)}</code></p>${h.description ? `<p>${esc(h.description)}</p>` : ""}${h.source ? `<details><summary>Script source (${esc(h.script)})</summary><pre>${esc(h.source)}</pre></details>` : ""}</div>`,
    )
    .join("")
  const chRows = Object.entries(s.channelSettings)
    .map(([id, v]) => ({ id, name: ctx.bridge.channelName(id), v }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<tr><td>${chanLink(ctx, c.id)}</td><td>${esc(c.v.model ?? "–")}</td><td>${esc(c.v.effort ?? "–")}</td><td>${esc(c.v.maxTurns ?? "–")}</td></tr>`)
    .join("")
  const g = s.channelGlobal
  return page(
    "Hooks & settings",
    ctx,
    "/neoclaw/settings",
    `<h1>Hooks & settings</h1>
<h2>Compaction</h2><p>Auto-compacts at <b>${Math.round(s.compact.tokens / 1000)}k</b> tokens <span class="dim">(${esc(s.compact.from)})</span>.</p>
<h2>Hooks</h2><p class="dim">From <code>${esc(s.file)}</code>.</p>${hooks || `<p class="dim">No hooks.</p>`}
<h2>Environment</h2><p class="dim">Names only: the values (API keys) are never shown.</p><p>${s.envKeys.map((k) => `<code>${esc(k)}</code>`).join(" · ") || "–"}</p>
<h2>Permissions</h2><dl><dt>Default mode</dt><dd>${esc(s.permissions.defaultMode ?? "–")}</dd><dt>Allow</dt><dd>${s.permissions.allow.map((x) => `<code>${esc(x)}</code>`).join(" ") || "–"}</dd><dt>Deny</dt><dd>${s.permissions.deny.map((x) => `<code>${esc(x)}</code>`).join(" ") || "–"}</dd></dl>
<h2>Model and effort</h2><p>Defaults: model <b>${esc(g.model ?? "–")}</b>, effort <b>${esc(g.effort ?? "–")}</b>, max turns <b>${esc(g.maxTurns ?? "–")}</b>.</p>
<table><tr><th>Chat</th><th>Model</th><th>Effort</th><th>Max turns</th></tr>${chRows || `<tr><td colspan="4" class="dim">No per-chat overrides.</td></tr>`}</table>
<p class="dim">Change these in Discord with <code>/model</code> and <code>/effort</code>.</p>`,
  )
}

// ------------------------------------------------------------------ MCP

async function mcpPage(ctx: ConsoleContext, toolsFor: string | null) {
  const servers = await ctx.stack.mcpServers()
  let toolsHtml = ""
  if (toolsFor) {
    const entry = servers.find((s) => s.key === toolsFor)
    const r = await withSpawnSlot(() => ctx.stack.mcpTools(toolsFor))
    toolsHtml = `<div class="card"><h3>Tools: ${esc(entry?.name ?? "?")}</h3>${
      !r
        ? `<p class="warn">Busy: another server is starting. Try again in a moment.</p>`
        : "error" in r
          ? `<p class="err">${esc(r.error)}</p>`
          : `<table>${r.tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td class="dim">${esc(t.description.slice(0, 400))}</td></tr>`).join("") || `<tr><td class="dim">No tools.</td></tr>`}</table>`
    }</div>`
  }
  const rows = servers
    .map(
      (s) => `<tr><td><b>${esc(s.name)}</b></td><td>${s.scope === "user" ? "all chats (user settings)" : `${s.channels.length} chat${s.channels.length === 1 ? "" : "s"}`}</td><td>${esc(s.type)}</td>
<td><code>${esc([s.command, ...s.args].join(" "))}</code>${s.envKeys.length ? `<br><span class="dim">env: ${s.envKeys.map(esc).join(", ")}</span>` : ""}${s.headerKeys.length ? `<br><span class="dim">headers: ${s.headerKeys.map(esc).join(", ")}</span>` : ""}</td>
<td>${s.sample ? `<form method="post" action="/neoclaw/mcp" class="inline"><input type="hidden" name="key" value="${esc(s.key)}"><button class="quiet">List tools</button></form>` : `<span class="dim">remote</span>`}</td></tr>`,
    )
    .join("")
  return page(
    "MCP servers",
    ctx,
    "/neoclaw/mcp",
    `<h1>MCP servers</h1><p class="dim">From Claude Code's user settings and each chat's <code>.mcp.json</code> (grouped when identical apart from the chat id). Env and header values are never shown. "List tools" starts the server briefly.</p>
${toolsHtml}<table><tr><th>Server</th><th>Used by</th><th>Type</th><th>Command</th><th></th></tr>${rows}</table>`,
  )
}

// ------------------------------------------------------------------ jobs

async function jobsPage(ctx: ConsoleContext, logId: string | null) {
  const j = await ctx.stack.jobs()
  let logHtml = ""
  if (logId) {
    const l = await ctx.stack.jobLog(logId)
    logHtml = `<div class="card"><h3>Log: ${esc(logId)}</h3>${!l ? `<p class="dim">No log for this wake.</p>` : l.remote ? `<p class="dim">The log is on ${esc(l.remote)} (remote, not shown).</p>` : `<pre>${esc(l.text)}</pre>`}</div>`
  }
  const pending = j.wakes.filter((w) => !["fired", "cancelled", "canceled", "done"].includes(w.status))
  const row = (w: (typeof j.wakes)[number]) =>
    `<tr><td><code>${esc(w.id)}</code></td><td>${esc(w.kind)}${w.jobName ? `: ${esc(w.jobName)}` : ""}</td><td>${esc(w.status)}</td><td>${esc(w.host ?? "local")}</td><td>${w.channelId ? chanLink(ctx, w.channelId) : "–"}</td>
<td>${esc(w.note.slice(0, 160))}${w.command ? `<br><code class="dim">${esc(w.command.slice(0, 200))}</code>` : ""}</td><td>${esc(ago(w.createdAt))}${w.fireAt ? `<br><span class="dim">fires ${esc(ago(w.fireAt))}</span>` : ""}${w.firedAt ? `<br><span class="dim">fired ${esc(ago(w.firedAt))}</span>` : ""}</td>
<td>${w.logFile ? `<a href="/neoclaw/jobs?log=${encodeURIComponent(w.id)}">log</a>` : ""}</td></tr>`
  const head = `<tr><th>Id</th><th>What</th><th>Status</th><th>Host</th><th>Chat</th><th>Note</th><th>When</th><th></th></tr>`
  const terms = j.terminals.slice(0, 80)
  return page(
    "Jobs",
    ctx,
    "/neoclaw/jobs",
    `<h1>Jobs</h1>${logHtml}
<p class="dim">Background jobs and timers that wake their chat when they finish (wake-on-exit), and long-running terminals.</p>
<h2>Waiting <span class="dim">(${pending.length})</span></h2><table>${head}${pending.map(row).join("") || `<tr><td colspan="8" class="dim">Nothing waiting.</td></tr>`}</table>
<h2>Recent</h2><table>${head}${j.wakes.filter((w) => !pending.includes(w)).slice(0, 60).map(row).join("")}</table>
<h2>Terminals <span class="dim">(${j.terminals.filter((t) => t.status === "running").length} running of ${j.terminals.length})</span></h2>
<table><tr><th>Name</th><th>Status</th><th>Chat</th><th>Command</th><th>Restart</th><th>Updated</th></tr>${terms.map((t) => `<tr class="${t.status === "running" ? "run" : ""}"><td>${esc(t.name)}</td><td>${esc(t.status)}</td><td>${t.channelId ? chanLink(ctx, t.channelId) : "–"}</td><td><code>${esc(t.command.slice(0, 200))}</code></td><td>${esc(t.restartPolicy)}</td><td>${esc(ago(t.updatedAt))}</td></tr>`).join("")}</table>`,
  )
}

// ------------------------------------------------------------------ nodes

async function nodesPage(ctx: ConsoleContext, jobsFor: string | null) {
  const n = await ctx.stack.nodes()
  if (!n.configured) return page("Nodes", ctx, "/neoclaw/nodes", `<h1>Compute nodes</h1><p class="dim">No node CLI configured (<code>nodeCli</code>).</p>`)
  if ("error" in n) return page("Nodes", ctx, "/neoclaw/nodes", `<h1>Compute nodes</h1><p class="err">${esc(n.error)}</p>`)
  let jobsHtml = ""
  if (jobsFor) {
    const out = await ctx.stack.nodeJobs(jobsFor)
    jobsHtml = `<div class="card"><h3>Jobs on ${esc(jobsFor)}</h3>${out == null ? `<p class="dim">Unknown node.</p>` : `<pre>${esc(out)}</pre>`}</div>`
  }
  const rows = (n.nodes as Record<string, any>[])
    .map((x) => {
      const sp = (x.specs ?? {}) as Record<string, any>
      const gpus = Array.isArray(sp.gpus) ? sp.gpus.map((g: any) => `${g.name}${g.mem_total_mb ? ` (${Math.round(g.mem_total_mb / 1024)} GB)` : ""}`).join(", ") : ""
      const load = x.load && typeof x.load === "object" ? Object.entries(x.load as Record<string, unknown>).filter(([, v]) => typeof v !== "object").map(([k, v]) => (k.startsWith("mem") && typeof v === "number" ? `${k} ${bytes(v)}` : typeof v === "number" ? `${k} ${Math.round(v * 100) / 100}` : `${k} ${v}`)).join(", ") : ""
      return `<tr class="${x.online ? "run" : ""}"><td><b>${esc(x.name)}</b></td><td>${x.online ? `<span class="ok">online</span>` : `<span class="dim">offline</span>`}</td><td>${esc(x.last_seen_ago_s != null ? `${x.last_seen_ago_s}s ago` : "–")}</td>
<td>${esc(sp.cpu_model ?? "")}<br><span class="dim">${esc(sp.cpu_limit ?? sp.cores_visible ?? "?")} cores · ${bytes(sp.mem_limit)} RAM</span></td><td>${esc(gpus || "–")}</td><td class="dim">${esc(load)}</td><td><a href="/neoclaw/nodes?jobs=${encodeURIComponent(String(x.name))}">jobs</a></td></tr>`
    })
    .join("")
  return page("Nodes", ctx, "/neoclaw/nodes", `<h1>Compute nodes</h1><p class="dim">Read-only (<code>neo-claw-node list</code>).</p>${jobsHtml}<table><tr><th>Node</th><th>State</th><th>Seen</th><th>CPU / RAM</th><th>GPU</th><th>Load</th><th></th></tr>${rows}</table>`)
}

// ------------------------------------------------------------------ ops

async function opsPage(ctx: ConsoleContext, usage: string | null) {
  const o = await ctx.stack.ops()
  const health = await ctx.bridge.apiGet<Record<string, unknown>>("/api/health", 2500)
  let usageHtml = `<p><a href="/neoclaw/ops?usage=1">Load usage</a> <span class="dim">(asks neo-claw; can take a minute or two the first time, then it's cached for 10 min)</span></p>`
  if (usage) {
    const u = await ctx.bridge.apiGet<{ at: number; hosts: { host: string; ok: boolean; note?: string; limits: { label: string; pct: number; resets: string }[]; summary24h?: string }[] }>(
      `/api/usage${usage === "refresh" ? "?refresh=1" : ""}`,
      170_000,
    )
    usageHtml = !u
      ? `<p class="warn">Usage isn't available (the neo-claw API is down or timed out).</p>`
      : `${u.hosts.map((h) => `<div class="card"><b>${esc(h.host)}</b>${h.ok ? "" : ` <span class="warn">${esc(h.note ?? "unavailable")}</span>`}${h.limits.length ? `<table>${h.limits.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.pct)}%</td><td class="dim">resets ${esc(l.resets)}</td></tr>`).join("")}</table>` : ""}${h.summary24h ? `<p class="dim">${esc(h.summary24h)}</p>` : ""}</div>`).join("")}
<p class="dim">As of ${esc(ago(u.at))}. <a href="/neoclaw/ops?usage=refresh">Refresh</a></p>`
  }
  const mem = o.mem
  const services = o.services.map((s) => `<tr><td>${esc(s.name)}</td><td class="${s.state === "active" ? "ok" : "err"}">${esc(s.state)}</td></tr>`).join("")
  const queue = o.queue.length
    ? `<table><tr><th>Id</th><th>Note</th><th>By</th><th>Queued</th></tr>${(o.queue as Record<string, unknown>[]).map((d) => `<tr><td><code>${esc(d.id)}</code></td><td>${esc(maskSecrets(String(d.note ?? "")))}</td><td>${esc(d.by ?? "")}</td><td>${esc(ago(String(d.queued_at ?? "")))}</td></tr>`).join("")}</table>`
    : `<p class="dim">Empty.</p>`
  const links = ctx.bridge.overviewLinks()
  return page(
    "Ops",
    ctx,
    "/neoclaw/ops",
    `<h1>Ops</h1>
<h2>Health</h2><dl><dt>neo-claw API</dt><dd>${health ? `<span class="ok">up</span>` : `<span class="warn">not reachable</span>`}</dd>
<dt>Load</dt><dd>${esc(o.load)}</dd><dt>Memory</dt><dd>${bytes(mem.MemAvailable)} free of ${bytes(mem.MemTotal)}; swap ${bytes((mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0))} used of ${bytes(mem.SwapTotal)}</dd>
<dt>Disk</dt><dd>${o.disk ? `${bytes(o.disk.free)} free of ${bytes(o.disk.total)}` : "–"}</dd></dl>
${services ? `<h2>Services</h2><table>${services}</table>` : ""}
<h2>Usage</h2>${usageHtml}
<h2>Deploy queue</h2>${queue}${o.deployLog ? `<details><summary>deploy-when-idle log (tail)</summary><pre>${esc(o.deployLog)}</pre></details>` : ""}
${links.length ? `<h2>Dashboards</h2><p>${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(" · ")}</p>` : ""}`,
  )
}

// ------------------------------------------------------------------ search

async function searchPage(ctx: ConsoleContext, url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300)
  const spaceId = url.searchParams.get("space")
  const space = spaceId && isSnowflake(spaceId) ? spaceView(ctx, spaceId) : null
  const from = url.searchParams.get("from") ?? ""
  const scope = url.searchParams.get("scope") === "space" ? "space" : "all"
  const ids = ctx.bridge.knownChannelIds().filter(isSnowflake)
  const options = [`<option value="">(no chat: all channels)</option>`, ...ids.map((id) => ({ id, name: ctx.bridge.channelName(id) })).sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.id)}"${c.id === from ? " selected" : ""}>#${esc(c.name)}</option>`)].join("")
  let result = ""
  if (q) {
    // In a space, search as its mission control would: scope "space" = the other chats of the space.
    const fromId = space ? (space.missionControlChannelId ?? space.members[0]?.id ?? null) : isSnowflake(from) ? from : null
    const r = await withSpawnSlot(() => ctx.stack.search(q, { fromChannelId: fromId, scope: space ? "space" : scope, maxResults: 20 }))
    result = !r ? `<p class="warn">Busy, try again in a moment.</p>` : "error" in r ? `<p class="err">${esc(r.error)}</p>` : `<pre>${esc(r.text)}</pre>`
    if (space && fromId) result = `<p class="dim">Searching ◆ ${esc(space.name)} as #${esc(ctx.bridge.channelName(fromId))} would (search_channels leaves out the calling chat).</p>${result}`
  }
  const form = space
    ? `<form method="get"><input type="hidden" name="space" value="${esc(space.id)}"><input type="search" name="q" size="60" value="${esc(q)}" autofocus> <button>Search ◆ ${esc(space.name)}</button></form>`
    : `<form method="get"><input type="search" name="q" size="60" value="${esc(q)}" autofocus> as <select name="from">${options}</select>
<select name="scope"><option value="all"${scope === "all" ? " selected" : ""}>all channels</option><option value="space"${scope === "space" ? " selected" : ""}>that chat's space</option></select> <button>Search</button></form>`
  return page(
    "Search",
    ctx,
    "/neoclaw/search",
    `<h1>Search${space ? ` ◆ ${esc(space.name)}` : ""}</h1><p class="dim">The same <code>search_channels</code> tool chats use: FTS5 syntax (phrases, prefix*, AND/OR/NOT, NEAR). Scope "space" searches the other chats in the calling chat's space.</p>${form}${result}`,
  )
}
