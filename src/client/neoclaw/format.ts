export function timeAgo(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return "never"
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function duration(ms: number | null | undefined) {
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

export function tokens(n: number | null | undefined) {
  if (n == null) return null
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function cost(usd: number | null | undefined) {
  if (usd == null) return null
  return usd < 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 100 ? 2 : 0)}`
}

export function bytes(n: number | null | undefined) {
  if (n == null) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

export function clock(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return sameDay ? t : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${t}`
}

/** Channel names learned from /tree, for turning Discord mentions into words. */
export const channelNames = new Map<string, string>()

/** `<#id>` → `#name`, `<@id>` → `@someone`, `<@&id>` → `@role`, `<:emoji:id>` → `:emoji:`. Never a raw id. */
export function mentions(s: string) {
  return s
    .replace(/<#(\d{15,22})>/g, (_, id: string) => `#${channelNames.get(id) ?? "channel"}`)
    .replace(/<@!?(\d{15,22})>/g, "@someone")
    .replace(/<@&(\d{15,22})>/g, "@role")
    .replace(/<a?(:\w+:)\d{15,22}>/g, "$1")
}

export function oneLine(s: string | null | undefined, max = 140) {
  if (!s) return ""
  const t = mentions(s).replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
