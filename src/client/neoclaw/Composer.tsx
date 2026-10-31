import { useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowUp, Loader2 } from "lucide-react"
import { cn } from "../lib/utils"
import { useNeoClawStore } from "../stores/neoClawStore"
import { invalidateNc, ncPost } from "./api"

/**
 * Message box that starts a neo-claw turn in a channel (or one of its
 * threads) and then opens the live session transcript.
 */
export function Composer({
  channelId,
  threadId,
  placeholder,
  disabledReason,
  sticky = true,
  autoFocus,
  className,
  banner,
}: {
  channelId: string
  threadId?: string
  placeholder?: string
  disabledReason?: string | null
  sticky?: boolean
  autoFocus?: boolean
  className?: string
  /** Shown above the box, e.g. which thread the message goes to. */
  banner?: ReactNode
}) {
  const navigate = useNavigate()
  const user = useNeoClawStore((s) => s.user)
  const mirror = useNeoClawStore((s) => s.mirror)
  const setMirror = useNeoClawStore((s) => s.setMirror)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = async () => {
    const body = text.trim()
    if (!body || busy || disabledReason) return
    setBusy(true)
    setError(null)
    try {
      const r = await ncPost<{ chatId: string | null; steered?: boolean }>("/turn", { channelId, threadId, text: body, mirror })
      setText("")
      invalidateNc("/channel/" + channelId, "/home", "/tree")
      if (r.chatId) navigate(`/chat/${r.chatId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const grow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  return (
    <div
      className={cn(
        sticky && "sticky bottom-0 z-10 bg-gradient-to-t from-background from-80% to-background/0 pt-4",
        sticky && "pb-[calc(env(safe-area-inset-bottom)+4.5rem)] md:pb-4",
        className
      )}
    >
      <div className="mx-auto max-w-5xl px-3 md:px-6">
        {banner ? <div className="mb-1.5 rounded-xl border border-border bg-card px-3 py-1.5 shadow-sm">{banner}</div> : null}
        {error ? <div className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        <div className={cn("rounded-2xl border border-border bg-card shadow-sm focus-within:border-foreground/30", disabledReason && "bg-muted")}>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            autoFocus={autoFocus}
            disabled={Boolean(disabledReason) || busy}
            onChange={(e) => {
              setText(e.target.value)
              grow()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={disabledReason ?? placeholder ?? "Message neo-claw…"}
            className="block max-h-[220px] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70 md:text-sm"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            {user ? (
              <label className="flex cursor-pointer select-none items-center gap-1.5 pl-2 text-[11px] text-muted-foreground" title="Also post your message (and the reply) in the Discord channel, as you">
                <input type="checkbox" className="size-3.5 accent-current" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
                Post in Discord as {user.displayName}
              </label>
            ) : null}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!text.trim() || busy || Boolean(disabledReason)}
              className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30"
              aria-label="Send"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
