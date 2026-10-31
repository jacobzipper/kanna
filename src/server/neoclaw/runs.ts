import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { maskSecrets } from "./stack"

/**
 * neo-claw's per-run traces (`<channel>/.neo-claw/runs/<iso>-<session8>.jsonl`,
 * the raw stream-json of one turn, newest 20 kept). Summaries for run lists and
 * a nested timeline for the trace view. Parsed once per file version and cached.
 */

const RUN_FILE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([0-9a-f]{8})\.jsonl$/
const SPAWN_TOOLS = new Set(["Agent", "Task"])
const TEXT_MAX = 8_000
const IO_MAX = 3_000
const STEPS_MAX = 600

export interface RunSummary {
  id: string
  startedAt: number
  sessionShort: string
  bytes: number
  updatedAt: number
  status: "done" | "error" | "running" | "incomplete"
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

export function runStartFromName(name: string) {
  const m = RUN_FILE.exec(name)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null
}

export function isRunId(id: string) {
  return RUN_FILE.test(`${id}.jsonl`)
}

export async function listRunFiles(channelDir: string) {
  const dir = path.join(channelDir, ".neo-claw", "runs")
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => RUN_FILE.test(n)).sort().reverse()
  return names.map((n) => ({ id: n.slice(0, -6), file: path.join(dir, n), startedAt: runStartFromName(n)! }))
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${(s.length - n).toLocaleString()} more chars)` : s)

function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const s =
    pick("description") ||
    pick("command") ||
    pick("file_path") ||
    pick("pattern") ||
    pick("query") ||
    pick("url") ||
    pick("prompt") ||
    pick("skill") ||
    Object.entries(input)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")
  return maskSecrets(s.replace(/\s+/g, " ").slice(0, 160)) || name
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? ((c as { text?: string }).text ?? ((c as { type?: string }).type === "image" ? "[image]" : "")) : String(c)))
      .join("\n")
  }
  return content == null ? "" : JSON.stringify(content)
}

interface Thread {
  steps: RunStep[]
  omitted: number
  toolCalls: number
}

interface Parsed {
  summary: Omit<RunSummary, "id" | "startedAt" | "sessionShort" | "bytes" | "updatedAt" | "status"> & { hasResult: boolean; isError: boolean }
  detail: { steps: RunStep[]; omitted: number; final: string | null; tools: string[] } | null
}

async function parseFile(file: string, withSteps: boolean): Promise<Parsed> {
  let model: string | null = null
  let tools: string[] = []
  let durationMs: number | null = null
  let cost = 0
  let haveCost = false
  let outputTokens = 0
  let haveOutput = false
  let contextTokens: number | null = null
  let turns: number | null = null
  let toolCalls = 0
  let subagents = 0
  let compactions = 0
  let finalText: string | null = null
  let hasResult = false
  let isError = false

  const main: Thread = { steps: [], omitted: 0, toolCalls: 0 }
  const toolSteps = new Map<string, Extract<RunStep, { k: "tool" }>>()
  // Events whose parent tool_use we haven't seen (shouldn't happen, but traces get capped).
  const orphan = new Map<string, Thread>()
  const threadFor = (parent: string | null | undefined): Thread => {
    if (!parent) return main
    const tool = toolSteps.get(parent)
    if (tool) {
      tool.sub ??= { description: tool.summary, agentType: null, prompt: null, steps: [], toolCalls: 0, omitted: 0 }
      return tool.sub as unknown as Thread
    }
    let t = orphan.get(parent)
    if (!t) {
      t = { steps: [], omitted: 0, toolCalls: 0 }
      orphan.set(parent, t)
    }
    return t
  }
  const push = (t: Thread, step: RunStep) => {
    if (!withSteps) return
    if (t.steps.length >= STEPS_MAX) {
      t.omitted++
      return
    }
    t.steps.push(step)
  }

  const handle = (e: Record<string, unknown>) => {
    const type = e.type
    const parent = (e.parent_tool_use_id as string | null | undefined) ?? null
    if (type === "system") {
      const sub = e.subtype
      if (sub === "init" && !parent) {
        model = typeof e.model === "string" ? e.model : model
        tools = Array.isArray(e.tools) ? (e.tools as string[]).slice(0, 200) : tools
      } else if (sub === "compact_boundary") {
        compactions++
        const meta = e.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined
        push(threadFor(parent), { k: "compact", text: meta ? `${meta.trigger ?? "auto"} compaction${meta.pre_tokens ? ` at ${Math.round(meta.pre_tokens / 1000)}k tokens` : ""}` : null })
      } else if (sub === "task_notification" && !parent) {
        const status = String(e.status ?? "")
        const tool = typeof e.tool_use_id === "string" ? toolSteps.get(e.tool_use_id) : undefined
        if (tool && status && status !== "completed") tool.error = true
      }
      return
    }
    if (type === "assistant" || type === "user") {
      const msg = e.message as { content?: unknown; usage?: Record<string, number> } | undefined
      const thread = threadFor(parent)
      if (type === "assistant" && !parent && msg?.usage) {
        const u = msg.usage
        contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      }
      const content = msg?.content
      if (typeof content === "string") {
        if (type === "user" && content.trim()) {
          if (/^This session is being continued from a previous conversation/.test(content)) {
            compactions++
            push(thread, { k: "compact", text: "context compacted; continued from a summary" })
          } else push(thread, { k: "prompt", text: maskSecrets(clip(content, TEXT_MAX)) })
        }
        return
      }
      if (!Array.isArray(content)) return
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          if (type === "user") {
            if (/^This session is being continued from a previous conversation/.test(b.text)) {
              compactions++
              push(thread, { k: "compact", text: "context compacted; continued from a summary" })
            } else push(thread, { k: "prompt", text: maskSecrets(clip(b.text, TEXT_MAX)) })
          } else {
            push(thread, { k: "text", text: maskSecrets(clip(b.text, TEXT_MAX)) })
            if (!parent) finalText = b.text
          }
        } else if (b.type === "tool_use") {
          const input = (b.input as Record<string, unknown>) ?? {}
          const name = String(b.name ?? "tool")
          toolCalls++
          thread.toolCalls++
          const spawn = SPAWN_TOOLS.has(name)
          if (spawn) subagents++
          const step: Extract<RunStep, { k: "tool" }> = {
            k: "tool",
            id: String(b.id ?? ""),
            name,
            summary: toolSummary(name, input),
            input: withSteps ? maskSecrets(clip(JSON.stringify(input, null, 2), IO_MAX)) : "",
            result: null,
            error: false,
            sub: spawn
              ? {
                  description: typeof input.description === "string" ? input.description : "subagent",
                  agentType: typeof input.subagent_type === "string" ? input.subagent_type : null,
                  prompt: typeof input.prompt === "string" && withSteps ? maskSecrets(clip(input.prompt, TEXT_MAX)) : null,
                  steps: [],
                  toolCalls: 0,
                  omitted: 0,
                }
              : null,
          }
          toolSteps.set(step.id, step)
          // Adopt events that arrived before their parent (rare).
          const early = orphan.get(step.id)
          if (early && step.sub) {
            step.sub.steps.push(...early.steps)
            step.sub.toolCalls += early.toolCalls
            orphan.delete(step.id)
          }
          push(thread, step)
        } else if (b.type === "tool_result") {
          const tool = toolSteps.get(String(b.tool_use_id ?? ""))
          if (tool) {
            if (withSteps) tool.result = maskSecrets(clip(resultText(b.content), IO_MAX))
            tool.error = Boolean(b.is_error)
          }
        }
      }
      return
    }
    if (type === "result" && !parent) {
      hasResult = true
      isError = Boolean(e.is_error) || (typeof e.subtype === "string" && e.subtype !== "success")
      if (typeof e.duration_ms === "number") durationMs = (durationMs ?? 0) + e.duration_ms
      if (typeof e.num_turns === "number") turns = (turns ?? 0) + e.num_turns
      if (typeof e.result === "string" && e.result.trim()) finalText = e.result
      const mu = e.model_usage_since_last_result as Record<string, { costUSD?: number; outputTokens?: number }> | undefined
      if (mu) {
        for (const m of Object.values(mu)) {
          if (typeof m.costUSD === "number") {
            cost += m.costUSD
            haveCost = true
          }
          if (typeof m.outputTokens === "number") {
            outputTokens += m.outputTokens
            haveOutput = true
          }
        }
      } else {
        const u = e.usage as { output_tokens?: number } | undefined
        if (typeof u?.output_tokens === "number") {
          outputTokens += u.output_tokens
          haveOutput = true
        }
      }
    }
  }

  await new Promise<void>((resolve) => {
    let rest = ""
    createReadStream(file, { encoding: "utf8", highWaterMark: 256 * 1024 })
      .on("data", (chunk: string | Buffer) => {
        const parts = (rest + chunk.toString()).split("\n")
        rest = parts.pop() ?? ""
        for (const line of parts) {
          if (!line || line.charCodeAt(0) !== 123) continue
          // Cheap skips for the noisiest events before parsing.
          if (line.startsWith('{"type":"system","subtype":"task_progress"') || line.startsWith('{"type":"tool_progress"')) continue
          try {
            handle(JSON.parse(line) as Record<string, unknown>)
          } catch {
            // truncated or capped line
          }
        }
      })
      .on("end", () => {
        if (rest) {
          try {
            handle(JSON.parse(rest) as Record<string, unknown>)
          } catch {
            // partial last line of a live run
          }
        }
        resolve()
      })
      .on("error", () => resolve())
  })

  // Orphaned sub-threads (parent tool event was capped away): show them at the end.
  for (const [id, t] of orphan) {
    if (t.steps.length === 0) continue
    push(main, { k: "tool", id, name: "Agent", summary: "subagent (start not recorded)", input: "", result: null, error: false, sub: { description: "subagent", agentType: null, prompt: null, steps: t.steps, toolCalls: t.toolCalls, omitted: t.omitted } })
  }

  return {
    summary: {
      model,
      durationMs,
      costUsd: haveCost ? cost : null,
      outputTokens: haveOutput ? outputTokens : null,
      contextTokens,
      turns,
      toolCalls,
      subagents,
      compactions,
      finalPreview: finalText ? maskSecrets(String(finalText).replace(/\s+/g, " ").slice(0, 220)) : null,
      hasResult,
      isError,
    },
    detail: withSteps ? { steps: main.steps, omitted: main.omitted, final: finalText ? maskSecrets(clip(finalText, 40_000)) : null, tools } : null,
  }
}

const summaryCache = new Map<string, { key: string; value: Parsed["summary"] }>()
let active = 0
const waiters: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiters.shift()?.()
  }
}

function statusOf(p: Parsed["summary"], updatedAt: number, channelRunning: boolean, newest: boolean): RunSummary["status"] {
  if (p.hasResult) return p.isError ? "error" : "done"
  const age = Date.now() - updatedAt
  if (channelRunning && newest && age < 30 * 60_000) return "running"
  // Without live status (neo-claw's API down), a newest trace still being written counts as running.
  if (newest && age < 5 * 60_000) return "running"
  return "incomplete"
}

/** Summary of one run file; cached per (size, mtime). */
export async function runSummary(file: string, channelRunning: boolean, newest: boolean): Promise<RunSummary | null> {
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const name = path.basename(file)
  const key = `${st.size}:${st.mtimeMs}`
  let hit = summaryCache.get(file)
  if (!hit || hit.key !== key) {
    const parsed = await limited(() => parseFile(file, false))
    hit = { key, value: parsed.summary }
    summaryCache.set(file, hit)
    if (summaryCache.size > 600) summaryCache.delete(summaryCache.keys().next().value!)
  }
  const m = RUN_FILE.exec(name)!
  return {
    id: name.slice(0, -6),
    startedAt: runStartFromName(name)!,
    sessionShort: m[6]!,
    bytes: st.size,
    updatedAt: st.mtimeMs,
    status: statusOf(hit.value, st.mtimeMs, channelRunning, newest),
    ...stripInternal(hit.value),
  }
}

function stripInternal(s: Parsed["summary"]) {
  const { hasResult: _h, isError: _e, ...rest } = s
  return rest
}

/** Full nested timeline of one run (cap 8 MB on disk, steps and text clipped). */
export async function runDetail(file: string, channelRunning: boolean, newest: boolean): Promise<RunDetail | null> {
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const parsed = await limited(() => parseFile(file, true))
  const name = path.basename(file)
  const m = RUN_FILE.exec(name)!
  return {
    id: name.slice(0, -6),
    startedAt: runStartFromName(name)!,
    sessionShort: m[6]!,
    bytes: st.size,
    updatedAt: st.mtimeMs,
    status: statusOf(parsed.summary, st.mtimeMs, channelRunning, newest),
    ...stripInternal(parsed.summary),
    steps: parsed.detail!.steps,
    omitted: parsed.detail!.omitted,
    final: parsed.detail!.final,
    tools: parsed.detail!.tools,
  }
}
