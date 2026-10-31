import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight, Folder, Globe, Hash, Layers, Package, Sparkles } from "lucide-react"
import { cn } from "../lib/utils"
import type { ChanRef, ChannelSkills, LocalSkill, SkillLink, SkillTree } from "./api"
import { Empty, Pill } from "./ui"

/**
 * Library → Skills: every skill once, at the level it comes from.
 * Global → bundled → spaces (their skills, then member channels with their
 * own skills) → channels outside a space → copies shared across places.
 */

const skillHref = (l: SkillLink) => `/library/skill?source=${l.source}&id=${encodeURIComponent(l.id)}`

interface Filter {
  needle: string
  match: (...text: (string | null | undefined)[]) => boolean
}

function makeFilter(q: string): Filter {
  const needle = q.trim().toLowerCase()
  return { needle, match: (...text) => !needle || text.some((t) => (t ?? "").toLowerCase().includes(needle)) }
}

/** A collapsible level of the tree. `forceOpen` wins while a filter is active. */
function Node({
  title,
  icon,
  count,
  badges,
  note,
  defaultOpen = false,
  forceOpen = false,
  depth = 0,
  children,
}: {
  title: ReactNode
  icon?: ReactNode
  count?: number | string
  badges?: ReactNode
  note?: ReactNode
  defaultOpen?: boolean
  forceOpen?: boolean
  depth?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const shown = forceOpen || open
  return (
    <div className={cn(depth === 0 ? "mb-3 overflow-hidden rounded-xl border border-border bg-card" : "border-t border-border")}>
      <button
        type="button"
        onClick={() => setOpen(!shown)}
        className={cn("flex w-full items-center gap-2 py-2.5 pr-3 text-left hover:bg-muted/50", depth === 0 ? "pl-3" : "")}
        style={depth ? { paddingLeft: 12 + depth * 16 } : undefined}
        aria-expanded={shown}
      >
        {shown ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        {icon}
        <span className={cn("min-w-0 truncate", depth === 0 ? "text-[14px] font-semibold" : "text-[13.5px] font-medium")}>{title}</span>
        {badges}
        {count != null ? <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span> : null}
      </button>
      {shown ? (
        <div>
          {note ? (
            <p className="border-t border-border px-3 py-2 text-[12px] leading-snug text-muted-foreground" style={{ paddingLeft: 12 + (depth + 1) * 16 }}>
              {note}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** "in 54 chats", expandable to links to each chat. */
function Holders({ holders, label }: { holders: ChanRef[]; label?: string }) {
  const [open, setOpen] = useState(false)
  if (!holders.length) return <span className="text-[11px] text-muted-foreground/80">{label ?? "in no chats"}</span>
  return (
    <span className="contents">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
        {label ?? `in ${holders.length} chat${holders.length === 1 ? "" : "s"}`}
      </button>
      {open ? (
        <span className="mt-1 flex w-full flex-wrap gap-1">
          {holders.map((h) => (
            <Link key={h.id} to={`/c/${h.id}`} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              #{h.name}
            </Link>
          ))}
        </span>
      ) : null}
    </span>
  )
}

function SkillRow({ name, description, link, depth, extra }: { name: string; description: string; link: SkillLink; depth: number; extra?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-t border-border py-2 pr-3" style={{ paddingLeft: 12 + depth * 16 }}>
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <Link to={skillHref(link)} className="block min-w-0 hover:underline">
          <span className="text-[13.5px] font-medium">{name}</span>
        </Link>
        {description ? <div className="line-clamp-1 text-[12px] leading-snug text-muted-foreground">{description}</div> : null}
        {extra ? <div className="mt-0.5 flex flex-wrap items-center gap-1.5">{extra}</div> : null}
      </div>
    </div>
  )
}

function LocalRow({ s, depth, showHolders }: { s: LocalSkill; depth: number; showHolders: boolean }) {
  return (
    <SkillRow
      name={s.name}
      description={s.description}
      link={s.link}
      depth={depth}
      extra={
        <>
          {s.shadows ? <Pill className="bg-amber-500/10 text-amber-800 dark:text-amber-300" title="A chat-local skill with this name takes the place of the shared one in that chat">local copy (shadows {s.shadows})</Pill> : null}
          {s.variant ? <Pill title={s.hash ? `SKILL.md ${s.hash}` : undefined}>variant {s.variant.index} of {s.variant.of}</Pill> : null}
          {showHolders ? <Holders holders={s.holders} label={`identical copy in ${s.holders.length} chats`} /> : null}
        </>
      }
    />
  )
}

function ChannelNode({ c, depth, f, showEmpty }: { c: ChannelSkills; depth: number; f: Filter; showEmpty: boolean }) {
  const skills = c.skills.filter((s) => f.match(s.name, s.description, c.name))
  if (!skills.length && !(showEmpty && !f.needle)) return null
  return (
    <Node
      depth={depth}
      title={`#${c.name}`}
      icon={<Hash className="size-3.5 shrink-0 text-muted-foreground" />}
      count={skills.length}
      badges={
        <>
          {c.isMission ? <Pill>mission control</Pill> : null}
          {c.remoteHost ? <Pill title="Runs on another host; its skills there aren't listed">{c.remoteHost}</Pill> : null}
        </>
      }
      forceOpen={Boolean(f.needle)}
    >
      {skills.length ? skills.map((s) => <LocalRow key={`${s.name}:${s.hash}`} s={s} depth={depth + 1} showHolders={false} />) : <p className="border-t border-border py-2 text-[12px] text-muted-foreground" style={{ paddingLeft: 12 + (depth + 1) * 16 }}>No skills of its own.</p>}
    </Node>
  )
}

export function SkillTreeView({ tree, q, showEmpty }: { tree: SkillTree; q: string; showEmpty: boolean }) {
  const f = makeFilter(q)
  const open = Boolean(f.needle)

  const global = tree.global.filter((s) => f.match(s.name, s.description))
  const globalOwn = global.filter((s) => !s.synced)
  const globalSynced = global.filter((s) => s.synced)

  const bundled = tree.bundled.filter((s) => f.match(s.name, s.description))
  const defaultOn = bundled.filter((s) => s.defaultOn)
  const optIn = bundled.filter((s) => !s.defaultOn)
  const retired = tree.retired.filter((s) => f.match(s.name, s.description))

  const spaces = tree.spaces
    .map((sp) => {
      const spaceHit = f.needle && f.match(sp.name)
      const skills = sp.skills.filter((s) => spaceHit || f.match(s.name, s.description))
      const shared = sp.shared.filter((s) => spaceHit || f.match(s.name, s.description))
      const channelsWithHits = sp.channels.filter((c) => c.skills.some((s) => spaceHit || f.match(s.name, s.description, c.name)))
      const has = skills.length + shared.length + channelsWithHits.length > 0
      return { sp, skills, shared, has, spaceHit, localCount: sp.channels.reduce((n, c) => n + c.skills.length, 0) + sp.shared.length }
    })
    .filter((x) => (f.needle ? x.has : x.has || showEmpty))

  const noSpace = tree.noSpace.filter((c) => (f.needle ? c.skills.some((s) => f.match(s.name, s.description, c.name)) : showEmpty || c.skills.length > 0))
  const shared = tree.shared.filter((s) => f.match(s.name, s.description))
  const nothing = !global.length && !bundled.length && !retired.length && !spaces.length && !noSpace.length && !shared.length

  return (
    <div>
      {nothing ? <Empty>No skills match.</Empty> : null}

      {global.length ? (
        <Node
          title="Global"
          icon={<Globe className="size-4 shrink-0 text-logo" />}
          count={global.length}
          note={`~/.claude/skills: in effect in every chat on this host (${tree.localChats} local chats).`}
          defaultOpen
          forceOpen={open}
        >
          {globalOwn.map((s) => (
            <SkillRow key={s.link.id} name={s.name} description={s.description} link={s.link} depth={1} />
          ))}
          {globalSynced.length ? (
            <Node depth={1} title="Synced from claude.ai" icon={<Folder className="size-3.5 shrink-0 text-muted-foreground" />} count={globalSynced.length} forceOpen={open}>
              {globalSynced.map((s) => (
                <SkillRow key={s.link.id} name={s.name} description={s.description} link={s.link} depth={2} />
              ))}
            </Node>
          ) : null}
        </Node>
      ) : null}

      {bundled.length || retired.length ? (
        <Node
          title="Bundled with neo-claw"
          icon={<Package className="size-4 shrink-0 text-logo" />}
          count={bundled.length + retired.length}
          note="Shipped in neo-claw's skills/ folder and copied into each chat that uses them. Counts are the chats holding an unedited copy."
          defaultOpen
          forceOpen={open}
        >
          {defaultOn.length ? (
            <Node depth={1} title="On by default" count={defaultOn.length} defaultOpen forceOpen={open}>
              {defaultOn.map((s) => (
                <SkillRow key={s.name} name={s.name} description={s.description} link={s.link} depth={2} extra={<><Holders holders={s.holders} />{s.edited ? <span className="text-[11px] text-amber-700 dark:text-amber-400">+{s.edited} edited cop{s.edited === 1 ? "y" : "ies"} (shown as local copies below)</span> : null}</>} />
              ))}
            </Node>
          ) : null}
          {optIn.length ? (
            <Node depth={1} title="Opt-in" count={optIn.length} forceOpen={open}>
              {optIn.map((s) => (
                <SkillRow key={s.name} name={s.name} description={s.description} link={s.link} depth={2} extra={<><Holders holders={s.holders} />{s.edited ? <span className="text-[11px] text-amber-700 dark:text-amber-400">+{s.edited} edited</span> : null}</>} />
              ))}
            </Node>
          ) : null}
          {retired.length ? (
            <Node
              depth={1}
              title="Retired"
              count={retired.length}
              note="No longer shipped. Unedited copies stay in chats until neo-claw prunes them the next time each chat runs."
              forceOpen={open}
            >
              {retired.map((s) => (
                <SkillRow key={s.name} name={s.name} description={s.description} link={s.link} depth={2} extra={<Holders holders={s.holders} label={`still in ${s.holders.length} chats`} />} />
              ))}
            </Node>
          ) : null}
        </Node>
      ) : null}

      {spaces.length ? (
        <Node title="Spaces" icon={<Layers className="size-4 shrink-0 text-logo" />} count={spaces.length} defaultOpen forceOpen={open}>
          {spaces.map(({ sp, skills, shared: spShared, spaceHit, localCount }) => (
            <Node
              key={sp.id}
              depth={1}
              title={sp.name}
              count={sp.skills.length + localCount}
              badges={!sp.enabled ? <Pill>off</Pill> : null}
              note={
                <Link to={`/spaces/${sp.id}`} className="hover:text-foreground hover:underline">
                  Open the {sp.name} space
                </Link>
              }
              forceOpen={open}
            >
              {skills.map((s) => (
                <SkillRow
                  key={s.link.id}
                  name={s.name}
                  description={s.description}
                  link={s.link}
                  depth={2}
                  extra={<span className="text-[11px] text-muted-foreground/80">{sp.enabled ? `space skill · synced into ${s.copies} chat${s.copies === 1 ? "" : "s"}` : "space is off: not in effect"}</span>}
                />
              ))}
              {spShared.map((s) => (
                <LocalRow key={`${s.name}:${s.hash}`} s={s} depth={2} showHolders />
              ))}
              {sp.channels.map((c) => (
                <ChannelNode key={c.id} c={c} depth={2} f={spaceHit ? makeFilter("") : f} showEmpty={showEmpty} />
              ))}
            </Node>
          ))}
        </Node>
      ) : null}

      {noSpace.length ? (
        <Node title="No space" icon={<Hash className="size-4 shrink-0 text-muted-foreground" />} count={noSpace.length} note={showEmpty ? "Channels outside any space." : "Channels outside any space that have skills of their own."} defaultOpen forceOpen={open}>
          {noSpace.map((c) => (
            <ChannelNode key={c.id} c={c} depth={1} f={f} showEmpty={showEmpty} />
          ))}
        </Node>
      ) : null}

      {shared.length ? (
        <Node
          title="Copied across chats"
          icon={<Sparkles className="size-4 shrink-0 text-muted-foreground" />}
          count={shared.length}
          note="Chat-local skills with identical content in chats from different spaces: shown once."
          defaultOpen
          forceOpen={open}
        >
          {shared.map((s) => (
            <LocalRow key={`${s.name}:${s.hash}`} s={s} depth={1} showHolders />
          ))}
        </Node>
      ) : null}

      {tree.remoteSkillHosts.length ? <p className="px-1 text-[12px] text-muted-foreground">Skills on {tree.remoteSkillHosts.join(", ")} live on that host and aren't listed here.</p> : null}
    </div>
  )
}
