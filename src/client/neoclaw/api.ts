import { useCallback, useEffect, useRef, useState } from "react"
import { channelNames } from "./format"

/**
 * Data hooks for the neo-claw app (`/api/nc/*`). Responses are kept in a
 * module cache so going back to a page paints instantly from the last copy
 * while it refreshes; pages that show live state poll only while visible.
 */

const cache = new Map<string, { at: number; data: unknown }>()
const inflight = new Map<string, Promise<unknown>>()
const listeners = new Map<string, Set<() => void>>()

export class NcError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null = null) {
    super(message)
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api/nc${path}`, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" })
  if (res.status === 401) {
    window.location.href = `/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
    throw new NcError("signed out", 401)
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new NcError(body?.error ?? `request failed (${res.status})`, res.status, body as Record<string, unknown> | null)
  return body
}

export function fetchNc<T>(path: string, force = false): Promise<T> {
  const hit = inflight.get(path)
  if (hit && !force) return hit as Promise<T>
  const p = getJson<T>(path)
    .then((data) => {
      if (path === "/tree") learnNames(data as unknown as Tree)
      cache.set(path, { at: Date.now(), data })
      listeners.get(path)?.forEach((l) => l())
      return data
    })
    .finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

export function peekNc<T>(path: string): T | undefined {
  return cache.get(path)?.data as T | undefined
}

/** Drop cached copies whose path starts with any prefix (after a write). */
export function invalidateNc(...prefixes: string[]) {
  for (const key of [...cache.keys()]) {
    if (prefixes.length === 0 || prefixes.some((p) => key.startsWith(p))) {
      cache.delete(key)
      if (listeners.get(key)?.size) void fetchNc(key, true).catch(() => undefined)
    }
  }
}

export function useNc<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [, bump] = useState(0)
  const [error, setError] = useState<NcError | null>(null)
  const [loading, setLoading] = useState(false)
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(
    (force = false) => {
      const p = pathRef.current
      if (!p) return Promise.resolve()
      setLoading(true)
      return fetchNc<T>(p, force)
        .then(() => setError(null))
        .catch((e: unknown) => setError(e instanceof NcError ? e : new NcError(String(e), 0)))
        .finally(() => {
          if (pathRef.current === p) setLoading(false)
        })
    },
    []
  )

  useEffect(() => {
    if (!path) return
    const l = () => bump((n) => n + 1)
    let set = listeners.get(path)
    if (!set) listeners.set(path, (set = new Set()))
    set.add(l)
    setError(null)
    const hit = cache.get(path)
    if (!hit || Date.now() - hit.at > 1500) void load()
    return () => {
      set!.delete(l)
    }
  }, [path, load])

  useEffect(() => {
    if (!path || !opts.pollMs) return
    const tick = () => {
      if (document.visibilityState === "visible") void load()
    }
    const id = window.setInterval(tick, opts.pollMs)
    const onVis = () => {
      if (document.visibilityState === "visible") void load()
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [path, opts.pollMs, load])

  const data = path ? (cache.get(path)?.data as T | undefined) : undefined
  return { data, error, loading, reload: () => load(true) }
}

export async function ncPost<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/nc${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  })
  const out = (await res.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null
  if (!res.ok) throw new NcError(out?.detail || out?.error || `request failed (${res.status})`, res.status, out as Record<string, unknown> | null)
  return out as T
}

// ------------------------------------------------------------------ types

export type RunStatus = "done" | "error" | "running" | "incomplete"

export interface ThreadNode {
  id: string
  name: string
  archived: boolean
  lastActivityAt: number | null
  messageCount: number | null
  createdAt?: number | null
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

export interface Trigger {
  author: string
  authorId: string | null
  text: string
  via: string
  threadId?: string | null
}

export interface RunSummary {
  id: string
  channelId: string
  channelName?: string | null
  startedAt: number
  updatedAt: number
  status: RunStatus
  model: string | null
  durationMs: number | null
  costUsd: number | null
  outputTokens: number | null
  contextTokens: number | null
  turns: number | null
  toolCalls: number
  subagents: number
  compactions: number
  finalPreview: string | null
  trigger: Trigger | null
}

export type RunStep =
  | { k: "text"; text: string }
  | { k: "prompt"; text: string }
  | { k: "compact"; text: string | null }
  | { k: "note"; text: string }
  | {
      k: "tool"
      id: string
      name: string
      summary: string
      input: string
      result: string | null
      error: boolean
      sub: { description: string; agentType: string | null; prompt: string | null; steps: RunStep[]; toolCalls: number; omitted: number } | null
    }

export interface RunDetail extends RunSummary {
  steps: RunStep[]
  omitted: number
  final: string | null
  tools: string[]
}

export interface LastMessage {
  author: string
  bot: boolean
  text: string
  at: number
}

export interface ChannelCard extends ChannelNode {
  contextTokens: number | null
  lastMessage: LastMessage | null
  latestRun: { id: string; status: RunStatus; startedAt: number; durationMs: number | null } | null
  runCount: number
}

export interface SessionChat {
  chatId: string
  sessionId: string | null
  kind: string
  title: string
  lastMessageAt: number | null
  current: boolean
}

export interface SkillRef {
  id: string
  name: string
  description: string
  source: string
  spaceName?: string | null
}

export interface ChannelView extends ChannelNode {
  category: { id: string; name: string; isSpace: boolean } | null
  contextTokens: number | null
  compactWindow: number
  settings: Record<string, string | undefined>
  settingsScope: "channel" | "global"
  sessions: SessionChat[]
  threads: ThreadNode[]
  runs: RunSummary[]
  skills: SkillRef[]
  mcp: { key: string; name: string; scope: string; type: string }[]
  lastMessage: LastMessage | null
  discordUrl: string | null
  apiReachable: boolean
}

export interface MemoryView {
  files: string[]
  index: string | null
  summary: string | null
  decisions: string | null
  entityCount: number | null
  lastArchivedAt: string | null
  archive: { bytes: number; events: number; messages: number; mtime: number } | null
  sidecar: { configured: boolean; up: boolean; [k: string]: unknown } | null
}

export interface SpaceView {
  id: string
  name: string
  enabled: boolean
  isSpace: boolean
  createdAt: string | null
  missionControlChannelId: string | null
  folder: string
  notes: { text: string; hash: string; exists: boolean } | null
  history: string[]
  skills: { id: string; name: string; description: string }[]
  members: ChannelCard[]
  compactWindow: number
  memory: { channelId: string; index: string | null; summary: string | null; files: string[]; archive: Record<string, unknown> | null } | null
  activity: RunSummary[]
  apiReachable: boolean
}

export interface HomeView {
  guildName: string | null
  apiReachable: boolean
  active: ChannelCard[]
  runs: RunSummary[]
  attention: { level: "warn" | "info"; text: string; href?: string }[]
  deploy: { queue: { id: string; note: string; queued_at: string; queuedAtMs: number | null; prs: number[] }[]; last: string | null }
  waiting: { id: string; kind: string; status: string; note: string | null; channelId: string | null; channelName: string | null; fireAt: string | null }[]
  terminals: number
  counts: { spaces: number; channels: number; withHistory: number }
  links: { label: string; url: string }[]
}

function learnNames(tree: Tree) {
  for (const cat of [...tree.spaces, ...tree.categories]) for (const c of cat.channels) channelNames.set(c.id, c.name)
  for (const c of [...tree.uncategorized, ...tree.gone]) channelNames.set(c.id, c.name)
}
