import { useEffect, useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AlertTriangle, ArrowLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import { cn } from "../lib/utils"
import type { NcError, RunStatus } from "./api"
import { duration, timeAgo, tokens } from "./format"

/** Re-render every 30s so "5m ago" labels stay honest. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("nc-page flex-1 min-w-0 h-[100dvh] overflow-y-auto overflow-x-hidden bg-background", className)}>
      {children}
    </div>
  )
}

/** Sticky page header: back button on phones, title, subtitle and actions. */
export function PageHeader({
  title,
  subtitle,
  icon,
  back,
  actions,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  back?: string | true
  actions?: ReactNode
  children?: ReactNode
}) {
  const navigate = useNavigate()
  const goBack = () => {
    if (typeof back === "string") {
      if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) navigate(-1)
      else navigate(back)
    } else navigate(-1)
  }
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 md:px-6 h-14">
        {back ? (
          <button
            type="button"
            onClick={goBack}
            className="md:hidden -ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted"
            aria-label="Back"
          >
            <ArrowLeft className="size-5" />
          </button>
        ) : null}
        {icon ? <div className="shrink-0 text-muted-foreground">{icon}</div> : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold leading-tight md:text-base">{title}</h1>
          {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </header>
  )
}

export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-5xl px-3 py-4 md:px-6 md:py-6 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:pb-10", className)}>{children}</div>
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-6", className)}>
      {title || action ? (
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          {title ? <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>{children}</div>
}

/** A tappable row inside a Panel. */
export function Row({ to, onClick, children, className }: { to?: string; onClick?: () => void; children: ReactNode; className?: string }) {
  const cls = cn(
    "flex w-full items-center gap-3 px-3 py-2.5 text-left border-b border-border last:border-b-0 min-h-[52px]",
    (to || onClick) && "hover:bg-muted/60 active:bg-muted transition-colors cursor-pointer",
    className
  )
  if (to)
    return (
      <Link to={to} className={cls}>
        {children}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
      </Link>
    )
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {children}
      </button>
    )
  return <div className={cls}>{children}</div>
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number | null }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="mx-auto max-w-5xl overflow-x-auto px-2 md:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "relative shrink-0 px-3 pb-2.5 pt-1 text-sm transition-colors",
              value === t.id ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {t.count != null ? <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span> : null}
            {value === t.id ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Tab state kept in the URL (?tab=) so back/forward and links work. */
export function useTab<T extends string>(ids: readonly T[], fallback: T): [T, (t: T) => void] {
  const navigate = useNavigate()
  const params = new URLSearchParams(window.location.search)
  const raw = params.get("tab") as T | null
  const tab = raw && ids.includes(raw) ? raw : fallback
  const set = (t: T) => {
    const next = new URLSearchParams(window.location.search)
    if (t === fallback) next.delete("tab")
    else next.set("tab", t)
    const q = next.toString()
    navigate({ search: q ? `?${q}` : "" }, { replace: true })
  }
  return [tab, set]
}

export function StatusDot({ status, className }: { status: RunStatus | "idle" | "queued"; className?: string }) {
  const color =
    status === "running"
      ? "bg-emerald-500"
      : status === "queued"
        ? "bg-amber-400"
        : status === "error"
          ? "bg-red-500"
          : status === "incomplete"
            ? "bg-amber-500/70"
            : status === "done"
              ? "bg-muted-foreground/40"
              : "bg-muted-foreground/25"
  return (
    <span className={cn("relative inline-flex size-2 shrink-0 rounded-full", color, className)}>
      {status === "running" ? <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" /> : null}
    </span>
  )
}

export function StatusLabel({ status }: { status: RunStatus }) {
  const label = { running: "Running", done: "Done", error: "Failed", incomplete: "Stopped" }[status]
  const cls = {
    running: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
    done: "text-muted-foreground bg-muted",
    error: "text-red-600 dark:text-red-400 bg-red-500/10",
    incomplete: "text-amber-700 dark:text-amber-400 bg-amber-500/10",
  }[status]
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}><StatusDot status={status} />{label}</span>
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground", className)}>
      {children}
    </span>
  )
}

export function ContextBar({ used, window: win, className }: { used: number | null; window: number; className?: string }) {
  if (used == null) return null
  const pct = Math.min(100, Math.round((used / Math.max(1, win)) * 100))
  const tone = pct >= 85 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className={cn("flex items-center gap-2", className)} title={`${used.toLocaleString()} of ${win.toLocaleString()} tokens before auto-compact`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground">{tokens(used)} · {pct}%</span>
    </div>
  )
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: NcError | Error | string; onRetry?: () => void }) {
  const msg = typeof error === "string" ? error : error.message
  return (
    <div className="my-6 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <div className="min-w-0 flex-1 break-words">{msg}</div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="size-3" /> Retry
        </button>
      ) : null}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div
      className={cn(
        "mb-4 rounded-xl border px-3 py-2.5 text-[13px] leading-snug",
        tone === "warn" ? "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300" : "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      {children}
    </div>
  )
}

export function RunMeta({ durationMs, costUsd, toolCalls, subagents, compactions, now }: { durationMs: number | null; costUsd: number | null; toolCalls: number; subagents: number; compactions: number; now?: number }) {
  const parts = [duration(durationMs), costUsd != null ? `$${costUsd.toFixed(2)}` : null, toolCalls ? `${toolCalls} tools` : null, subagents ? `${subagents} agent${subagents === 1 ? "" : "s"}` : null, compactions ? `${compactions} compact` : null].filter(Boolean)
  void now
  return <span className="tabular-nums">{parts.join(" · ")}</span>
}

export { timeAgo }
