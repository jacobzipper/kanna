import { useState } from "react"
import { invalidateNc, ncPost, useNc, type SettingValue, type SettingsView } from "./api"
import { ErrorBox, Loading, Notice, Panel, Pill } from "./ui"
import { cn } from "../lib/utils"

/**
 * neo-claw's per-chat settings (the /model, /effort and /settings keys).
 * Global scope edits the defaults; channel scope edits one chat's overrides.
 * Writes go through neo-claw's /api/settings (via Kanna, which adds who made
 * them). Before the bot has that endpoint, everything is shown read-only.
 */

const LABEL: Record<string, { label: string; hint: string }> = {
  model: { label: "Model", hint: "alias (opus, sonnet) or a full model id" },
  effort: { label: "Effort", hint: "thinking effort" },
  maxTurns: { label: "Max turns", hint: "0 = unlimited" },
  progressCard: { label: "Progress card", hint: "live tool-progress card in Discord" },
  voiceMode: { label: "Voice mode", hint: "reply with voice messages" },
  slashPassthrough: { label: "Slash passthrough", hint: "send bare /commands to Claude Code" },
  workflows: { label: "Workflows", hint: "standing OK for the Workflow tool" },
  tables: { label: "Tables", hint: "how markdown tables render" },
}
const BOOL_KEYS = new Set(["progressCard", "voiceMode", "slashPassthrough", "workflows"])

function show(key: string, v: SettingValue): string {
  if (v == null) return ""
  if (typeof v === "boolean") return v ? "on" : "off"
  if (key === "maxTurns" && Number(v) === 0) return "unlimited"
  return String(v)
}

export function SettingsEditor({ scope, channelId }: { scope: "global" | "channel"; channelId?: string }) {
  const { data, error, reload } = useNc<SettingsView>("/settings")
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)

  if (error && !data) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return <Loading />

  const own = scope === "channel" ? (data.channels[channelId ?? ""] ?? {}) : data.global
  const overrides = data.keys.filter((k) => own[k] != null)
  const editable = data.editable

  const post = async (path: string, body: Record<string, unknown>, label: string) => {
    setBusy(label)
    setMsg(null)
    try {
      await ncPost(path, { scope, ...(scope === "channel" ? { channelId } : {}), ...body })
      invalidateNc("/settings", "/channel/", "/library")
      setMsg({ tone: "ok", text: `${label}: saved.` })
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  const set = (key: string, value: string | null) => post("/settings", { key, value }, value == null ? `${LABEL[key]?.label ?? key} back to default` : `${LABEL[key]?.label ?? key}`)

  return (
    <div>
      {!editable ? <Notice tone="warn">{data.reason ?? "Settings are read-only right now."} Change them in Discord with /model, /effort and /settings meanwhile.</Notice> : null}
      <Panel>
        {data.keys.map((key) => {
          const mine = own[key]
          const global = data.global[key]
          const effective = mine ?? (scope === "channel" ? global : undefined)
          const source = mine != null ? (scope === "channel" ? "this chat" : "global default") : scope === "channel" && global != null ? "global default" : "built-in"
          const shown = effective != null ? show(key, effective) : data.fallbacks[key] ?? "default"
          return (
            <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2.5 last:border-b-0">
              <div className="min-w-[9rem] flex-1">
                <div className="text-[13.5px] font-medium">{LABEL[key]?.label ?? key}</div>
                <div className="text-[11.5px] text-muted-foreground">{LABEL[key]?.hint}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-medium tabular-nums">{shown}</span>
                <Pill className={cn(mine != null && "bg-foreground/10 font-medium text-foreground")}>{source}</Pill>
              </div>
              <div className="flex w-full items-center gap-1.5 sm:w-auto">
                <Control keyName={key} value={mine} data={data} disabled={!editable || busy != null} onSet={(v) => set(key, v)} />
                {mine != null ? (
                  <button type="button" disabled={!editable || busy != null} onClick={() => set(key, null)} className="h-8 shrink-0 rounded-lg border border-border px-2.5 text-[12px] hover:bg-muted disabled:opacity-50" title={scope === "channel" ? "Drop this chat's override and follow the global default" : "Drop the global default and follow the built-in one"}>
                    Use default
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </Panel>
      <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
        <button
          type="button"
          disabled={!editable || busy != null || overrides.length === 0}
          onClick={() => {
            if (window.confirm(scope === "channel" ? "Clear all of this chat's overrides? It will follow the global defaults." : "Clear all global defaults? Chats without overrides will use the built-in defaults.")) void post("/settings/reset", {}, "Reset")
          }}
          className="h-8 rounded-lg border border-border px-3 text-[12.5px] hover:bg-muted disabled:opacity-50"
        >
          {scope === "channel" ? `Reset all overrides (${overrides.length})` : `Reset all defaults (${overrides.length})`}
        </button>
        {busy ? <span className="text-[12px] text-muted-foreground">Saving {busy}…</span> : null}
        {msg ? <span className={cn("text-[12px]", msg.tone === "err" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>{msg.text}</span> : null}
      </div>
      <p className="mt-2 px-1 text-[11.5px] text-muted-foreground">
        {scope === "channel" ? "Each key: this chat's override, else the global default, else neo-claw's built-in default. " : "Chats without their own override use these. "}
        New values apply from the next message.
      </p>
    </div>
  )
}

function Control({ keyName, value, data, disabled, onSet }: { keyName: string; value: SettingValue; data: SettingsView; disabled: boolean; onSet: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cls = "h-8 rounded-lg border border-border bg-card px-2 text-[12.5px] outline-none focus:border-foreground/30 disabled:opacity-50"
  const options = BOOL_KEYS.has(keyName) ? ["on", "off"] : keyName === "effort" ? data.effortLevels : keyName === "tables" ? data.tableModes : null
  if (options) {
    const current = value == null ? "" : show(keyName, value)
    return (
      <select value={current} disabled={disabled} onChange={(e) => e.target.value && onSet(e.target.value)} className={cn(cls, "min-w-[7.5rem]")} aria-label={keyName}>
        <option value="">{value == null ? "set…" : "—"}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  const text = draft ?? (value == null ? "" : String(value))
  const dirty = draft != null && draft.trim() !== (value == null ? "" : String(value))
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (dirty && draft!.trim()) {
          onSet(draft!.trim())
          setDraft(null)
        }
      }}
    >
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        inputMode={keyName === "maxTurns" ? "numeric" : undefined}
        placeholder={keyName === "maxTurns" ? "e.g. 100" : "e.g. opus"}
        className={cn(cls, keyName === "maxTurns" ? "w-24" : "w-40")}
        aria-label={keyName}
      />
      <button type="submit" disabled={disabled || !dirty} className="h-8 rounded-lg bg-foreground px-2.5 text-[12px] text-background disabled:opacity-40">
        Set
      </button>
    </form>
  )
}
