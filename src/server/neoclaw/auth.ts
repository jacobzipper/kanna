import { createHmac, timingSafeEqual } from "node:crypto"
import type { AuthManager, AuthStatusPayload } from "../auth"
import type { LoadedNeoClawConfig, NeoClawUser } from "./config"

/**
 * Per-user login for neo-claw mode. Replaces Kanna's single shared password:
 * each user has their own password (argon2 hash in the local config) and a
 * Discord ID that web turns are attributed to.
 *
 * Sessions are stateless HMAC-signed cookies, so they survive restarts.
 * Rotating `cookieSecret` logs everyone out.
 */

const COOKIE_NAME = "kanna_session"
const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAIL_LIMIT = 10

export interface SessionUser {
  username: string
  displayName: string
  discordId: string
}

export interface NeoClawAuthManager extends AuthManager {
  getUser(req: Request): SessionUser | null
  loginPage(req: Request): Response
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const segment of header.split(";")) {
    const trimmed = segment.trim()
    const sep = trimmed.indexOf("=")
    if (sep <= 0) continue
    try {
      cookies.set(trimmed.slice(0, sep).trim(), decodeURIComponent(trimmed.slice(sep + 1).trim()))
    } catch {
      // malformed cookie: ignore
    }
  }
  return cookies
}

function sanitizeNextPath(nextPath: string | null | undefined) {
  if (!nextPath || typeof nextPath !== "string") return "/"
  if (!nextPath.startsWith("/") || nextPath.startsWith("//") || nextPath.startsWith("/\\")) return "/"
  if (nextPath.startsWith("/auth/")) return "/"
  return nextPath
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

export function createNeoClawAuthManager(config: LoadedNeoClawConfig, options: { trustProxy?: boolean } = {}): NeoClawAuthManager {
  const trustProxy = options.trustProxy ?? false
  const key = Buffer.from(config.cookieSecret)
  const maxAgeSec = Math.round((config.sessionDays ?? 30) * 86400)
  const usersByName = new Map(config.users.map((u) => [u.username, u]))
  const failures = new Map<string, number[]>()

  function forwardedProto(req: Request) {
    const xfp = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
    return xfp === "http" || xfp === "https" ? xfp : null
  }

  function effectiveOrigin(req: Request) {
    const url = new URL(req.url)
    if (!trustProxy) return url.origin
    const scheme = forwardedProto(req) ?? url.protocol.replace(":", "")
    return `${scheme}://${url.host}`
  }

  function secure(req: Request) {
    if (trustProxy) {
      const proto = forwardedProto(req)
      if (proto) return proto === "https"
    }
    return new URL(req.url).protocol === "https:"
  }

  function clientIp(req: Request) {
    if (trustProxy) {
      const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      if (xff) return xff
    }
    return "local"
  }

  function sign(payload: string) {
    return createHmac("sha256", key).update(payload).digest("base64url")
  }

  function makeToken(user: NeoClawUser) {
    const payload = Buffer.from(JSON.stringify({ u: user.username, exp: Math.floor(Date.now() / 1000) + maxAgeSec })).toString("base64url")
    return `${payload}.${sign(payload)}`
  }

  function cookie(req: Request, value: string, maxAge: number) {
    const parts = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`]
    if (secure(req)) parts.push("Secure")
    return parts.join("; ")
  }

  function getUser(req: Request): SessionUser | null {
    const token = parseCookies(req.headers.get("cookie")).get(COOKIE_NAME)
    if (!token) return null
    const dot = token.indexOf(".")
    if (dot <= 0) return null
    const payload = token.slice(0, dot)
    const given = Buffer.from(token.slice(dot + 1))
    const expected = Buffer.from(sign(payload))
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; exp?: number }
      if (!data.u || !data.exp || data.exp * 1000 < Date.now()) return null
      const user = usersByName.get(data.u)
      if (!user) return null
      return { username: user.username, displayName: user.displayName, discordId: user.discordId }
    } catch {
      return null
    }
  }

  function isAuthenticated(req: Request) {
    return getUser(req) !== null
  }

  function validateOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (!origin) return true
    if (origin === new URL(req.url).origin) return true
    return trustProxy && origin === effectiveOrigin(req)
  }

  function tooManyFailures(ip: string) {
    const now = Date.now()
    const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS)
    failures.set(ip, recent)
    return recent.length >= FAIL_LIMIT
  }

  function noteFailure(ip: string) {
    const list = failures.get(ip) ?? []
    list.push(Date.now())
    failures.set(ip, list)
  }

  async function readForm(req: Request) {
    const type = req.headers.get("content-type") ?? ""
    if (type.includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      return { json: true, username: String(body.username ?? ""), password: String(body.password ?? ""), next: String(body.next ?? "/") }
    }
    const form = await req.formData()
    return { json: false, username: String(form.get("username") ?? ""), password: String(form.get("password") ?? ""), next: String(form.get("next") ?? "/") }
  }

  function loginPage(req: Request) {
    const url = new URL(req.url)
    const next = sanitizeNextPath(url.searchParams.get("next"))
    const error = url.searchParams.get("error")
    const message = error === "rate" ? "Too many attempts. Try again in a few minutes." : error ? "Wrong username or password." : ""
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>neo-claw · sign in</title><meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0c;color:#e8e8ea;font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
form{width:min(340px,90vw);display:flex;flex-direction:column;gap:12px;padding:28px;border:1px solid #26262a;border-radius:14px;background:#131316}
h1{font-size:18px;margin:0 0 6px}p{margin:0;color:#9a9aa2;font-size:13px}
input{padding:10px 12px;border-radius:8px;border:1px solid #2e2e33;background:#0b0b0c;color:inherit;font:inherit}
button{padding:10px;border-radius:8px;border:0;background:#e8e8ea;color:#111;font-weight:600;cursor:pointer}
.err{color:#ff7a7a}
</style></head><body>
<form method="post" action="/auth/login">
<h1>neo-claw</h1><p>Sign in to the neo-claw web console.</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<input name="username" autocomplete="username" placeholder="Username" required autofocus>
<input name="password" type="password" autocomplete="current-password" placeholder="Password" required>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Sign in</button>
</form></body></html>`
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      },
    })
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) return Response.json({ error: "Forbidden" }, { status: 403 })
    const ip = clientIp(req)
    const form = await readForm(req)
    const next = sanitizeNextPath(form.next || fallbackNextPath)
    const origin = effectiveOrigin(req)
    const fail = (kind: string, status: number) =>
      form.json
        ? Response.json({ error: kind === "rate" ? "Too many attempts" : "Invalid username or password" }, { status })
        : new Response(null, { status: 303, headers: { Location: `${origin}/auth/login?error=${kind}&next=${encodeURIComponent(next)}` } })
    if (tooManyFailures(ip)) return fail("rate", 429)
    const user = usersByName.get(form.username.trim().toLowerCase())
    // Verify against a dummy hash when the user is unknown so timing doesn't leak names.
    const hash = user?.passwordHash ?? config.users[0]!.passwordHash
    const ok = await Bun.password.verify(form.password, hash).catch(() => false)
    if (!user || !ok) {
      noteFailure(ip)
      return fail("1", 401)
    }
    const setCookie = cookie(req, makeToken(user), maxAgeSec)
    if (form.json) {
      const res = Response.json({ ok: true, nextPath: next })
      res.headers.set("Set-Cookie", setCookie)
      return res
    }
    return new Response(null, { status: 303, headers: { Location: `${origin}${next}`, "Set-Cookie": setCookie } })
  }

  function handleLogout(req: Request) {
    if (!validateOrigin(req)) return Response.json({ error: "Forbidden" }, { status: 403 })
    const res = Response.json({ ok: true })
    res.headers.set("Set-Cookie", cookie(req, "", 0))
    return res
  }

  function handleStatus(req: Request) {
    return Response.json({ enabled: true, authenticated: isAuthenticated(req) } satisfies AuthStatusPayload)
  }

  function redirectToApp(req: Request) {
    const url = new URL(req.url)
    return Response.redirect(new URL(sanitizeNextPath(url.searchParams.get("next")), effectiveOrigin(req)), 302)
  }

  return { isAuthenticated, validateOrigin, redirectToApp, handleLogin, handleLogout, handleStatus, getUser, loginPage }
}
