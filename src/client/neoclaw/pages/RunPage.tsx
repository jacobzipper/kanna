import { useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { Bot, ChevronDown, ChevronRight, Globe, Layers, MessageSquareText, StickyNote, User } from "lucide-react"
import { getToolIcon, TranscriptMarkdown } from "../../components/messages/shared"
import { cn } from "../../lib/utils"
import { peekNc, useNc, type RunDetail, type RunStep } from "../api"
import { duration, mentions, oneLine, tokens } from "../format"
import { Body, ErrorBox, Loading, Page, PageHeader, Pill, Section, StatusDot, StatusLabel, useNow } from "../ui"

const PAGE = 60

export function RunPage() {
  const { channelId = "", runId = "" } = useParams()
  const path = `/channel/${channelId}/runs/${runId}`
  // Poll only while the run is still going.
  const live = peekNc<RunDetail>(path)?.status === "running"
  const { data: d, error, reload } = useNc<RunDetail>(path, { pollMs: live ? 5_000 : 0 })
  const now = useNow(live ? 5_000 : 30_000)
  const started = d ? new Date(d.startedAt) : null

  return (
    <Page>
      <PageHeader
        back={`/c/${channelId}?tab=traces`}
        title={
          <span className="flex items-center gap-2">
            {d ? <StatusDot status={d.status} /> : null}
            Trace{d?.channelName ? <span className="font-normal text-muted-foreground"> · #{d.channelName}</span> : null}
          </span>
        }
        subtitle={started ? started.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : undefined}
      />
      <Body>
        {error && !d ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!d ? (
          error ? null : <Loading />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Stat label="Status" value={<StatusLabel status={d.status} />} />
              <Stat label="Duration" value={d.durationMs != null ? duration(d.durationMs) : d.status === "running" ? `${duration(now - d.startedAt)}…` : "—"} />
              <Stat label="Cost" value={d.costUsd != null ? `$${d.costUsd.toFixed(2)}` : "—"} />
              <Stat label="Output" value={d.outputTokens ? tokens(d.outputTokens) : "—"} />
              <Stat label="Context" value={d.contextTokens ? tokens(d.contextTokens) : "—"} />
              <Stat label="Tools" value={`${d.toolCalls}${d.subagents ? ` · ${d.subagents} agent${d.subagents === 1 ? "" : "s"}` : ""}`} />
            </div>
            <div className="mb-5 flex flex-wrap gap-1.5">
              {d.model ? <Pill>{d.model}</Pill> : null}
              {d.turns ? <Pill>{d.turns} turns</Pill> : null}
              {d.compactions ? <Pill>{d.compactions}× compacted</Pill> : null}
              {d.tools.slice(0, 12).map((t) => (
                <Pill key={t} className="font-mono">
                  {t}
                </Pill>
              ))}
            </div>

            <Section title="Asked">
              <div className="rounded-2xl border border-border bg-card p-3.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  {d.trigger?.via === "web" ? <Globe className="size-3.5" /> : <User className="size-3.5" />}
                  <span className="font-medium text-foreground">{d.trigger?.author ?? (d.trigger === null ? "Scheduled wake or follow-up" : "Someone")}</span>
                  {d.trigger?.via ? <span>via {d.trigger.via}</span> : null}
                </div>
                {d.trigger?.text ? (
                  <div className="text-[13.5px]">
                    <TranscriptMarkdown text={mentions(d.trigger.text)} />
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">The prompt wasn't recorded with this trace.</p>
                )}
              </div>
            </Section>

            <Section title={`Steps${d.steps.length ? ` · ${d.steps.length}` : ""}`}>
              {d.omitted ? <p className="mb-2 px-1 text-[12px] text-muted-foreground">{d.omitted} earlier steps were left out of this trace file.</p> : null}
              <Timeline steps={d.steps} />
              {d.status === "running" ? (
                <div className="mt-2 flex items-center gap-2 px-1 text-[12px] text-emerald-600 dark:text-emerald-400">
                  <StatusDot status="running" /> still working…
                </div>
              ) : null}
            </Section>

            {d.final ? (
              <Section title="Final reply">
                <div className="rounded-2xl border border-border bg-card p-4 text-[14px]">
                  <TranscriptMarkdown text={mentions(d.final)} />
                </div>
              </Section>
            ) : null}
          </>
        )}
      </Body>
    </Page>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-[14px] font-medium tabular-nums">{value}</div>
    </div>
  )
}

function Timeline({ steps, depth = 0 }: { steps: RunStep[]; depth?: number }) {
  const [shown, setShown] = useState(PAGE)
  if (steps.length === 0) return <p className="px-1 text-[13px] text-muted-foreground">No steps recorded.</p>
  return (
    <div className={cn("relative", depth === 0 ? "pl-4" : "pl-3")}>
      <div className="absolute bottom-2 left-[5px] top-2 w-px bg-border" />
      <div className="space-y-1.5">
        {steps.slice(0, shown).map((s, i) => (
          <StepView key={i} s={s} depth={depth} />
        ))}
      </div>
      {steps.length > shown ? (
        <button type="button" onClick={() => setShown((n) => n + PAGE * 2)} className="mt-2 rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground hover:bg-muted">
          Show {Math.min(PAGE * 2, steps.length - shown)} more of {steps.length - shown}
        </button>
      ) : null}
    </div>
  )
}

function Dot({ className }: { className?: string }) {
  return <span className={cn("absolute -left-[14.5px] top-[9px] size-[7px] rounded-full bg-muted-foreground/50 ring-2 ring-background", className)} />
}

function StepView({ s, depth }: { s: RunStep; depth: number }) {
  if (s.k === "text") {
    return (
      <div className="relative">
        <Dot className="bg-logo/70" />
        <div className="min-w-0 rounded-xl px-1 py-0.5 text-[13.5px]">
          <TranscriptMarkdown text={s.text} />
        </div>
      </div>
    )
  }
  if (s.k === "prompt") return <PromptStep text={s.text} />
  if (s.k === "compact") {
    return (
      <div className="relative flex items-center gap-2 py-1 text-[12px] text-amber-700 dark:text-amber-400">
        <Dot className="bg-amber-500" />
        <Layers className="size-3.5" />
        <span className="font-medium">Context compacted</span>
        {s.text ? <span className="truncate text-muted-foreground">{oneLine(s.text, 120)}</span> : null}
      </div>
    )
  }
  if (s.k === "note") {
    return (
      <div className="relative flex items-center gap-2 py-0.5 text-[12px] text-muted-foreground">
        <Dot />
        <StickyNote className="size-3.5" />
        <span className="min-w-0 break-words">{s.text}</span>
      </div>
    )
  }
  return <ToolStep s={s} depth={depth} />
}

function ToolStep({ s, depth }: { s: Extract<RunStep, { k: "tool" }>; depth: number }) {
  const [open, setOpen] = useState(false)
  const Icon = s.sub ? Bot : getToolIcon(s.name)
  return (
    <div className="relative">
      <Dot className={cn(s.error && "bg-red-500", s.sub && "bg-violet-500")} />
      <div className={cn("overflow-hidden rounded-xl border", s.sub ? "border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/30" : "border-border bg-card", s.error && "border-red-200 dark:border-red-900")}>
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <Icon className={cn("size-3.5 shrink-0", s.sub ? "text-violet-500" : "text-muted-foreground")} />
          <span className="shrink-0 font-mono text-[12px] font-medium">{s.sub ? s.sub.agentType ?? "subagent" : s.name}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{s.sub ? s.sub.description : s.summary}</span>
          {s.sub ? <span className="shrink-0 text-[11px] text-muted-foreground">{s.sub.toolCalls} tools</span> : null}
          {s.error ? <span className="shrink-0 text-[11px] text-red-600 dark:text-red-400">error</span> : null}
        </button>
        {open ? (
          <div className="space-y-2 border-t border-border px-3 py-2.5">
            {s.sub ? (
              <>
                {s.sub.prompt && s.sub.steps[0]?.k !== "prompt" ? <Block label="Brief" text={s.sub.prompt} markdown /> : null}
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subagent steps{s.sub.omitted ? ` (${s.sub.omitted} left out)` : ""}</div>
                <Timeline steps={s.sub.steps} depth={depth + 1} />
                {s.result ? <Block label="Returned" text={s.result} markdown /> : null}
              </>
            ) : (
              <>
                {s.input ? <Block label="Input" text={s.input} /> : null}
                {s.result != null ? <Block label={s.error ? "Error" : "Result"} text={s.result || "(empty)"} error={s.error} /> : <p className="text-[12px] text-muted-foreground">No result recorded.</p>}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Block({ label, text, markdown, error }: { label: string; text: string; markdown?: boolean; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {markdown ? (
        <div className="max-h-[50vh] overflow-y-auto rounded-lg bg-muted/40 px-3 py-2 text-[13px]">
          <TranscriptMarkdown text={text} />
        </div>
      ) : (
        <pre className={cn("max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 font-mono text-[11.5px] leading-relaxed", error && "text-red-600 dark:text-red-400")}>{text}</pre>
      )}
    </div>
  )
}

function PromptStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 600
  return (
    <div className="relative">
      <Dot className="bg-sky-500" />
      <div className="relative flex gap-2 overflow-hidden rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-[13px] dark:border-sky-900 dark:bg-sky-950/30">
        <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-sky-600" />
        <div className={cn("min-w-0 flex-1", long && !open && "max-h-40 overflow-hidden")}>
          <TranscriptMarkdown text={text} />
        </div>
        {long ? (
          <button type="button" onClick={() => setOpen((o) => !o)} className={cn("text-[11.5px] font-medium text-sky-700 dark:text-sky-300", !open && "absolute inset-x-0 bottom-0 bg-gradient-to-t from-sky-50 from-50% to-sky-50/0 pb-2 pt-8 dark:from-sky-950")}>
            {open ? "Show less" : "Show the whole prompt"}
          </button>
        ) : null}
      </div>
    </div>
  )
}
