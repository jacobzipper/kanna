import { createHash } from "node:crypto"
import type { TranscriptEntry, UserPromptAuthor } from "../../shared/types"
import { normalizeClaudeStreamMessage } from "../agent"
import { STRUCTURED_RESULT_TOOL_KINDS } from "../events"

/**
 * Turns Claude Code session JSONL lines (and neo-claw run-trace stream-json
 * events) into Kanna transcript entries. neo-claw wraps every prompt in a
 * Discord preamble; that is stripped here so the web shows what the person
 * actually typed, with who typed it alongside.
 */

/** Line types that are bookkeeping, never conversation. Checked before JSON.parse (some are megabytes). */
const SKIP_PREFIXES = [
  '{"type":"api-request',
  '{"type":"cost-state"',
  '{"type":"queue-operation"',
  '{"type":"attachment"',
  '{"type":"tools-used"',
  '{"type":"atis-latch"',
  '{"type":"mode"',
  '{"type":"last-prompt"',
  '{"type":"file-history-snapshot"',
  '{"type":"rate_limit_event"',
]

export interface ParseState {
  /** Prefix for deterministic entry ids (one per source file). */
  source: string
  /** Set for subagent transcripts: the Agent tool call that spawned them. */
  parentToolUseId?: string
  /** Main-thread transcript: emit context-size updates. */
  trackContext: boolean
  maxContextTokens: number
  structuredToolIds: Set<string>
  seenUsageIds: Set<string>
  /** Latest ai-title line, if any. */
  aiTitle?: string
  lineCounter: number
  /** Discord user id -> display name. */
  authorName: (discordId: string) => string | null
}

export function createParseState(args: {
  source: string
  parentToolUseId?: string
  trackContext?: boolean
  maxContextTokens?: number
  authorName: (discordId: string) => string | null
}): ParseState {
  return {
    source: args.source,
    parentToolUseId: args.parentToolUseId,
    trackContext: args.trackContext ?? false,
    maxContextTokens: args.maxContextTokens ?? 200_000,
    structuredToolIds: new Set(),
    seenUsageIds: new Set(),
    lineCounter: 0,
    authorName: args.authorName,
  }
}

function entryId(state: ParseState, key: string, index: number) {
  return `nc-${createHash("sha1").update(`${state.source}|${key}|${index}`).digest("hex").slice(0, 24)}`
}

export interface StrippedPrompt {
  text: string
  author: UserPromptAuthor | null
  steered: boolean
}

/** Undo neo-claw's buildEnrichedPrompt: drop the Discord header and knowledge block. */
export function stripNeoClawPreamble(raw: string, authorName: (id: string) => string | null): StrippedPrompt {
  let text = raw
  let author: UserPromptAuthor | null = null
  let steered = false
  const header = /^\[Discord User ID: (\d*)\]\s*/.exec(text)
  if (header) {
    const id = header[1] ?? ""
    author = { name: (id && authorName(id)) || (id ? `user ${id.slice(-4)}` : "unknown"), discordId: id || undefined, via: "discord" }
    text = text.slice(header[0].length)
  }
  if (text.startsWith("[Channel Knowledge]")) {
    const end = text.indexOf("[End Channel Knowledge]")
    if (end >= 0) text = text.slice(end + "[End Channel Knowledge]".length).replace(/^\s+/, "")
  }
  const mid = /^\[Mid-run message: [^\]]*\]\n?/.exec(text)
  if (mid) {
    steered = true
    text = text.slice(mid[0].length)
  }
  if (!header && text.startsWith("[neo-claw wake-up")) {
    author = { name: "wake-up", via: "wake" }
  }
  return { text, author, steered }
}

function userText(content: unknown): string | null {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  if (content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "tool_result")) return null
  const texts = content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
  const images = content.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "image").length
  if (texts.length === 0 && images === 0) return null
  return texts.join("\n\n") + (images > 0 ? `\n\n[${images} image(s)]` : "")
}

/**
 * One JSONL line (session transcript or stream-json event) to entries.
 * `forcePrompt` lets run traces, which carry no user prompt, inject one.
 */
export function parseLine(line: string, state: ParseState): TranscriptEntry[] {
  const index = state.lineCounter++
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== "{") return []
  for (const prefix of SKIP_PREFIXES) {
    if (trimmed.startsWith(prefix)) return []
  }
  let msg: any
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!msg || typeof msg !== "object") return []
  if (msg.type === "ai-title" && typeof msg.aiTitle === "string") {
    state.aiTitle = msg.aiTitle
    return []
  }
  const createdAt = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) || Date.now() : Date.now()
  const key = typeof msg.uuid === "string" ? msg.uuid : `line${index}`

  if (msg.type === "user" && !msg.isMeta && msg.message?.role === "user") {
    if (msg.isCompactSummary && typeof msg.message.content === "string") {
      return [{ _id: entryId(state, key, 0), createdAt, kind: "compact_summary", summary: msg.message.content, ...(state.parentToolUseId ? { parentToolUseId: state.parentToolUseId } : {}) } as TranscriptEntry]
    }
    const raw = userText(msg.message.content)
    if (raw !== null) {
      if (raw.startsWith("This session is being continued")) {
        return [{ _id: entryId(state, key, 0), createdAt, kind: "compact_summary", summary: raw } as TranscriptEntry]
      }
      // A subagent's first "user" message is its brief from the parent; it
      // reads better as a prompt nested under the Agent call.
      const stripped = stripNeoClawPreamble(raw, state.authorName)
      const entry: TranscriptEntry = {
        _id: entryId(state, key, 0),
        createdAt,
        kind: "user_prompt",
        content: stripped.text,
        ...(stripped.author ? { author: stripped.author } : {}),
        ...(stripped.steered ? { steered: true } : {}),
        ...(state.parentToolUseId ? { parentToolUseId: state.parentToolUseId } : {}),
      } as TranscriptEntry
      return [entry]
    }
  }

  // Claude Code's transcript stores the structured result as `toolUseResult`;
  // the stream format calls it `tool_use_result`.
  if (msg.type === "user" && msg.toolUseResult !== undefined && msg.tool_use_result === undefined) {
    msg.tool_use_result = msg.toolUseResult
  }
  // Agent calls without an explicit subagent_type (general-purpose) still
  // need to be recognised as subagent spawns, so their work nests.
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task") && block.input && typeof block.input === "object" && typeof block.input.subagent_type !== "string") {
        block.input = { ...block.input, subagent_type: "general-purpose" }
      }
    }
  }
  if (state.parentToolUseId && !msg.parent_tool_use_id) msg.parent_tool_use_id = state.parentToolUseId

  const out = normalizeClaudeStreamMessage(msg, { structuredToolIds: state.structuredToolIds }).map((entry, i) => ({
    ...entry,
    _id: entryId(state, key, i + 1),
    createdAt,
  })) as TranscriptEntry[]
  for (const entry of out) {
    if (entry.kind === "tool_call" && STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) {
      state.structuredToolIds.add(entry.tool.toolId)
    }
  }

  // Context size after each main-thread API response.
  if (state.trackContext && msg.type === "assistant" && !msg.isSidechain && !msg.parent_tool_use_id) {
    const usage = msg.message?.usage
    const messageId = typeof msg.message?.id === "string" ? msg.message.id : null
    if (usage && messageId && !state.seenUsageIds.has(messageId)) {
      state.seenUsageIds.add(messageId)
      const input = Number(usage.input_tokens ?? 0)
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0)
      const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0)
      const output = Number(usage.output_tokens ?? 0)
      out.push({
        _id: entryId(state, key, 999),
        createdAt,
        kind: "context_window_updated",
        usage: {
          usedTokens: input + cacheRead + cacheCreate + output,
          maxTokens: state.maxContextTokens,
          inputTokens: input + cacheRead + cacheCreate,
          cachedInputTokens: cacheRead,
          outputTokens: output,
          compactsAutomatically: true,
        },
      } as TranscriptEntry)
    }
  }
  return out
}
