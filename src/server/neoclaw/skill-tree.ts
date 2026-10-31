/**
 * The Library's skill tree: every skill once, at the level it comes from.
 *
 * neo-claw copies skills into each chat (`<chat>/.claude/skills/`): bundled
 * skills (tracked in .bundled-managed.json) and space skills (.space-managed.json).
 * Listing every copy showed the same skill dozens of times. Here each copy is
 * classified first, and only what a chat has on its own is shown under it:
 *
 *   global   ~/.claude/skills, in effect in every local chat
 *   bundled  neo-claw's skills/ (default-on vs opt-in), with the chats holding
 *            a pristine copy; "retired" ones are no longer shipped but still
 *            sit in chats that haven't run since
 *   spaces   each space's skills, then member channels with their own skills
 *   noSpace  channels outside any space that have their own skills
 *   shared   identical chat-local copies held by chats in different places
 *
 * Chat-local copies with the same name and SKILL.md hash collapse into one row,
 * placed at the narrowest level holding all of them (one chat, one space, or
 * the top). Different hashes for one name are variants. A chat copy named like
 * a global/bundled/space skill is flagged as shadowing it.
 *
 * Pure: Stack.skillInventory() reads the disk, this only arranges.
 */

export interface InvSkill {
  id: string
  name: string
  description: string
  hash: string | null
}

export interface InvCopy {
  name: string
  description: string
  hash: string | null
  /** Content of `.installed-sha256`, if neo-claw installed this copy. */
  marker: string | null
}

export interface InvChat {
  id: string
  name: string
  remoteHost: string | null
  categoryId: string | null
  copies: InvCopy[]
  /** null: no manifest file. */
  spaceManaged: string[] | null
  bundledManaged: string[] | null
}

export interface InvSpace {
  id: string
  name: string
  enabled: boolean
  missionControlChannelId: string | null
  skills: InvSkill[]
}

export interface SkillInventory {
  global: InvSkill[]
  bundled: InvSkill[]
  /** enabledSkills from neo-claw.config.json, plus skill-author (always on). */
  defaultOn: string[]
  /** skills/.shipped-hashes.json: every SKILL.md hash neo-claw ever shipped, by name. */
  shippedHashes: Record<string, string[]>
  spaces: InvSpace[]
  chats: InvChat[]
  remoteSkillHosts: string[]
}

export interface ChanRef {
  id: string
  name: string
}

export interface SkillLink {
  source: "global" | "bundled" | "space" | "channel"
  id: string
}

export interface LocalSkill {
  name: string
  description: string
  link: SkillLink
  hash: string | null
  /** e.g. "bundled service-management" when a chat copy reuses that name. */
  shadows: string | null
  /** Set when chats hold different versions of this name. */
  variant: { index: number; of: number } | null
  /** Chats holding this exact copy (1 when it sits under a single chat). */
  holders: ChanRef[]
}

export interface ChannelSkills {
  id: string
  name: string
  remoteHost: string | null
  isMission: boolean
  skills: LocalSkill[]
}

export interface SpaceSkills {
  id: string
  name: string
  enabled: boolean
  skills: { name: string; description: string; link: SkillLink; copies: number }[]
  /** Identical local copies held by several channels of this space. */
  shared: LocalSkill[]
  channels: ChannelSkills[]
}

export interface BundledRow {
  name: string
  description: string
  link: SkillLink
  defaultOn: boolean
  holders: ChanRef[]
  /** Chats whose copy was edited: shown under those chats as local copies. */
  edited: number
}

export interface SkillTree {
  global: { name: string; description: string; link: SkillLink; synced: boolean }[]
  localChats: number
  bundled: BundledRow[]
  retired: { name: string; description: string; link: SkillLink; holders: ChanRef[] }[]
  spaces: SpaceSkills[]
  noSpace: ChannelSkills[]
  shared: LocalSkill[]
  remoteSkillHosts: string[]
  counts: {
    /** Rows the tree shows (each skill once, each local copy group once). */
    rows: number
    /** Skill folders found inside chats. */
    copies: number
    bundledCopies: number
    retiredCopies: number
    spaceCopies: number
    localCopies: number
  }
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

export function buildSkillTree(inv: SkillInventory): SkillTree {
  const bundledByName = new Map(inv.bundled.map((s) => [s.name, s]))
  const globalNames = new Set(inv.global.map((s) => s.name))
  const defaultOn = new Set(inv.defaultOn)
  const spaceById = new Map(inv.spaces.map((s) => [s.id, s]))
  const chatRef = (c: InvChat): ChanRef => ({ id: c.id, name: c.name })

  const bundledHolders = new Map<string, ChanRef[]>()
  const editedBundled = new Map<string, number>()
  const retired = new Map<string, { description: string; link: SkillLink; holders: ChanRef[] }>()
  const spaceCopies = new Map<string, number>() // `${spaceId}/${name}`
  const local: { chat: InvChat; copy: InvCopy }[] = []
  let copies = 0
  let bundledCopies = 0
  let retiredCopies = 0
  let spaceCopyCount = 0

  for (const chat of inv.chats) {
    const spaceOwned = new Set(chat.spaceManaged ?? [])
    const bundledOwned = new Set(chat.bundledManaged ?? [])
    for (const copy of chat.copies) {
      copies++
      if (spaceOwned.has(copy.name)) {
        spaceCopyCount++
        if (chat.categoryId) spaceCopies.set(`${chat.categoryId}/${copy.name}`, (spaceCopies.get(`${chat.categoryId}/${copy.name}`) ?? 0) + 1)
        continue
      }
      const current = bundledByName.get(copy.name)
      // Same test as neo-claw's isPristineCopy: install marker, current or any shipped version.
      const pristine =
        copy.hash != null &&
        ((copy.marker != null && copy.marker === copy.hash) ||
          (current?.hash != null && current.hash === copy.hash) ||
          (inv.shippedHashes[copy.name] ?? []).includes(copy.hash))
      if (bundledOwned.has(copy.name) || pristine) {
        if (current) {
          bundledCopies++
          const list = bundledHolders.get(copy.name) ?? []
          list.push(chatRef(chat))
          bundledHolders.set(copy.name, list)
        } else {
          retiredCopies++
          const r = retired.get(copy.name) ?? { description: copy.description, link: { source: "channel" as const, id: `${chat.id}/${copy.name}` }, holders: [] }
          r.holders.push(chatRef(chat))
          retired.set(copy.name, r)
        }
        continue
      }
      if (current) editedBundled.set(copy.name, (editedBundled.get(copy.name) ?? 0) + 1)
      local.push({ chat, copy })
    }
  }

  // Group chat-local copies by name, then by content.
  const byNameHash = new Map<string, Map<string, { chat: InvChat; copy: InvCopy }[]>>()
  for (const l of local) {
    const hashes = byNameHash.get(l.copy.name) ?? new Map()
    const key = l.copy.hash ?? `none:${l.chat.id}`
    hashes.set(key, [...(hashes.get(key) ?? []), l])
    byNameHash.set(l.copy.name, hashes)
  }

  const chatSkills = new Map<string, LocalSkill[]>()
  const spaceShared = new Map<string, LocalSkill[]>()
  const topShared: LocalSkill[] = []
  for (const [name, hashes] of byNameHash) {
    // Bigger groups first, so "variant 1" is the most common version.
    const groups = [...hashes.values()].sort((a, b) => b.length - a.length || a[0]!.chat.name.localeCompare(b[0]!.chat.name))
    groups.forEach((group, i) => {
      const first = group[0]!
      const spaceIds = new Set(group.map((g) => g.chat.categoryId && spaceById.has(g.chat.categoryId) ? g.chat.categoryId : null))
      const onlySpace = spaceIds.size === 1 ? [...spaceIds][0] : null
      const shadows = globalNames.has(name)
        ? `global ${name}`
        : bundledByName.has(name)
          ? `bundled ${name}`
          : onlySpace && spaceById.get(onlySpace)!.skills.some((s) => s.name === name)
            ? `space ${spaceById.get(onlySpace)!.name}'s ${name}`
            : null
      const row: LocalSkill = {
        name,
        description: first.copy.description,
        link: { source: "channel", id: `${first.chat.id}/${name}` },
        hash: first.copy.hash ? first.copy.hash.slice(0, 8) : null,
        shadows,
        variant: groups.length > 1 ? { index: i + 1, of: groups.length } : null,
        holders: group.map((g) => chatRef(g.chat)).sort(byName),
      }
      if (group.length === 1) chatSkills.set(first.chat.id, [...(chatSkills.get(first.chat.id) ?? []), row])
      else if (onlySpace) spaceShared.set(onlySpace, [...(spaceShared.get(onlySpace) ?? []), row])
      else topShared.push(row)
    })
  }

  const channelNode = (c: InvChat, missionId: string | null): ChannelSkills => ({
    id: c.id,
    name: c.name,
    remoteHost: c.remoteHost,
    isMission: missionId === c.id,
    skills: (chatSkills.get(c.id) ?? []).sort(byName),
  })

  const spaces: SpaceSkills[] = inv.spaces
    .map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      skills: s.skills
        .map((k) => ({ name: k.name, description: k.description, link: { source: "space" as const, id: k.id }, copies: spaceCopies.get(`${s.id}/${k.name}`) ?? 0 }))
        .sort(byName),
      shared: (spaceShared.get(s.id) ?? []).sort(byName),
      channels: inv.chats
        .filter((c) => c.categoryId === s.id)
        .map((c) => channelNode(c, s.missionControlChannelId))
        .sort((a, b) => Number(b.isMission) - Number(a.isMission) || a.name.localeCompare(b.name)),
    }))
    .sort(byName)

  const noSpace = inv.chats
    .filter((c) => !c.categoryId || !spaceById.has(c.categoryId))
    .map((c) => channelNode(c, null))
    .sort(byName)

  const bundled: BundledRow[] = inv.bundled
    .map((s) => ({
      name: s.name,
      description: s.description,
      link: { source: "bundled" as const, id: s.id },
      defaultOn: s.name === "skill-author" || defaultOn.has(s.name),
      holders: (bundledHolders.get(s.name) ?? []).sort(byName),
      edited: editedBundled.get(s.name) ?? 0,
    }))
    .sort((a, b) => Number(b.defaultOn) - Number(a.defaultOn) || a.name.localeCompare(b.name))

  const retiredRows = [...retired.entries()].map(([name, r]) => ({ name, ...r, holders: r.holders.sort(byName) })).sort(byName)

  const localRows =
    [...chatSkills.values()].reduce((n, l) => n + l.length, 0) + [...spaceShared.values()].reduce((n, l) => n + l.length, 0) + topShared.length
  return {
    global: inv.global.map((s) => ({ name: s.name, description: s.description, link: { source: "global" as const, id: s.id }, synced: s.id.startsWith("synced/") })).sort(byName),
    localChats: inv.chats.filter((c) => !c.remoteHost).length,
    bundled,
    retired: retiredRows,
    spaces,
    noSpace,
    shared: topShared.sort(byName),
    remoteSkillHosts: inv.remoteSkillHosts,
    counts: {
      rows: inv.global.length + bundled.length + retiredRows.length + spaces.reduce((n, s) => n + s.skills.length, 0) + localRows,
      copies,
      bundledCopies,
      retiredCopies,
      spaceCopies: spaceCopyCount,
      localCopies: local.length,
    },
  }
}
