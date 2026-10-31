import { Link } from "react-router-dom"
import { Bot, ChevronRight, Globe } from "lucide-react"
import { cn } from "../lib/utils"
import type { ChannelCard, RunSummary } from "./api"
import { duration, oneLine, timeAgo, tokens } from "./format"
import { ContextBar, Panel, StatusDot, StatusLabel } from "./ui"

export function RunRow({ r, showChannel, now }: { r: RunSummary; showChannel?: boolean; now: number }) {
  const who = r.trigger?.author ?? (r.trigger ? "someone" : null)
  const prompt = r.trigger?.text ?? r.finalPreview ?? ""
  return (
    <Link to={`/c/${r.channelId}/runs/${r.id}`} className="flex items-start gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-muted/50 active:bg-muted transition-colors">
      <StatusDot status={r.status} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          {showChannel && r.channelName ? <span className="truncate font-medium">#{r.channelName}</span> : null}
          {who ? (
            <span className={cn("flex shrink-0 items-center gap-1 text-muted-foreground", !showChannel && "font-medium text-foreground")}>
              {r.trigger?.via === "web" ? <Globe className="size-3" /> : null}
              {who}
            </span>
          ) : (
            <span className="shrink-0 text-muted-foreground">{r.trigger === null ? "scheduled / wake" : ""}</span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{timeAgo(r.startedAt, now)}</span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{oneLine(prompt, 220) || <em>no prompt recorded</em>}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
          {r.status !== "done" ? <StatusLabel status={r.status} /> : null}
          {r.durationMs != null ? <span>{duration(r.durationMs)}</span> : r.status === "running" ? <span>{duration(now - r.startedAt)} so far</span> : null}
          {r.costUsd != null ? <span>${r.costUsd.toFixed(2)}</span> : null}
          {r.outputTokens ? <span>{tokens(r.outputTokens)} out</span> : null}
          {r.toolCalls ? <span>{r.toolCalls} tools</span> : null}
          {r.subagents ? (
            <span className="flex items-center gap-1">
              <Bot className="size-3" />
              {r.subagents}
            </span>
          ) : null}
          {r.compactions ? <span>{r.compactions}× compacted</span> : null}
        </div>
      </div>
      <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground/50" />
    </Link>
  )
}

export function RunList({ runs, showChannel, now, empty }: { runs: RunSummary[]; showChannel?: boolean; now: number; empty?: string }) {
  if (runs.length === 0) return <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{empty ?? "No runs yet."}</div>
  return (
    <Panel>
      {runs.map((r) => (
        <RunRow key={`${r.channelId}/${r.id}`} r={r} showChannel={showChannel} now={now} />
      ))}
    </Panel>
  )
}

/** Channel card for space members and "running now". */
export function ChannelCardView({ c, window: win, now }: { c: ChannelCard; window: number; now: number }) {
  const status = c.running || c.latestRun?.status === "running" ? "running" : c.queued ? "queued" : c.latestRun?.status === "error" ? "error" : "idle"
  return (
    <Link to={`/c/${c.id}`} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:border-foreground/20 hover:bg-muted/30 active:bg-muted/50">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
          {c.isMission ? "◎ " : "#"}
          {c.name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{timeAgo(c.lastActivityAt, now)}</span>
      </div>
      {c.lastMessage ? (
        <p className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
          <span className="font-medium text-foreground/80">{c.lastMessage.author}:</span> {oneLine(c.lastMessage.text, 300)}
        </p>
      ) : c.topic ? (
        <p className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{c.topic}</p>
      ) : (
        <p className="text-[12.5px] text-muted-foreground/70">No messages yet</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <ContextBar used={c.contextTokens} window={win} />
        {status === "running" ? <span className="text-emerald-600 dark:text-emerald-400">working…</span> : c.queued ? <span>{c.queued} queued</span> : null}
        {c.threadCount ? <span>{c.threadCount} active threads</span> : null}
        {c.runCount ? <span>{c.runCount} traces</span> : null}
      </div>
    </Link>
  )
}
