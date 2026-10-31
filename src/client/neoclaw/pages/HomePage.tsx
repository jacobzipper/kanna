import { Link } from "react-router-dom"
import { AlertTriangle, ArrowUpRight, Clock, Info, Rocket, Sparkles } from "lucide-react"
import { useNeoClawStore } from "../../stores/neoClawStore"
import { useNc, type HomeView } from "../api"
import { oneLine, timeAgo } from "../format"
import { ChannelCardView, RunList } from "../RunList"
import { Body, ErrorBox, Loading, Page, PageHeader, Panel, Row, Section, useNow } from "../ui"

export function HomePage() {
  const user = useNeoClawStore((s) => s.user)
  const { data, error, reload } = useNc<HomeView>("/home", { pollMs: 10_000 })
  const now = useNow()
  const hour = new Date(now).getHours()
  const greet = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
  return (
    <Page>
      <PageHeader title="Home" subtitle={data?.guildName ? `${data.guildName} · ${data.counts.spaces} space${data.counts.spaces === 1 ? "" : "s"} · ${data.counts.channels} channels` : undefined} icon={<Sparkles className="size-5 text-logo" />} />
      <Body>
        <h2 className="mb-4 px-1 text-xl font-semibold tracking-tight md:text-2xl">
          {greet}
          {user ? `, ${user.displayName}` : ""}
        </h2>
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : (
          <>
            {data.attention.length > 0 ? (
              <Section title="Needs a look">
                <Panel>
                  {data.attention.map((a, i) => (
                    <Row key={i} to={a.href}>
                      {a.level === "warn" ? <AlertTriangle className="size-4 shrink-0 text-amber-500" /> : <Info className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 text-[13px] leading-snug">{a.text}</span>
                    </Row>
                  ))}
                </Panel>
              </Section>
            ) : null}

            <Section title={`Running now${data.active.length ? ` · ${data.active.length}` : ""}`}>
              {data.active.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">Nothing running. neo-claw is idle.</div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {data.active.map((c) => (
                    <ChannelCardView key={c.id} c={c} window={200_000} now={now} />
                  ))}
                </div>
              )}
            </Section>

            {data.waiting.length > 0 ? (
              <Section title="Scheduled and waiting">
                <Panel>
                  {data.waiting.map((w) => (
                    <Row key={w.id} to={w.channelId ? `/c/${w.channelId}` : "/infra?tab=jobs"}>
                      <Clock className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">{oneLine(w.note, 120) || w.kind}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {w.channelName ? `#${w.channelName} · ` : ""}
                          {w.status}
                          {w.fireAt ? ` · fires ${new Date(w.fireAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
                        </div>
                      </div>
                    </Row>
                  ))}
                </Panel>
              </Section>
            ) : null}

            <Section title="Recent runs" action={<span className="text-[11px] text-muted-foreground">across all channels</span>}>
              <RunList runs={data.runs} showChannel now={now} />
            </Section>

            <div className="grid gap-6 md:grid-cols-2">
              <Section title="Deploys">
                <Panel>
                  {data.deploy.queue.length === 0 ? (
                    <Row>
                      <Rocket className="size-4 shrink-0 text-muted-foreground" />
                      <span className="text-[13px] text-muted-foreground">Nothing queued</span>
                    </Row>
                  ) : (
                    data.deploy.queue.map((q) => (
                      <Row key={q.id}>
                        <Rocket className="size-4 shrink-0 text-amber-500" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] leading-snug">{q.note}</div>
                          <div className="text-[11px] text-muted-foreground">queued {timeAgo(q.queuedAtMs, now)} · goes live after an hour with no runs</div>
                        </div>
                      </Row>
                    ))
                  )}
                  {data.deploy.last ? <div className="border-t border-border px-3 py-2 font-mono text-[11px] text-muted-foreground break-words">{data.deploy.last}</div> : null}
                </Panel>
              </Section>
              {data.links.length > 0 ? (
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
            </div>
            <p className="px-1 text-[11px] text-muted-foreground">
              Looking for a channel? <Link to="/channels" className="underline">Browse channels</Link> or <Link to="/spaces" className="underline">spaces</Link>.
            </p>
          </>
        )}
      </Body>
    </Page>
  )
}
