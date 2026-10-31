import { useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { Archive, ArrowUpRight, Brain, FileText, Hash, MessageSquare, MessagesSquare, Orbit, Plus, Sparkles, X } from "lucide-react"
import { TranscriptMarkdown } from "../../components/messages/shared"
import { cn } from "../../lib/utils"
import { useNc, type ChannelView, type MemoryView } from "../api"
import { Composer } from "../Composer"
import { NewConversationDialog } from "../dialogs"
import { bytes, mentions, oneLine, timeAgo } from "../format"
import { RunList } from "../RunList"
import { Body, ContextBar, Empty, ErrorBox, Loading, Notice, Page, PageHeader, Panel, Pill, Row, Section, StatusDot, Tabs, useNow, useTab } from "../ui"

const TABS = ["conversations", "traces", "memory", "skills", "settings"] as const
type Tab = (typeof TABS)[number]

export function ChannelPage() {
  const { channelId = "" } = useParams()
  const [search, setSearch] = useSearchParams()
  const threadId = search.get("thread")
  const { data, error, reload } = useNc<ChannelView>(`/channel/${channelId}`, { pollMs: 8_000 })
  const [tab, setTab] = useTab<Tab>(TABS, "conversations")
  const [newConv, setNewConv] = useState(false)
  const now = useNow()
  const thread = data?.threads.find((t) => t.id === threadId) ?? null
  const status = data?.running || data?.runs[0]?.status === "running" ? "running" : data?.queued ? "queued" : "idle"
  const backTo = data?.category?.isSpace ? `/spaces/${data.category.id}?tab=channels` : "/channels"

  const selectThread = (id: string | null) => {
    const next = new URLSearchParams(search)
    if (id) next.set("thread", id)
    else next.delete("thread")
    setSearch(next, { replace: true })
    if (id) document.querySelector(".nc-page")?.scrollTo({ top: 0, behavior: "smooth" })
  }

  const runs = useMemo(() => (data ? (threadId ? data.runs.filter((r) => r.trigger?.threadId === threadId) : data.runs) : []), [data, threadId])

  return (
    <Page>
      <PageHeader
        back={backTo}
        title={
          <span className="flex items-center gap-1.5">
            {data?.isMission ? <Orbit className="size-4 text-logo" /> : <Hash className="size-4 text-muted-foreground" />}
            {data?.name ?? "Channel"}
            {data ? <StatusDot status={status} className="ml-1" /> : null}
          </span>
        }
        subtitle={
          data ? (
            <span>
              {data.category ? (
                <Link to={data.category.isSpace ? `/spaces/${data.category.id}` : "/channels"} className="hover:underline">
                  {data.category.name}
                </Link>
              ) : (
                "No category"
              )}
              {data.isMission ? " · mission control" : ""}
              {data.remoteHost ? ` · runs on ${data.remoteHost}` : ""}
              {data.gone ? " · deleted from Discord" : ""}
            </span>
          ) : undefined
        }
        actions={
          data?.discordUrl ? (
            <a href={data.discordUrl} target="_blank" rel="noopener noreferrer" className="flex h-9 items-center gap-1 rounded-full px-2.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Open in Discord">
              Discord <ArrowUpRight className="size-3.5" />
            </a>
          ) : null
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "conversations", label: "Conversations", count: data ? data.threads.length + 1 : null },
            { id: "traces", label: "Traces", count: data?.runs.length },
            { id: "memory", label: "Memory" },
            { id: "skills", label: "Skills", count: data?.skills.length },
            { id: "settings", label: "Settings" },
          ]}
        />
      </PageHeader>
      <Body className="pb-4 md:pb-4">
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : (
          <>
            {data.topic && tab === "conversations" ? <p className="mb-4 px-1 text-[13px] leading-snug text-muted-foreground">{data.topic}</p> : null}
            {tab === "conversations" ? (
              <>
                {thread ? (
                  <Section
                    title="Open thread"
                    action={
                      <button type="button" onClick={() => selectThread(null)} className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                        <X className="size-3" /> Close
                      </button>
                    }
                  >
                    <div className="rounded-2xl border border-border bg-card p-4">
                      <div className="flex items-start gap-2">
                        <MessagesSquare className="mt-0.5 size-4 shrink-0 text-logo" />
                        <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug">{mentions(thread.name)}</span>
                        {data.guildId ? (
                          <a href={`https://discord.com/channels/${data.guildId}/${thread.id}`} target="_blank" rel="noopener noreferrer" className="flex shrink-0 items-center gap-0.5 text-[12px] text-muted-foreground hover:text-foreground">
                            Discord <ArrowUpRight className="size-3" />
                          </a>
                        ) : null}
                      </div>
                      <div className="mt-1 pl-6 text-[11.5px] text-muted-foreground">
                        {timeAgo(thread.lastActivityAt, now)}
                        {thread.messageCount != null ? ` · ${thread.messageCount} messages` : ""}
                        {thread.archived ? " · archived (a new message reopens it)" : ""}
                      </div>
                      <div className="mt-3">
                        <RunList runs={runs} now={now} empty="No traces from this thread among the channel's newest 20." />
                      </div>
                    </div>
                  </Section>
                ) : null}
                <Section title="Main session">
                  {data.sessions.filter((s) => s.current).map((s) => (
                    <Link key={s.chatId} to={`/chat/${s.chatId}`} className="block rounded-2xl border border-border bg-card p-4 transition-colors hover:border-foreground/20 active:bg-muted/40">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="size-4 text-logo" />
                        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{s.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{status === "running" ? <span className="text-emerald-600 dark:text-emerald-400">working…</span> : timeAgo(s.lastMessageAt ?? data.lastActivityAt, now)}</span>
                      </div>
                      {data.lastMessage ? (
                        <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
                          <span className="font-medium text-foreground/80">{data.lastMessage.author}:</span> {oneLine(data.lastMessage.text, 260)}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <ContextBar used={data.contextTokens} window={data.compactWindow} />
                        <span className="text-[11px] text-muted-foreground">Threads in #{data.name} share this session</span>
                      </div>
                    </Link>
                  ))}
                  {data.sessions.every((s) => !s.current) ? <Empty>No session yet. Send a message below to start one.</Empty> : null}
                </Section>

                <Section
                  title="Threads"
                  action={
                    <button type="button" onClick={() => setNewConv(true)} disabled={data.gone || data.kind !== "text"} className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40">
                      <Plus className="size-3" /> New conversation
                    </button>
                  }
                >
                  {data.threads.length === 0 ? (
                    <Empty>No threads. Start a conversation to keep a topic in its own Discord thread.</Empty>
                  ) : (
                    <Panel>
                      {data.threads.map((t) => {
                        const n = data.runs.filter((r) => r.trigger?.threadId === t.id).length
                        return (
                          <Row key={t.id} onClick={() => selectThread(t.id === threadId ? null : t.id)} className={cn(t.id === threadId && "bg-muted")}>
                            {t.archived ? <Archive className="size-4 shrink-0 text-muted-foreground/70" /> : <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />}
                            <div className="min-w-0 flex-1">
                              <div className={cn("truncate text-[13.5px]", t.archived && "text-muted-foreground")}>{mentions(t.name)}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {timeAgo(t.lastActivityAt, now)}
                                {t.messageCount != null ? ` · ${t.messageCount} messages` : ""}
                                {n ? ` · ${n} traces` : ""}
                                {t.archived ? " · archived" : ""}
                              </div>
                            </div>
                          </Row>
                        )
                      })}
                    </Panel>
                  )}
                </Section>


                {data.sessions.some((s) => !s.current) ? (
                  <Section title="Earlier sessions">
                    <Panel>
                      {data.sessions
                        .filter((s) => !s.current)
                        .map((s) => (
                          <Row key={s.chatId} to={`/chat/${s.chatId}`}>
                            <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13.5px]">{s.title}</div>
                              <div className="text-[11px] text-muted-foreground">{timeAgo(s.lastMessageAt, now)}</div>
                            </div>
                          </Row>
                        ))}
                    </Panel>
                  </Section>
                ) : null}
              </>
            ) : null}

            {tab === "traces" ? (
              <>
                <p className="mb-3 px-1 text-[12px] text-muted-foreground">One trace per turn: who asked, what ran, what it cost. neo-claw keeps the newest 20.</p>
                <RunList runs={data.runs} now={now} empty="No traces yet." />
              </>
            ) : null}

            {tab === "memory" ? <ChannelMemory channelId={channelId} /> : null}

            {tab === "skills" ? (
              <>
                {data.skills.length === 0 ? (
                  <Empty>No skills in effect.</Empty>
                ) : (
                  <Panel>
                    {data.skills.map((s) => (
                      <Row key={`${s.source}:${s.id}`} to={`/library/skill?source=${s.source}&id=${encodeURIComponent(s.id)}`}>
                        <Sparkles className={cn("size-4 shrink-0", s.source === "space" ? "text-logo" : "text-muted-foreground")} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13.5px] font-medium">{s.name}</span>
                            <Pill>{s.source === "space" ? s.spaceName ?? "space" : s.source}</Pill>
                          </div>
                          <div className="line-clamp-1 text-[12px] text-muted-foreground">{s.description}</div>
                        </div>
                      </Row>
                    ))}
                  </Panel>
                )}
                {data.mcp.length > 0 ? (
                  <Section title="MCP servers" className="mt-6">
                    <div className="flex flex-wrap gap-1.5">
                      {data.mcp.map((m) => (
                        <Pill key={m.key}>
                          {m.name} · {m.scope}
                        </Pill>
                      ))}
                    </div>
                  </Section>
                ) : null}
              </>
            ) : null}

            {tab === "settings" ? (
              <>
                <Panel>
                  {[
                    ["Model", data.settings.model ?? "default"],
                    ["Effort", data.settings.effort ?? "default"],
                    ["Max turns", data.settings.maxTurns && data.settings.maxTurns !== "0" ? data.settings.maxTurns : "unlimited"],
                    ["Auto-compact at", `${(data.compactWindow / 1000).toFixed(0)}k tokens`],
                    ["Runs on", data.remoteHost ?? "this server"],
                  ].map(([k, v]) => (
                    <Row key={k}>
                      <span className="flex-1 text-[13.5px] text-muted-foreground">{k}</span>
                      <span className="text-[13.5px] font-medium">{v}</span>
                    </Row>
                  ))}
                </Panel>
                <p className="mt-2 px-1 text-[12px] text-muted-foreground">
                  {data.settingsScope === "channel" ? "This channel overrides the defaults." : "Using the global defaults."} Change them in Discord with /model, /effort and /settings.
                </p>
              </>
            ) : null}
          </>
        )}
      </Body>
      {data && !data.gone ? (
        <>
          <Composer
            channelId={channelId}
            threadId={thread?.id}
            banner={
              thread ? (
                <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                  <MessagesSquare className="size-3.5 shrink-0" />
                  <span className="truncate">Replying in “{oneLine(thread.name, 60)}”</span>
                  <button type="button" onClick={() => selectThread(null)} className="shrink-0 rounded-full p-0.5 hover:bg-muted hover:text-foreground" aria-label="Send to the channel instead">
                    <X className="size-3.5" />
                  </button>
                </span>
              ) : null
            }
            placeholder={thread ? `Message the thread…` : `Message #${data.name}`}
            disabledReason={data.apiReachable ? null : "Sending opens after the next bot deploy"}
          />
        </>
      ) : null}
      {data ? <NewConversationDialog open={newConv} onOpenChange={setNewConv} channelId={channelId} channelName={data.name} /> : null}
    </Page>
  )
}

function ChannelMemory({ channelId }: { channelId: string }) {
  const { data, error } = useNc<MemoryView>(`/channel/${channelId}/memory`)
  const [file, setFile] = useState<string | null>(null)
  const { data: doc } = useNc<{ text: string; truncated: boolean }>(file ? `/channel/${channelId}/memory/${encodeURIComponent(file)}` : null)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <>
      {data.sidecar?.configured && !data.sidecar.up ? <Notice tone="warn">The memory search service is down, so recall in this channel falls back to files only.</Notice> : null}
      <Section title="Memory files">
        {data.files.length === 0 ? (
          <Empty>No memory files yet. neo-claw writes them as it learns things worth keeping.</Empty>
        ) : (
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {data.files.map((f) => (
              <button key={f} type="button" onClick={() => setFile(f === file ? null : f)} className={cn("flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[12px]", f === file ? "bg-foreground text-background" : "hover:bg-muted")}>
                <FileText className="size-3" /> {f.replace(/\.md$/, "")}
              </button>
            ))}
          </div>
        )}
        <Panel className="mt-2 p-4 text-[13.5px]">
          {file ? doc ? <TranscriptMarkdown text={doc.text} /> : <Loading /> : data.index ? <TranscriptMarkdown text={data.index} /> : <span className="text-muted-foreground">No MEMORY.md index.</span>}
        </Panel>
      </Section>
      {data.summary ? (
        <Section title="Rolling summary of the Discord history">
          <Panel className="max-h-[60vh] overflow-y-auto p-4 text-[13px]">
            <TranscriptMarkdown text={data.summary} />
          </Panel>
        </Section>
      ) : null}
      {data.decisions ? (
        <Section title="Decisions">
          <Panel className="max-h-[50vh] overflow-y-auto p-4 text-[13px]">
            <TranscriptMarkdown text={data.decisions} />
          </Panel>
        </Section>
      ) : null}
      {data.archive ? (
        <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
          <Brain className="size-3.5" /> Archive: {data.archive.messages.toLocaleString()} messages · {bytes(data.archive.bytes)}
          {data.entityCount ? ` · ${data.entityCount} entities` : ""}
        </p>
      ) : null}
    </>
  )
}
