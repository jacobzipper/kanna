import { useEffect } from "react"
import { probeNeoClaw, useNeoClawStore } from "../../stores/neoClawStore"

/** "Also post in Discord" switch above the composer; neo-claw mode only. */
export function NeoClawMirrorToggle() {
  const user = useNeoClawStore((state) => state.user)
  const mirror = useNeoClawStore((state) => state.mirror)
  const setMirror = useNeoClawStore((state) => state.setMirror)
  useEffect(() => {
    probeNeoClaw()
  }, [])
  if (!user) return null
  return (
    <div className="flex items-center justify-end gap-2 px-1 pb-1 text-xs text-muted-foreground">
      <label className="flex cursor-pointer select-none items-center gap-1.5" title="When on, your message is posted in the Discord channel as you (via the bot) and the reply is posted there too.">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 cursor-pointer accent-current"
          checked={mirror}
          onChange={(event) => setMirror(event.target.checked)}
        />
        Mirror to Discord
      </label>
      <span className="opacity-70">as {user.displayName}</span>
    </div>
  )
}
