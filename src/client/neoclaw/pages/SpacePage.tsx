import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { History, LayoutGrid, MessageSquare, Orbit, Pencil, Plus, Sparkles } from "lucide-react"
import { TranscriptMarkdown } from "../../components/messages/shared"
import { cn } from "../../lib/utils"
import { invalidateNc, ncPost, NcError, useNc, type SpaceView } from "../api"
import { Composer } from "../Composer"
import { NewChannelDialog } from "../dialogs"
import { oneLine, timeAgo } from "../format"
import { ChannelCardView, RunList } from "../RunList"
import { Body, Empty, ErrorBox, Loading, Notice, Page, PageHeader, Panel, Row, Section, Tabs, useNow, useTab } from "../ui"

const TABS = ["overview", "channels", "skills", "memory", "activity"] as const
type Tab = (typeof TABS)[number]

export function SpacePage() {
  const { spaceId = "" } = useParams()
  const { data, error, reload } = useNc<SpaceView>(`/space/${spaceId}`, { pollMs: 15_000 })
  const [tab, setTab] = useTab<Tab>(TABS, "overview")
  const [newOpen, setNewOpen] = useState(false)
  const now = useNow()
  const mc = data?.members.find((m) => m.isMission) ?? null

  return (
    <Page>
      <PageHeader
        back="/spaces"
        title={data?.name ?? "Space"}
        subtitle={data ? `Space · ${data.members.length} channels${data.enabled ? "" : " · turned off"}` : undefined}
        icon={<LayoutGrid className="size-5 text-logo" />}
        actions={
          <button type="button" onClick={() => setNewOpen(true)} className="hidden h-9 items-center gap-1 rounded-full border border-border px-3 text-[13px] hover:bg-muted sm:flex">
            <Plus className="size-4" /> New channel
          </button>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "channels", label: "Channels", count: data?.members.length },
            { id: "skills", label: "Skills", count: data?.skills.length },
            { id: "memory", label: "Memory" },
            { id: "activity", label: "Activity" },
          ]}
        />
      </PageHeader>
      <Body className="pb-4 md:pb-4">
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : (
          <>
            {tab === "overview" ? (
              <>
                {mc ? (
                  <Link to={mc.chatId ? `/chat/${mc.chatId}` : `/c/${mc.id}`} className="mb-5 block rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-foreground/20">
                    <div className="flex items-center gap-2">
                      <Orbit className="size-4 text-logo" />
                      <span className="text-[13px] font-semibold">Mission control</span>
                      <span className="text-[12px] text-muted-foreground">#{mc.name}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{mc.running ? <span className="text-emerald-600 dark:text-emerald-400">working…</span> : timeAgo(mc.lastActivityAt, now)}</span>
                    </div>
                    {mc.lastMessage ? (
                      <p className="mt-2 line-clamp-3 text-[13.5px] leading-snug">
                        <span className="font-medium">{mc.lastMessage.author}:</span> <span className="text-muted-foreground">{oneLine(mc.lastMessage.text, 300)}</span>
                      </p>
                    ) : (
                      <p className="mt-2 text-[13px] text-muted-foreground">No messages yet. Ask mission control anything about the whole space below.</p>
                    )}
                    <div className="mt-2 flex items-center gap-1 text-[12px] font-medium text-logo">
                      <MessageSquare className="size-3.5" /> Open the chat
                    </div>
                  </Link>
                ) : (
                  <Notice>This space has no mission control channel yet.</Notice>
                )}
                <SpaceNotes space={data} onSaved={reload} />
                <SpaceActions space={data} />
              </>
            ) : null}
            {tab === "channels" ? (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  {data.members.map((c) => (
                    <ChannelCardView key={c.id} c={c} window={data.compactWindow} now={now} />
                  ))}
                  <button type="button" onClick={() => setNewOpen(true)} className="flex min-h-[96px] items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground">
                    <Plus className="size-4" /> New channel
                  </button>
                </div>
              </>
            ) : null}
            {tab === "skills" ? (
              data.skills.length === 0 ? (
                <Empty>No space skills. Skills in the space's skills folder are given to every channel in it.</Empty>
              ) : (
                <Panel>
                  {data.skills.map((s) => (
                    <Row key={s.id} to={`/library/skill?source=space&id=${encodeURIComponent(s.id)}`}>
                      <Sparkles className="size-4 shrink-0 text-logo" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{s.name}</div>
                        <div className="line-clamp-2 text-[12px] text-muted-foreground">{s.description}</div>
                      </div>
                    </Row>
                  ))}
                </Panel>
              )
            ) : null}
            {tab === "memory" ? (
              data.memory ? (
                <>
                  <Section title="Mission control memory" action={<Link className="text-xs text-muted-foreground underline" to={`/c/${data.memory.channelId}?tab=memory`}>all files</Link>}>
                    <Panel className="p-4 text-[13.5px]">{data.memory.index ? <TranscriptMarkdown text={data.memory.index} /> : <span className="text-muted-foreground">No MEMORY.md yet.</span>}</Panel>
                  </Section>
                  {data.memory.summary ? (
                    <Section title="Rolling summary">
                      <Panel className="max-h-[60vh] overflow-y-auto p-4 text-[13px]">
                        <TranscriptMarkdown text={data.memory.summary} />
                      </Panel>
                    </Section>
                  ) : null}
                </>
              ) : (
                <Empty>No mission control memory yet.</Empty>
              )
            ) : null}
            {tab === "activity" ? <RunList runs={data.activity} showChannel now={now} empty="No runs in this space yet." /> : null}
          </>
        )}
      </Body>
      {data?.missionControlChannelId ? (
        <Composer
          channelId={data.missionControlChannelId}
          placeholder={`Ask ${data.name} mission control…`}
          disabledReason={data.apiReachable ? null : "Sending opens after the next bot deploy"}
        />
      ) : null}
      <NewChannelDialog open={newOpen} onOpenChange={setNewOpen} categoryId={spaceId} />
    </Page>
  )
}

function SpaceNotes({ space, onSaved }: { space: SpaceView; onSaved: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const long = (space.notes?.text?.length ?? 0) > 900
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(space.notes?.text ?? "")
  const [base, setBase] = useState(space.notes?.hash ?? "")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [diff, setDiff] = useState<{ version: string; rows: { t: string; text: string }[] } | null>(null)
  useEffect(() => {
    if (!editing) {
      setText(space.notes?.text ?? "")
      setBase(space.notes?.hash ?? "")
    }
  }, [space.notes?.text, space.notes?.hash, editing])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await ncPost<{ ok: boolean; changed: boolean; hash: string }>(`/space/${space.id}/notes`, { text, baseHash: base })
      setEditing(false)
      setBase(r.hash)
      setMsg({ tone: "ok", text: r.changed ? "Saved. The previous version is kept in history." : "No changes." })
      invalidateNc(`/space/${space.id}`)
      onSaved()
    } catch (e) {
      if (e instanceof NcError && e.status === 409) {
        const cur = (e.body?.current ?? null) as { text: string; hash: string } | null
        setMsg({ tone: "err", text: "Someone (or neo-claw) changed SPACE.md while you were editing. Your text is still here; copy it, then reload to merge." })
        if (cur) setBase(cur.hash)
      } else setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const showDiff = async (version: string) => {
    try {
      const res = await fetch(`/api/nc/space/${space.id}/history/${encodeURIComponent(version)}`, { credentials: "same-origin" })
      const body = (await res.json()) as { rows: { t: string; text: string }[] }
      setDiff({ version, rows: body.rows ?? [] })
    } catch {
      setDiff(null)
    }
  }

  return (
    <Section
      title="SPACE.md"
      action={
        !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted">
            <Pencil className="size-3" /> Edit
          </button>
        ) : null
      }
    >
      {msg ? <div className={cn("mb-2 rounded-lg px-3 py-2 text-xs", msg.tone === "ok" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400")}>{msg.text}</div> : null}
      {editing ? (
        <Panel>
          <textarea value={text} onChange={(e) => setText(e.target.value)} className="block min-h-[50vh] w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none" spellCheck={false} />
          <div className="flex justify-end gap-2 border-t border-border p-2">
            <button type="button" className="h-9 rounded-full px-4 text-sm text-muted-foreground hover:bg-muted" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" disabled={busy} className="h-9 rounded-full bg-foreground px-4 text-sm text-background disabled:opacity-50" onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </Panel>
      ) : (
        <Panel className="relative p-4 text-[13.5px]">
          {space.notes?.text?.trim() ? (
            <>
              <div className={cn(!expanded && long && "max-h-[22rem] overflow-hidden")}>
                <TranscriptMarkdown text={space.notes.text} />
              </div>
              {long && !expanded ? (
                <div className="absolute inset-x-0 bottom-0 flex justify-center rounded-b-xl bg-gradient-to-t from-card from-40% to-card/0 pb-3 pt-12">
                  <button type="button" onClick={() => setExpanded(true)} className="rounded-full border border-border bg-card px-3 py-1 text-xs shadow-sm hover:bg-muted">
                    Show all of SPACE.md
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">No SPACE.md yet. It's the shared brief every channel in the space reads.</span>
          )}
        </Panel>
      )}
      {space.history.length > 0 && !editing ? (
        <details className="mt-2 px-1 text-xs text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-1 py-1">
            <History className="size-3" /> {space.history.length} earlier versions
          </summary>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {space.history.slice(0, 20).map((h) => (
              <button key={h} type="button" onClick={() => void showDiff(h)} className={cn("rounded-full border border-border px-2 py-0.5 font-mono text-[11px] hover:bg-muted", diff?.version === h && "bg-muted text-foreground")}>
                {h.replace(/^SPACE\.md\./, "")}
              </button>
            ))}
          </div>
          {diff ? (
            <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-card font-mono text-[11.5px] leading-5">
              <div className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">Changes since {diff.version.replace(/^SPACE\.md\./, "")} (red: that version, green: now)</div>
              {diff.rows.map((r, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre px-3",
                    r.t === "add" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                    r.t === "del" && "bg-red-500/10 text-red-800 dark:text-red-300",
                    r.t === "gap" && "bg-muted/50 italic text-muted-foreground"
                  )}
                >
                  {r.t === "add" ? "+ " : r.t === "del" ? "- " : "  "}
                  {r.text}
                </div>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </Section>
  )
}

function SpaceActions({ space }: { space: SpaceView }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!space.missionControlChannelId) return null
  const backfill = async () => {
    if (!window.confirm(`Have mission control read every channel in ${space.name} and rewrite SPACE.md? This runs a full turn.`)) return
    setBusy(true)
    setErr(null)
    try {
      const r = await ncPost<{ chatId: string | null }>(`/space/${space.id}/action`, { action: "backfill" })
      if (r.chatId) navigate(`/chat/${r.chatId}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Space tools">
      <Panel>
        <Row onClick={busy || !space.apiReachable ? undefined : () => void backfill()} className={!space.apiReachable ? "opacity-60" : undefined}>
          <History className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px]">{busy ? "Starting…" : "Rebuild SPACE.md from history"}</div>
            <div className="text-[12px] text-muted-foreground">{space.apiReachable ? "Mission control reads every channel and refreshes the brief (/space backfill)." : "Needs neo-claw's web API (next bot deploy)."}</div>
          </div>
        </Row>
      </Panel>
      {err ? <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{err}</div> : null}
    </Section>
  )
}
