import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { BookOpen, ChevronDown, ChevronRight, FileText, Plug, Settings2, Sparkles, Webhook } from "lucide-react"
import { TranscriptMarkdown } from "../../components/messages/shared"
import { cn } from "../../lib/utils"
import { ncPost, useNc } from "../api"
import { Body, Empty, ErrorBox, Loading, Page, PageHeader, Panel, Pill, Row, Section, Tabs, useTab } from "../ui"

interface LibSkill {
  id: string
  name: string
  description: string
  source: string
  effect: string
  spaceId: string | null
  spaceName: string | null
  channelId: string | null
  channelName: string | null
  channelCount: number
}
interface LibHook {
  event: string
  matcher: string
  command: string
  timeout: number | null
  script: string | null
  description: string | null
  source: string | null
}
interface LibMcp {
  key: string
  scope: string
  name: string
  type: string
  command: string | null
  args: string[]
  envKeys: string[]
  headerKeys: string[]
  channels: string[]
  channelNames: string[]
  canList: boolean
}
interface LibraryView {
  skills: LibSkill[]
  remoteSkillHosts: string[]
  hooks: LibHook[]
  envKeys: string[]
  compact: { tokens: number; from: string }
  permissions: { defaultMode: string | null; allow: string[]; deny: string[] }
  channelGlobal: Record<string, string | undefined>
  mcp: LibMcp[]
}

const TABS = ["skills", "hooks", "mcp", "settings"] as const
const SOURCE_LABEL: Record<string, string> = {
  global: "Everywhere on this host",
  bundled: "Bundled with neo-claw",
  space: "Space skills",
  channel: "Channel-only skills",
}

/** Hide the long synced-store prefix ("synced/<uuid>_<uuid>/name"). */
function skillLabel(s: { name: string }) {
  return s.name
}

export function LibraryPage() {
  const { data, error, reload } = useNc<LibraryView>("/library")
  const [tab, setTab] = useTab(TABS, "skills")
  const [q, setQ] = useState("")
  const groups = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    const list = needle ? data.skills.filter((s) => `${s.name} ${s.description} ${s.spaceName ?? ""} ${s.channelName ?? ""}`.toLowerCase().includes(needle)) : data.skills
    return ["space", "global", "bundled", "channel"]
      .map((src) => ({ src, items: list.filter((s) => s.source === src).sort((a, b) => a.name.localeCompare(b.name)) }))
      .filter((g) => g.items.length > 0)
  }, [data, q])

  return (
    <Page>
      <PageHeader title="Library" subtitle="Skills, hooks and MCP servers neo-claw runs with" icon={<BookOpen className="size-5 text-logo" />}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "skills", label: "Skills", count: data?.skills.length },
            { id: "hooks", label: "Hooks", count: data?.hooks.length },
            { id: "mcp", label: "MCP", count: data?.mcp.length },
            { id: "settings", label: "Settings" },
          ]}
        />
      </PageHeader>
      <Body>
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : (
          <>
            {tab === "skills" ? (
              <>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter skills"
                  className="mb-4 h-10 w-full rounded-xl border border-border bg-card px-3 text-[14px] outline-none focus:border-foreground/30"
                />
                {groups.length === 0 ? <Empty>No skills match.</Empty> : null}
                {groups.map((g) => (
                  <Section key={g.src} title={`${SOURCE_LABEL[g.src] ?? g.src} · ${g.items.length}`}>
                    <Panel>
                      {g.items.map((s) => (
                        <Row key={`${s.source}:${s.id}`} to={`/library/skill?source=${s.source}&id=${encodeURIComponent(s.id)}`}>
                          <Sparkles className={cn("size-4 shrink-0", s.source === "space" ? "text-logo" : "text-muted-foreground")} />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-[13.5px] font-medium">{skillLabel(s)}</span>
                              {s.spaceName ? <Pill>{s.spaceName}</Pill> : null}
                              {s.channelName ? <Pill>#{s.channelName}</Pill> : null}
                            </div>
                            <div className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">{s.description}</div>
                            {s.source !== "global" ? <div className="mt-0.5 text-[11px] text-muted-foreground/80">{s.effect}</div> : null}
                          </div>
                        </Row>
                      ))}
                    </Panel>
                  </Section>
                ))}
                {data.remoteSkillHosts.length ? <p className="px-1 text-[12px] text-muted-foreground">Skills on {data.remoteSkillHosts.join(", ")} live on that host and aren't listed here.</p> : null}
              </>
            ) : null}

            {tab === "hooks" ? (
              data.hooks.length === 0 ? (
                <Empty>No Claude Code hooks configured.</Empty>
              ) : (
                <div className="space-y-2">
                  {data.hooks.map((h, i) => (
                    <HookCard key={i} h={h} />
                  ))}
                </div>
              )
            ) : null}

            {tab === "mcp" ? (
              data.mcp.length === 0 ? (
                <Empty>No MCP servers configured.</Empty>
              ) : (
                <div className="space-y-2">
                  {data.mcp.map((m) => (
                    <McpCard key={m.key} m={m} />
                  ))}
                </div>
              )
            ) : null}

            {tab === "settings" ? (
              <>
                <Section title="Channel defaults">
                  <Panel>
                    {[
                      ["Model", data.channelGlobal.model ?? "default"],
                      ["Effort", data.channelGlobal.effort ?? "default"],
                      ["Max turns", data.channelGlobal.maxTurns && data.channelGlobal.maxTurns !== "0" ? data.channelGlobal.maxTurns : "unlimited"],
                      ["Auto-compact at", `${Math.round(data.compact.tokens / 1000)}k tokens`],
                      ["Permission mode", data.permissions.defaultMode ?? "default"],
                    ].map(([k, v]) => (
                      <Row key={k}>
                        <span className="flex-1 text-[13.5px] text-muted-foreground">{k}</span>
                        <span className="text-[13.5px] font-medium">{v}</span>
                      </Row>
                    ))}
                  </Panel>
                </Section>
                <Section title="Environment (names only)">
                  <div className="flex flex-wrap gap-1.5">
                    {data.envKeys.length ? data.envKeys.map((k) => <Pill key={k} className="font-mono">{k}</Pill>) : <span className="text-[13px] text-muted-foreground">None</span>}
                  </div>
                </Section>
                {data.permissions.allow.length || data.permissions.deny.length ? (
                  <Section title="Permission rules">
                    <div className="flex flex-wrap gap-1.5">
                      {data.permissions.allow.map((k) => (
                        <Pill key={`a${k}`} className="font-mono">
                          allow {k}
                        </Pill>
                      ))}
                      {data.permissions.deny.map((k) => (
                        <Pill key={`d${k}`} className="font-mono text-red-600">
                          deny {k}
                        </Pill>
                      ))}
                    </div>
                  </Section>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </Body>
    </Page>
  )
}

function HookCard({ h }: { h: LibHook }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/40">
        <Webhook className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill>{h.event}</Pill>
            {h.matcher ? <Pill className="font-mono">{h.matcher}</Pill> : null}
            {h.timeout ? <span className="text-[11px] text-muted-foreground">{h.timeout}s</span> : null}
          </div>
          <div className="mt-1 text-[13px] leading-snug">{h.description ?? <span className="font-mono text-[12px] text-muted-foreground">{h.command}</span>}</div>
        </div>
        {h.source ? open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" /> : null}
      </button>
      {open && h.source ? (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 truncate font-mono text-[11px] text-muted-foreground">{h.script ?? h.command}</div>
          <pre className="max-h-[50vh] overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-[11.5px] leading-relaxed">{h.source}</pre>
        </div>
      ) : null}
    </div>
  )
}

function McpCard({ m }: { m: LibMcp }) {
  const [tools, setTools] = useState<{ name: string; description: string }[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await ncPost<{ tools?: { name: string; description: string }[]; error?: string }>(`/mcp/${m.key}/tools`, {})
      if (r.error) setErr(r.error)
      else setTools(r.tools ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Plug className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{m.name}</span>
        <Pill>{m.type}</Pill>
        <Pill>{m.scope}</Pill>
      </div>
      <div className="mt-1 overflow-x-auto whitespace-nowrap font-mono text-[11.5px] text-muted-foreground">{[m.command, ...m.args].filter(Boolean).join(" ")}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {m.channelNames.length ? <span>in {m.channelNames.map((c) => `#${c}`).join(", ")}</span> : <span>{m.scope === "user" ? "every chat" : "this project"}</span>}
        {m.envKeys.length ? <span>· env {m.envKeys.join(", ")}</span> : null}
        {m.headerKeys.length ? <span>· headers {m.headerKeys.join(", ")}</span> : null}
        {m.canList && !tools ? (
          <button type="button" onClick={list} disabled={busy} className="ml-auto rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-foreground hover:bg-muted disabled:opacity-50">
            {busy ? "Listing…" : "List tools"}
          </button>
        ) : null}
      </div>
      {err ? <p className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{err}</p> : null}
      {tools ? (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {tools.length === 0 ? <p className="text-[12px] text-muted-foreground">No tools.</p> : null}
          {tools.map((t) => (
            <div key={t.name} className="text-[12px]">
              <span className="font-mono font-medium">{t.name}</span> <span className="text-muted-foreground">{t.description.split("\n")[0]}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface SkillView {
  id: string
  name: string
  description: string
  source: string
  effect: string
  spaceName: string | null
  channelName: string | null
  channels: { id: string; name: string }[]
  files: string[]
  truncatedTree: boolean
  file: string
  text: string | null
  truncated: boolean
}

export function SkillPage() {
  const [search, setSearch] = useSearchParams()
  const source = search.get("source") ?? ""
  const id = search.get("id") ?? ""
  const file = search.get("file")
  const qs = `source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}${file ? `&file=${encodeURIComponent(file)}` : ""}`
  const { data, error, reload } = useNc<SkillView>(`/skill?${qs}`)
  const pick = (f: string) => {
    const next = new URLSearchParams(search)
    if (f === "SKILL.md") next.delete("file")
    else next.set("file", f)
    setSearch(next, { replace: true })
  }
  const isMd = (data?.file ?? "").endsWith(".md")
  return (
    <Page>
      <PageHeader back="/library" title={data?.name ?? "Skill"} subtitle={data ? `${SOURCE_LABEL[data.source] ?? data.source}${data.spaceName ? ` · ${data.spaceName}` : ""}${data.channelName ? ` · #${data.channelName}` : ""}` : undefined} icon={<Sparkles className="size-5 text-logo" />} />
      <Body>
        {error && !data ? <ErrorBox error={error} onRetry={reload} /> : null}
        {!data ? (
          error ? null : <Loading />
        ) : (
          <>
            <p className="mb-2 px-1 text-[13.5px] leading-snug">{data.description}</p>
            <p className="mb-4 px-1 text-[12px] text-muted-foreground">
              <Settings2 className="mr-1 inline size-3.5" />
              {data.effect}
            </p>
            {data.channels.length ? (
              <div className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {data.channels.map((c) => (
                  <Link key={c.id} to={`/c/${c.id}`} className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground">
                    #{c.name}
                  </Link>
                ))}
              </div>
            ) : null}
            {data.files.length > 1 ? (
              <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {data.files.map((f) => (
                  <button key={f} type="button" onClick={() => pick(f)} className={cn("flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 font-mono text-[11.5px]", f === data.file ? "bg-foreground text-background" : "hover:bg-muted")}>
                    <FileText className="size-3" /> {f}
                  </button>
                ))}
              </div>
            ) : null}
            <Panel className="p-4">
              {data.text == null ? (
                <span className="text-[13px] text-muted-foreground">This file can't be shown here.</span>
              ) : isMd ? (
                <div className="text-[13.5px]">
                  <TranscriptMarkdown text={data.text.replace(/^---\n[\s\S]*?\n---\n/, "")} />
                </div>
              ) : (
                <pre className="overflow-auto font-mono text-[12px] leading-relaxed">{data.text}</pre>
              )}
              {data.truncated ? <p className="mt-2 text-[11px] text-muted-foreground">Truncated.</p> : null}
            </Panel>
          </>
        )}
      </Body>
    </Page>
  )
}
