import { create } from "zustand"

/**
 * neo-claw mode, client side. `user` is set when the server runs as a
 * neo-claw console (it answers /api/neoclaw/me); `mirror` is whether a sent
 * message is also posted in the Discord channel (remembered per browser).
 */

export interface NeoClawUser {
  username: string
  displayName: string
  discordId: string
}

interface NeoClawState {
  user: NeoClawUser | null
  mirror: boolean
  setMirror: (mirror: boolean) => void
}

const MIRROR_KEY = "neoclaw.mirror"

function readMirror() {
  if (typeof window === "undefined") return true
  return window.localStorage.getItem(MIRROR_KEY) !== "0"
}

export const useNeoClawStore = create<NeoClawState>()((set) => ({
  user: null,
  mirror: readMirror(),
  setMirror: (mirror) => {
    if (typeof window !== "undefined") window.localStorage.setItem(MIRROR_KEY, mirror ? "1" : "0")
    set({ mirror })
  },
}))

let probed = false
export function probeNeoClaw() {
  if (probed || typeof window === "undefined") return
  probed = true
  void fetch("/api/neoclaw/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return
      const body = (await res.json()) as NeoClawUser | null
      if (body && typeof body.discordId === "string") useNeoClawStore.setState({ user: body })
    })
    .catch(() => undefined)
}

/** Extra fields for chat.send / message.enqueue in neo-claw mode. */
export function neoClawSendFields(): { neoClawMirror?: boolean } {
  const { user, mirror } = useNeoClawStore.getState()
  return user ? { neoClawMirror: mirror } : {}
}
