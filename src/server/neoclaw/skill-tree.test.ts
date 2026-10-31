import { describe, expect, test } from "bun:test"
import { buildSkillTree, type InvChat, type SkillInventory } from "./skill-tree"

const chat = (id: string, categoryId: string | null, copies: InvChat["copies"], extra: Partial<InvChat> = {}): InvChat => ({
  id,
  name: `chan-${id}`,
  remoteHost: null,
  categoryId,
  copies,
  spaceManaged: null,
  bundledManaged: null,
  ...extra,
})
const copy = (name: string, hash: string, marker: string | null = null) => ({ name, description: `${name} skill`, hash, marker })

function inventory(): SkillInventory {
  return {
    global: [
      { id: "deploy", name: "deploy", description: "", hash: "g1" },
      { id: "synced/abc/pdf", name: "pdf", description: "", hash: "g2" },
    ],
    bundled: [
      { id: "service-management", name: "service-management", description: "", hash: "b-sm" },
      { id: "media-gen", name: "media-gen", description: "", hash: "b-mg" },
      { id: "skill-author", name: "skill-author", description: "", hash: "b-sa" },
    ],
    defaultOn: ["service-management"],
    shippedHashes: { "web-scraping": ["old-ws"] },
    spaces: [{ id: "S1", name: "stake", enabled: true, missionControlChannelId: "11", skills: [{ id: "game-art", name: "game-art", description: "", hash: "s-ga" }] }],
    chats: [
      // In the space: pristine bundled copies, a space copy, a retired copy, one local skill.
      chat("11", "S1", [copy("service-management", "b-sm"), copy("game-art", "s-ga"), copy("web-scraping", "old-ws"), copy("notes", "n1")], { spaceManaged: ["game-art"] }),
      chat("12", "S1", [copy("service-management", "x", "x"), copy("game-art", "s-ga"), copy("web-scraping", "old-ws"), copy("helper", "h1")], { spaceManaged: ["game-art"] }),
      chat("13", "S1", [copy("helper", "h1")]),
      // Outside spaces: an edited bundled copy (shadows it), identical to one in chat 14.
      chat("21", null, [copy("service-management", "edited"), copy("web-scraping", "old-ws")]),
      chat("22", null, [copy("service-management", "edited")]),
      chat("23", null, [copy("service-management", "edited-2")]),
      chat("24", null, []),
    ],
    remoteSkillHosts: ["b2u-vps"],
  }
}

describe("buildSkillTree", () => {
  const t = buildSkillTree(inventory())

  test("each source skill appears once", () => {
    expect(t.global.map((g) => [g.name, g.synced])).toEqual([
      ["deploy", false],
      ["pdf", true],
    ])
    expect(t.bundled.map((b) => b.name)).toEqual(["service-management", "skill-author", "media-gen"])
    expect(t.spaces[0]!.skills).toEqual([{ name: "game-art", description: "", link: { source: "space", id: "game-art" }, copies: 2 }])
  })

  test("pristine copies count as bundled holders, not chat skills", () => {
    const sm = t.bundled.find((b) => b.name === "service-management")!
    expect(sm.defaultOn).toBe(true)
    expect(sm.holders.map((h) => h.id)).toEqual(["11", "12"]) // 12 matches its install marker
    expect(sm.edited).toBe(3)
    expect(t.bundled.find((b) => b.name === "skill-author")!.defaultOn).toBe(true)
    expect(t.bundled.find((b) => b.name === "media-gen")!.defaultOn).toBe(false)
  })

  test("copies of skills neo-claw no longer ships are grouped as retired", () => {
    expect(t.retired.map((r) => [r.name, r.holders.length])).toEqual([["web-scraping", 3]])
  })

  test("chat-local skills sit at the narrowest level that holds them", () => {
    const space = t.spaces[0]!
    const mc = space.channels[0]!
    expect(mc.id).toBe("11")
    expect(mc.isMission).toBe(true)
    expect(mc.skills.map((s) => s.name)).toEqual(["notes"])
    // "helper" is identical in two chats of the same space: one shared row there.
    expect(space.shared.map((s) => [s.name, s.holders.map((h) => h.id)])).toEqual([["helper", ["12", "13"]]])
    expect(space.channels.find((c) => c.id === "12")!.skills).toEqual([])
  })

  test("edited bundled copies are flagged as shadowing and split into variants", () => {
    const shared = t.shared.find((s) => s.name === "service-management")!
    expect(shared.holders.map((h) => h.id)).toEqual(["21", "22"])
    expect(shared.shadows).toBe("bundled service-management")
    expect(shared.variant).toEqual({ index: 1, of: 2 })
    const lone = t.noSpace.find((c) => c.id === "23")!.skills[0]!
    expect(lone.variant).toEqual({ index: 2, of: 2 })
    expect(lone.link).toEqual({ source: "channel", id: "23/service-management" })
  })

  test("counts", () => {
    expect(t.counts).toEqual({ rows: 2 + 3 + 1 + 1 + 4, copies: 13, bundledCopies: 2, retiredCopies: 3, spaceCopies: 2, localCopies: 6 })
    expect(t.noSpace.map((c) => c.id)).toEqual(["21", "22", "23", "24"])
  })
})
