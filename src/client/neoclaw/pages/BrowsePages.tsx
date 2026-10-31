import { useState } from "react"
import { Link } from "react-router-dom"
import { Hash, LayoutGrid, Plus } from "lucide-react"
import { useNc, type Tree } from "../api"
import { timeAgo } from "../format"
import { NewChannelDialog } from "../dialogs"
import { ChannelTree } from "../NavTree"
import { Body, Empty, ErrorBox, Loading, Page, PageHeader, StatusDot, useNow } from "../ui"

export function SpacesPage() {
  const { data, error, reload } = useNc<Tree>("/tree", { pollMs: 15_000 })
  const now = useNow()
  return (
    <Page>
      <PageHeader title="Spaces" subtitle="Categories with a shared mission control, notes and skills" icon={<LayoutGrid className="size-5 text-logo" />} />
      <Body>
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : data.spaces.length === 0 ? (
          <Empty>No spaces yet. Run /space init in a Discord category to make one.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.spaces.map((s) => {
              const running = s.channels.filter((c) => c.running).length
              const last = s.channels.reduce((m, c) => Math.max(m, c.lastActivityAt ?? 0), 0)
              const mission = s.channels.find((c) => c.isMission)
              return (
                <Link key={s.id} to={`/spaces/${s.id}`} className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-foreground/20 active:bg-muted/40">
                  <div className="flex items-center gap-2">
                    <div className="flex size-9 items-center justify-center rounded-xl bg-logo/10 text-logo">
                      <LayoutGrid className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold">{s.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.channels.length} channels · active {timeAgo(last, now)}
                      </div>
                    </div>
                    {running ? (
                      <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                        <StatusDot status="running" />
                        {running}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {mission ? <span className="rounded-full bg-logo/10 px-2 py-0.5 text-[11px] text-logo">◎ {mission.name}</span> : null}
                    {s.channels
                      .filter((c) => !c.isMission)
                      .slice(0, 6)
                      .map((c) => (
                        <span key={c.id} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          #{c.name}
                        </span>
                      ))}
                    {s.channels.length > 7 ? <span className="px-1 text-[11px] text-muted-foreground">+{s.channels.length - 7}</span> : null}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </Body>
    </Page>
  )
}

export function ChannelsPage() {
  const { data, error, reload } = useNc<Tree>("/tree", { pollMs: 15_000 })
  const [open, setOpen] = useState(false)
  return (
    <Page>
      <PageHeader
        title="Channels"
        subtitle={data ? `${data.guildName ?? "Discord"} · by category` : undefined}
        icon={<Hash className="size-5" />}
        actions={
          <button type="button" onClick={() => setOpen(true)} className="flex h-9 items-center gap-1 rounded-full border border-border px-3 text-[13px] hover:bg-muted">
            <Plus className="size-4" /> New
          </button>
        }
      />
      <Body className="max-w-2xl">
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? error ? null : <Loading /> : <ChannelTree tree={data} />}
      </Body>
      <NewChannelDialog open={open} onOpenChange={setOpen} />
    </Page>
  )
}
