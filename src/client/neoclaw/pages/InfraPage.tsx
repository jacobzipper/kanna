import { useState, type ReactNode } from "react"
import { ArrowUpRight, Clock, Cpu, HardDrive, MemoryStick, Rocket, Server, SquareTerminal } from "lucide-react"
import { cn } from "../../lib/utils"
import { useNc } from "../api"
import { bytes, oneLine, timeAgo } from "../format"
import { Body, Empty, ErrorBox, Loading, Notice, Page, PageHeader, Panel, Pill, Row, Section, Tabs, useNow, useTab } from "../ui"

interface NodeInfo {
  name: string
  online: boolean
  last_seen_ago_s: number | null
  specs?: { os?: string; cpu_model?: string; cpu_limit?: number; mem_limit?: number; gpus?: { name: string; mem_total_mb: number }[] }
  load?: { cpu_pct?: number; mem_used?: number; gpus?: { util_pct: number; mem_used_mb: number }[] }
  jobs?: { id: string; status: string; cmd: string; started_at: number; exit_code: number | null }[]
  toolsets?: Record<string, unknown> | string[]
}
interface InfraView {
  ops: {
    services: { name: string; state: string }[]
    load: string | null
    mem: Record<string, number> | null
    disk: { total: number; free: number } | null
    queue: { id: string; note: string; queued_at: string; queuedAtMs: number | null; prs: number[] }[]
    deployLog: string | null
  }
  nodes: { configured: boolean; nodes: NodeInfo[]; error?: string | null }
  wakes: { id: string; kind: string; status: string; host: string | null; channelId: string | null; channelName: string | null; note: string | null; jobName: string | null; createdAt: string; fireAt: string | null; firedAt: string | null }[]
  terminals: { terminalId: string; channelId: string; channelName: string | null; name: string; command: string; status: string; mode: string; restartPolicy: string; updatedAt: string }[]
  links: { label: string; url: string }[]
  apiReachable: boolean
}

const TABS = ["ops", "nodes", "jobs", "terminals"] as const

function Meter({ label, icon, used, total, text }: { label: string; icon: ReactNode; used: number; total: number; text: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[14px] font-medium tabular-nums">{text}</div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", pct > 90 ? "bg-red-500" : pct > 75 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function InfraPage() {
  const { data, error, reload } = useNc<InfraView>("/infra", { pollMs: 15_000 })
  const [tab, setTab] = useTab(TABS, "ops")
  const now = useNow()
  const mem = data?.ops.mem
  const waiting = data?.wakes.filter((w) => w.status === "pending" || w.status === "running" || w.status === "waiting") ?? []
  return (
    <Page>
      <PageHeader title="Infra" subtitle="This server, compute nodes, scheduled jobs and terminals" icon={<Server className="size-5" />}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "ops", label: "Server" },
            { id: "nodes", label: "Nodes", count: data?.nodes.nodes?.length },
            { id: "jobs", label: "Jobs", count: data ? waiting.length || null : null },
            { id: "terminals", label: "Terminals", count: data?.terminals.length },
          ]}
        />
      </PageHeader>
      <Body>
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : (
          <>
            {tab === "ops" ? (
              <>
                {!data.apiReachable ? <Notice tone="warn">neo-claw's web API isn't reachable. Live run status falls back to trace files; sending from the web waits for the next bot deploy.</Notice> : null}
                <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {mem?.MemTotal ? (
                    <Meter label="Memory" icon={<MemoryStick className="size-3.5" />} used={mem.MemTotal - (mem.MemAvailable ?? 0)} total={mem.MemTotal} text={`${bytes((mem.MemTotal - (mem.MemAvailable ?? 0)))} of ${bytes(mem.MemTotal)}`} />
                  ) : null}
                  {mem?.SwapTotal ? <Meter label="Swap" icon={<MemoryStick className="size-3.5" />} used={mem.SwapTotal - (mem.SwapFree ?? 0)} total={mem.SwapTotal} text={`${bytes((mem.SwapTotal - (mem.SwapFree ?? 0)))} of ${bytes(mem.SwapTotal)}`} /> : null}
                  {data.ops.disk ? <Meter label="Disk" icon={<HardDrive className="size-3.5" />} used={data.ops.disk.total - data.ops.disk.free} total={data.ops.disk.total} text={`${bytes(data.ops.disk.free)} free`} /> : null}
                </div>
                {data.ops.load ? <p className="-mt-3 mb-5 px-1 text-[12px] text-muted-foreground">Load average {data.ops.load}</p> : null}
                <Section title="Services">
                  <Panel>
                    {data.ops.services.map((s) => (
                      <Row key={s.name}>
                        <span className={cn("size-2 shrink-0 rounded-full", s.state === "active" ? "bg-emerald-500" : "bg-red-500")} />
                        <span className="flex-1 truncate font-mono text-[12.5px]">{s.name}</span>
                        <span className={cn("text-[12px]", s.state === "active" ? "text-muted-foreground" : "text-red-600 dark:text-red-400")}>{s.state}</span>
                      </Row>
                    ))}
                  </Panel>
                </Section>
                <Section title="Deploy queue">
                  <Panel>
                    {data.ops.queue.length === 0 ? (
                      <Row>
                        <Rocket className="size-4 text-muted-foreground" />
                        <span className="text-[13px] text-muted-foreground">Nothing queued</span>
                      </Row>
                    ) : (
                      data.ops.queue.map((q) => (
                        <Row key={q.id}>
                          <Rocket className="size-4 shrink-0 text-amber-500" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] leading-snug">{q.note}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {q.id} · queued {timeAgo(q.queuedAtMs, now)}
                            </div>
                          </div>
                        </Row>
                      ))
                    )}
                  </Panel>
                  {data.ops.deployLog ? <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{data.ops.deployLog.trim().split("\n").reverse().join("\n")}</pre> : null}
                </Section>
                {data.links.length ? (
                  <Section title="Dashboards">
                    <Panel>
                      {data.links.map((l) => (
                        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="flex min-h-[48px] items-center gap-3 border-b border-border px-3 py-2.5 text-[13px] last:border-b-0 hover:bg-muted/60">
                          <span className="flex-1">{l.label}</span>
                          <ArrowUpRight className="size-4 text-muted-foreground" />
                        </a>
                      ))}
                    </Panel>
                  </Section>
                ) : null}
              </>
            ) : null}

            {tab === "nodes" ? (
              !data.nodes.configured ? (
                <Empty>No compute nodes on this host.</Empty>
              ) : data.nodes.error ? (
                <Notice tone="warn">Couldn't list compute nodes: {data.nodes.error}</Notice>
              ) : !data.nodes.nodes?.length ? (
                <Empty>No nodes enrolled.</Empty>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {data.nodes.nodes.map((n) => (
                    <NodeCard key={n.name} n={n} now={now} />
                  ))}
                </div>
              )
            ) : null}

            {tab === "jobs" ? (
              data.wakes.length === 0 ? (
                <Empty>No scheduled wakes or jobs.</Empty>
              ) : (
                <Panel>
                  {data.wakes.map((w) => (
                    <Row key={w.id} to={w.channelId ? `/c/${w.channelId}` : undefined}>
                      <Clock className={cn("size-4 shrink-0", w.status === "pending" || w.status === "running" ? "text-amber-500" : "text-muted-foreground")} />
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-[13px] leading-snug">{oneLine(w.note, 200) || w.jobName || w.kind}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {w.channelName ? `#${w.channelName} · ` : ""}
                          {w.kind} · {w.status}
                          {w.host ? ` · ${w.host}` : ""}
                          {w.fireAt && !w.firedAt ? ` · fires ${new Date(w.fireAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
                          {w.firedAt ? ` · fired ${timeAgo(Date.parse(w.firedAt), now)}` : ""}
                        </div>
                      </div>
                    </Row>
                  ))}
                </Panel>
              )
            ) : null}

            {tab === "terminals" ? (
              data.terminals.length === 0 ? (
                <Empty>No managed terminals.</Empty>
              ) : (
                <Panel>
                  {data.terminals.map((t) => (
                    <Row key={t.terminalId} to={`/c/${t.channelId}`}>
                      <SquareTerminal className={cn("size-4 shrink-0", t.status === "running" ? "text-emerald-500" : "text-muted-foreground")} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium">{t.name}</span>
                          <Pill>{t.status}</Pill>
                          {t.mode ? <Pill>{t.mode}</Pill> : null}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{t.command}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {t.channelName ? `#${t.channelName} · ` : ""}updated {timeAgo(Date.parse(t.updatedAt), now)}
                        </div>
                      </div>
                    </Row>
                  ))}
                </Panel>
              )
            ) : null}
          </>
        )}
      </Body>
    </Page>
  )
}

function NodeCard({ n, now }: { n: NodeInfo; now: number }) {
  const [open, setOpen] = useState(false)
  const jobs = n.jobs ?? []
  const toolsets = Array.isArray(n.toolsets) ? n.toolsets : Object.keys(n.toolsets ?? {})
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", n.online ? "bg-emerald-500" : "bg-muted-foreground/40")} />
        <span className="flex-1 truncate text-[14px] font-medium">{n.name}</span>
        <span className="text-[11px] text-muted-foreground">{n.online ? "online" : n.last_seen_ago_s != null ? `seen ${timeAgo(now - n.last_seen_ago_s * 1000, now)}` : "offline"}</span>
      </div>
      <div className="mt-1.5 space-y-0.5 text-[12px] text-muted-foreground">
        {n.specs?.cpu_model ? (
          <div className="flex items-center gap-1.5 truncate">
            <Cpu className="size-3.5 shrink-0" /> {n.specs.cpu_model}
            {n.specs.cpu_limit ? ` · ${n.specs.cpu_limit} cores` : ""}
            {n.specs.mem_limit ? ` · ${bytes(n.specs.mem_limit)}` : ""}
          </div>
        ) : null}
        {n.specs?.gpus?.map((g, i) => (
          <div key={i} className="truncate">
            GPU {g.name} · {Math.round(g.mem_total_mb / 1024)} GB{n.load?.gpus?.[i] ? ` · ${n.load.gpus[i].util_pct}% busy` : ""}
          </div>
        ))}
        {n.load?.cpu_pct != null ? <div>CPU {Math.round(n.load.cpu_pct)}%{n.load.mem_used ? ` · ${bytes(n.load.mem_used)} used` : ""}</div> : null}
      </div>
      {jobs.length ? (
        <>
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-[12px] text-muted-foreground underline-offset-2 hover:underline">
            {open ? "Hide" : "Show"} {jobs.length} recent job{jobs.length === 1 ? "" : "s"}
          </button>
          {open ? (
            <div className="mt-1.5 space-y-1">
              {jobs.slice(0, 15).map((j) => (
                <div key={j.id} className="rounded-lg bg-muted/40 px-2 py-1.5">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono">{j.id}</span>
                    <span className={cn(j.status === "running" ? "text-emerald-600" : j.exit_code ? "text-red-600" : "text-muted-foreground")}>
                      {j.status}
                      {j.exit_code != null ? ` (${j.exit_code})` : ""}
                    </span>
                    <span className="ml-auto text-muted-foreground">{timeAgo(j.started_at * 1000, now)}</span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{j.cmd}</div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {toolsets.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {toolsets.map((t) => (
            <Pill key={t}>{t}</Pill>
          ))}
        </div>
      ) : null}
    </div>
  )
}

