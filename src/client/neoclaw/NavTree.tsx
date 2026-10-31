import { memo, useMemo, useState } from "react"
import { Link, NavLink, useLocation } from "react-router-dom"
import { ChevronDown, FolderOpen, Settings, ChevronRight, Hash, Library, LayoutGrid, Megaphone, MessagesSquare, Orbit, PanelLeftClose, PanelLeftOpen, Plus, Search, Server, Sparkles, X } from "lucide-react"
import { cn } from "../lib/utils"
import type { CategoryNode, ChannelNode, Tree } from "./api"
import { NewChannelDialog } from "./dialogs"
import { mentions } from "./format"
import { StatusDot } from "./ui"

const COLLAPSE_KEY = "neoclaw.collapsed"
const RECENT_THREAD_MS = 3 * 86400_000

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>
  } catch {
    return {}
  }
}

function useCollapsed() {
  const [state, setState] = useState(readCollapsed)
  const toggle = (id: string, dflt = false) => {
    setState((s) => {
      const next = { ...s, [id]: !(s[id] ?? dflt) }
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next))
      return next
    })
  }
  return { isCollapsed: (id: string, dflt = false) => state[id] ?? dflt, toggle }
}

function channelIcon(c: ChannelNode) {
  if (c.isMission) return Orbit
  if (c.kind === "forum") return MessagesSquare
  if (c.kind === "announcement") return Megaphone
  return Hash
}

const ChannelRow = memo(function ChannelRow({ c, active, activeThread, dense }: { c: ChannelNode; active: boolean; activeThread: string | null; dense: boolean }) {
  const Icon = channelIcon(c)
  const now = Date.now()
  const threads = c.threads.filter((t) => !t.archived && (t.lastActivityAt ?? 0) > now - RECENT_THREAD_MS).slice(0, active ? 5 : 2)
  const status = c.running ? "running" : c.queued > 0 ? "queued" : null
  return (
    <div>
      <Link
        to={`/c/${c.id}`}
        className={cn(
          "group flex items-center gap-2 rounded-md px-2 text-[14px] md:text-[13.5px] transition-colors",
          dense ? "h-8" : "h-10 md:h-8",
          active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          !c.hasHistory && !active && "opacity-70"
        )}
      >
        <Icon className={cn("size-4 shrink-0", c.isMission ? "text-logo" : "opacity-70")} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {c.remoteHost ? <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{c.remoteHost}</span> : null}
        {status ? <StatusDot status={status} /> : null}
      </Link>
      {threads.length > 0 ? (
        <div className="ml-[17px] border-l border-border pl-2">
          {threads.map((t) => (
            <Link
              key={t.id}
              to={`/c/${c.id}?tab=conversations&thread=${t.id}`}
              className={cn(
                "flex h-8 md:h-7 items-center gap-1.5 rounded-md px-2 text-[13px] md:text-[12.5px] transition-colors",
                activeThread === t.id ? "bg-muted text-foreground" : "text-muted-foreground/90 hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <span className="min-w-0 flex-1 truncate">{mentions(t.name)}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
})

function CategoryBlock({
  cat,
  collapsed,
  onToggle,
  activeChannel,
  activeThread,
  onNewChannel,
  dense,
}: {
  cat: CategoryNode
  collapsed: boolean
  onToggle: () => void
  activeChannel: string | null
  activeThread: string | null
  onNewChannel: (categoryId: string) => void
  dense: boolean
}) {
  const running = cat.channels.filter((c) => c.running).length
  // Collapsed still shows the open channel and anything running, like Discord.
  const shown = collapsed ? cat.channels.filter((c) => c.id === activeChannel || c.running || c.queued > 0) : cat.channels
  return (
    <div className="mt-3">
      <div className="group flex items-center gap-1 pr-1">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
          {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
          <span className="truncate">{cat.name}</span>
          {collapsed && running ? <StatusDot status="running" className="ml-1" /> : null}
          <span className="ml-auto pl-1 text-[10px] font-normal normal-case opacity-0 group-hover:opacity-100">{cat.channels.length}</span>
        </button>
        <button
          type="button"
          onClick={() => onNewChannel(cat.id)}
          className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
          title={`New channel in ${cat.name}`}
          aria-label={`New channel in ${cat.name}`}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="space-y-px">
        {shown.map((c) => (
          <ChannelRow key={c.id} c={c} active={c.id === activeChannel} activeThread={activeThread} dense={dense} />
        ))}
      </div>
    </div>
  )
}

function filterTree(tree: Tree, q: string): Tree {
  if (!q) return tree
  const needle = q.toLowerCase()
  const match = (c: ChannelNode) => c.name.toLowerCase().includes(needle) || c.threads.some((t) => t.name.toLowerCase().includes(needle))
  const cat = (c: CategoryNode) => (c.name.toLowerCase().includes(needle) ? c : { ...c, channels: c.channels.filter(match) })
  return {
    ...tree,
    spaces: tree.spaces.map(cat).filter((c) => c.channels.length > 0 || c.name.toLowerCase().includes(needle)),
    categories: tree.categories.map(cat).filter((c) => c.channels.length > 0),
    uncategorized: tree.uncategorized.filter(match),
    gone: tree.gone.filter(match),
  }
}

/** Spaces and Discord categories as a collapsible tree. */
export function ChannelTree({ tree, sections = ["spaces", "channels"], dense = false }: { tree: Tree; sections?: ("spaces" | "channels")[]; dense?: boolean }) {
  const loc = useLocation()
  const m = /^\/c\/(\d+)/.exec(loc.pathname)
  const activeChannel = m?.[1] ?? null
  const activeThread = new URLSearchParams(loc.search).get("thread")
  const spaceMatch = /^\/spaces\/(\d+)/.exec(loc.pathname)
  const { isCollapsed, toggle } = useCollapsed()
  const [q, setQ] = useState("")
  const [newIn, setNewIn] = useState<string | null | undefined>(undefined)
  const t = useMemo(() => filterTree(tree, q.trim()), [tree, q])
  const forceOpen = q.trim().length > 0

  return (
    <div>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a channel or thread"
          className="h-9 md:h-8 w-full rounded-lg border border-border bg-background pl-8 pr-7 text-[14px] md:text-[13px] outline-none focus:border-foreground/30"
        />
        {q ? (
          <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground" onClick={() => setQ("")} aria-label="Clear">
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {sections.includes("spaces") && t.spaces.length > 0 ? (
        <div className="mb-1">
          <div className="flex items-center justify-between px-1 pt-2 pb-1">
            <Link to="/spaces" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
              Spaces
            </Link>
          </div>
          {t.spaces.map((s) => {
            const collapsed = !forceOpen && isCollapsed(`space:${s.id}`, false)
            const open = spaceMatch?.[1] === s.id
            const running = s.channels.some((c) => c.running)
            return (
              <div key={s.id} className="mb-1">
                <div className={cn("group flex items-center rounded-md", open ? "bg-muted" : "hover:bg-muted/60")}>
                  <button type="button" onClick={() => toggle(`space:${s.id}`)} className="flex h-9 md:h-8 w-7 shrink-0 items-center justify-center text-muted-foreground" aria-label={collapsed ? "Expand" : "Collapse"}>
                    {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  </button>
                  <Link to={`/spaces/${s.id}`} className="flex h-9 md:h-8 min-w-0 flex-1 items-center gap-2 pr-2 text-[14px] md:text-[13.5px] font-medium">
                    <LayoutGrid className="size-4 shrink-0 text-logo" />
                    <span className="truncate">{s.name}</span>
                    {running ? <StatusDot status="running" className="ml-auto" /> : null}
                  </Link>
                </div>
                {!collapsed ? (
                  <div className="ml-3.5 space-y-px border-l border-border pl-1.5">
                    {s.channels.map((c) => (
                      <ChannelRow key={c.id} c={c} active={c.id === activeChannel} activeThread={activeThread} dense={dense} />
                    ))}
                    <button type="button" onClick={() => setNewIn(s.id)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[12.5px] text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground">
                      <Plus className="size-3.5" /> New channel
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      {sections.includes("channels") ? (
        <>
          {sections.includes("spaces") ? <div className="px-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{tree.guildName ?? "Discord"}</div> : null}
          {t.categories.map((c) => (
            <CategoryBlock
              key={c.id}
              cat={c}
              collapsed={!forceOpen && isCollapsed(`cat:${c.id}`, false)}
              onToggle={() => toggle(`cat:${c.id}`)}
              activeChannel={activeChannel}
              activeThread={activeThread}
              onNewChannel={(id) => setNewIn(id)}
              dense={dense}
            />
          ))}
          {t.uncategorized.length > 0 ? (
            <CategoryBlock
              cat={{ id: "_none", name: "No category", guildId: null, position: 0, isSpace: false, spaceEnabled: false, missionControlChannelId: null, channels: t.uncategorized }}
              collapsed={!forceOpen && isCollapsed("cat:_none", false)}
              onToggle={() => toggle("cat:_none")}
              activeChannel={activeChannel}
              activeThread={activeThread}
              onNewChannel={() => setNewIn(null)}
              dense={dense}
            />
          ) : null}
          {t.gone.length > 0 ? (
            <div className="mt-3">
              <button type="button" onClick={() => toggle("cat:_gone", true)} className="flex w-full items-center gap-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 hover:text-foreground">
                {!forceOpen && isCollapsed("cat:_gone", true) ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                Deleted from Discord
              </button>
              {forceOpen || !isCollapsed("cat:_gone", true)
                ? t.gone.map((c) => <ChannelRow key={c.id} c={c} active={c.id === activeChannel} activeThread={activeThread} dense={dense} />)
                : null}
            </div>
          ) : null}
        </>
      ) : null}
      {tree.directory === "cache" ? (
        <p className="mt-4 px-1 text-[11px] leading-snug text-muted-foreground">Discord didn't answer; names and order come from neo-claw's last-seen index.</p>
      ) : null}
      <NewChannelDialog open={newIn !== undefined} onOpenChange={(v) => !v && setNewIn(undefined)} categoryId={newIn ?? null} />
    </div>
  )
}

const TOP = [
  { to: "/home", label: "Home", icon: Sparkles },
  { to: "/library", label: "Library", icon: Library },
  { to: "/infra", label: "Infra", icon: Server },
]

/** Desktop left rail. */
export function NeoSidebar({ tree, onCollapse }: { tree: Tree | undefined; onCollapse: () => void }) {
  return (
    <aside className="hidden md:flex h-[100dvh] w-[272px] shrink-0 flex-col border-r border-border bg-muted/20">
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <Orbit className="size-5 text-logo" />
        <span className="flex-1 truncate text-[15px] font-semibold">{tree?.guildName ?? "neo-claw"}</span>
        <button type="button" onClick={onCollapse} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title="Hide sidebar">
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      <nav className="space-y-px px-2 pt-2">
        {TOP.map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            className={({ isActive }) =>
              cn("flex h-8 items-center gap-2.5 rounded-md px-2 text-[13.5px] transition-colors", isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")
            }
          >
            <i.icon className="size-4" />
            {i.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-3">{tree ? <ChannelTree tree={tree} dense /> : <div className="px-2 py-6 text-xs text-muted-foreground">Loading channels…</div>}</div>
      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <NavLink to="/projects" className={({ isActive }) => cn("flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground", isActive && "bg-muted text-foreground")}>
          <FolderOpen className="size-3.5" /> Local projects
        </NavLink>
        <NavLink to="/settings/general" className={({ isActive }) => cn("flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground", isActive && "bg-muted text-foreground")} title="Settings">
          <Settings className="size-4" />
        </NavLink>
      </div>
    </aside>
  )
}

/** Desktop rail when the sidebar is collapsed. */
export function NeoRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="hidden md:flex h-[100dvh] w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/20 py-3">
      <button type="button" onClick={onExpand} className="mb-2 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title="Show sidebar">
        <PanelLeftOpen className="size-4" />
      </button>
      {[...TOP, { to: "/spaces", label: "Spaces", icon: LayoutGrid }, { to: "/channels", label: "Channels", icon: Hash }].map((i) => (
        <NavLink key={i.to} to={i.to} title={i.label} className={({ isActive }) => cn("flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", isActive && "bg-muted text-foreground")}>
          <i.icon className="size-4" />
        </NavLink>
      ))}
    </aside>
  )
}
