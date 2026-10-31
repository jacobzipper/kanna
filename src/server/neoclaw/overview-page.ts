import type { NeoClawOverview } from "./bridge"

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Plain server-rendered status page: channels, context size, deploy queue, link-outs. */
export function renderOverviewPage(o: NeoClawOverview): Response {
  const rows = o.channels
    .map((c) => {
      const state = c.running ? "running" : c.queued > 0 ? `queued (${c.queued})` : "idle"
      const ctx = c.contextTokens != null ? `${Math.round(c.contextTokens / 1000)}k / 200k` : "–"
      const compact = c.lastCompactAt ? ago(c.lastCompactAt) : "–"
      return `<tr class="${c.running ? "run" : ""}"><td>${c.projectId ? `<a href="/project/${esc(c.projectId)}">${esc(c.name)}</a>` : esc(c.name)}</td><td>${esc(state)}</td><td>${esc(c.remoteHost ?? "local")}</td><td>${esc(ctx)}</td><td>${esc(compact)}</td><td><code>${esc((c.sessionId ?? "").slice(0, 8))}</code></td></tr>`
    })
    .join("")
  const queue = Array.isArray(o.deployQueue) && o.deployQueue.length > 0
    ? `<ul>${o.deployQueue.map((d) => `<li><code>${esc(String((d as Record<string, unknown>).id ?? ""))}</code> ${esc(String((d as Record<string, unknown>).note ?? ""))} <span class="dim">queued ${esc(String((d as Record<string, unknown>).queued_at ?? ""))}</span></li>`).join("")}</ul>`
    : `<p class="dim">Empty.</p>`
  const links = o.links.length ? `<p>${o.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(" · ")}</p>` : ""
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>neo-claw · overview</title><meta http-equiv="refresh" content="15">
<style>
body{margin:0;padding:24px;background:#0b0b0c;color:#e8e8ea;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:#8ab4ff}table{border-collapse:collapse;width:100%;max-width:1000px}td,th{padding:6px 10px;border-bottom:1px solid #222;text-align:left}
th{color:#9a9aa2;font-weight:500}tr.run td{background:#11241a}.dim{color:#8a8a92}h1{font-size:18px}h2{font-size:15px;margin-top:28px}code{color:#c9c9cf}
</style></head><body>
<h1>neo-claw overview</h1>
<p><a href="/">← console</a> · neo-claw API: ${o.apiReachable ? "reachable" : "<b>not reachable</b> (statuses are guessed from file activity; web turns are off)"}</p>
${links}
<h2>Channels</h2>
<table><tr><th>Channel</th><th>State</th><th>Runs on</th><th>Context (last seen)</th><th>Last compaction</th><th>Session</th></tr>${rows}</table>
<h2>Deploy queue</h2>${queue}
<p class="dim">Context and compaction are known for sessions opened in the console since it started. Refreshes every 15s.</p>
</body></html>`
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } })
}
