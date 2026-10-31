import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogGhostButton, DialogHeader, DialogPrimaryButton, DialogTitle } from "../components/ui/dialog"
import { invalidateNc, ncPost, NcError, useNc, type Tree } from "./api"

const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-[15px] md:text-sm outline-none focus:border-foreground/40"

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 100)
}

export function NewChannelDialog({ open, onOpenChange, categoryId }: { open: boolean; onOpenChange: (v: boolean) => void; categoryId?: string | null }) {
  const navigate = useNavigate()
  const { data: tree } = useNc<Tree>(open ? "/tree" : null)
  const [cat, setCat] = useState(categoryId ?? "")
  const [name, setName] = useState("")
  const [topic, setTopic] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setCat(categoryId ?? "")
      setName("")
      setTopic("")
      setError(null)
    }
  }, [open, categoryId])
  const cats = tree ? [...tree.spaces, ...tree.categories] : []
  const chosen = cats.find((c) => c.id === cat)
  const submit = async () => {
    if (!cat || !slug(name) || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await ncPost<{ channelId: string }>("/channel", { categoryId: cat, name: slug(name), topic })
      invalidateNc("/tree", "/home", "/space/", "/category/")
      onOpenChange(false)
      navigate(`/c/${r.channelId}`)
    } catch (e) {
      const status = e instanceof NcError ? e.status : 0
      setError(
        status === 403
          ? "The bot doesn't have Manage Channels in this server. Give its role that permission in Discord, or create the channel there."
          : status === 503 || status === 502
            ? `${e instanceof Error ? e.message : String(e)}. Creating channels goes through neo-claw's web API, which isn't reachable right now.`
            : e instanceof Error
              ? e.message
              : String(e)
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="max-md:top-auto max-md:bottom-0 max-md:translate-y-0 max-md:rounded-b-none max-md:max-w-none">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
          <DialogDescription>Created in Discord by the bot{chosen?.isSpace ? `, and joins the ${chosen.name} space` : ""}.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Category</span>
            <select className={field} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="" disabled>
                Choose a category…
              </option>
              {tree?.spaces.length ? (
                <optgroup label="Spaces">
                  {tree.spaces.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="Categories">
                {tree?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <div className="flex items-center rounded-lg border border-border bg-background pl-3 focus-within:border-foreground/40">
              <span className="text-muted-foreground">#</span>
              <input className="w-full bg-transparent px-1.5 py-2 text-[15px] md:text-sm outline-none" value={name} onChange={(e) => setName(e.target.value)} placeholder="new-channel" autoFocus />
            </div>
            {name && slug(name) !== name ? <span className="text-[11px] text-muted-foreground">Will be #{slug(name)}</span> : null}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Topic (optional)</span>
            <input className={field} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What this channel is for" />
          </label>
          {error ? <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        </DialogBody>
        <DialogFooter className="pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
          <DialogGhostButton onClick={() => onOpenChange(false)}>Cancel</DialogGhostButton>
          <DialogPrimaryButton disabled={!cat || !slug(name) || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create channel"}
          </DialogPrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function NewConversationDialog({ open, onOpenChange, channelId, channelName }: { open: boolean; onOpenChange: (v: boolean) => void; channelId: string; channelName: string }) {
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setName("")
      setText("")
      setError(null)
    }
  }, [open])
  const submit = async () => {
    if ((!name.trim() && !text.trim()) || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await ncPost<{ threadId: string; chatId: string | null }>("/thread", { channelId, name: name.trim(), text: text.trim() })
      invalidateNc("/tree", "/channel/" + channelId, "/home")
      onOpenChange(false)
      if (r.chatId) navigate(`/chat/${r.chatId}`)
      else navigate(`/c/${channelId}?tab=conversations`)
    } catch (e) {
      const status = e instanceof NcError ? e.status : 0
      setError(
        status === 403
          ? "The bot can't create threads here (it needs Create Public Threads)."
          : status === 503 || status === 502
            ? `${e instanceof Error ? e.message : String(e)}. Starting conversations goes through neo-claw's web API, which isn't reachable right now.`
            : e instanceof Error
              ? e.message
              : String(e)
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="max-md:top-auto max-md:bottom-0 max-md:translate-y-0 max-md:rounded-b-none max-md:max-w-none">
        <DialogHeader>
          <DialogTitle>New conversation in #{channelName}</DialogTitle>
          <DialogDescription>Starts a Discord thread. It shares #{channelName}'s session and memory; replies land in the thread.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Title</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Plan the launch" autoFocus />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">First message (optional)</span>
            <textarea className={`${field} min-h-[96px] resize-y`} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should neo-claw do?" />
          </label>
          {error ? <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        </DialogBody>
        <DialogFooter className="pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
          <DialogGhostButton onClick={() => onOpenChange(false)}>Cancel</DialogGhostButton>
          <DialogPrimaryButton disabled={(!name.trim() && !text.trim()) || busy} onClick={() => void submit()}>
            {busy ? "Starting…" : text.trim() ? "Start and send" : "Start conversation"}
          </DialogPrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
