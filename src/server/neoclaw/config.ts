import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * neo-claw mode. Everything machine-specific (paths, users, secrets) lives in
 * a local JSON file named by NEO_CLAW_KANNA_CONFIG, never in this repo.
 */
export interface NeoClawUser {
  /** Login name (lowercase). */
  username: string
  displayName: string
  /** Turns sent from the web are attributed to this Discord user. */
  discordId: string
  /** Bun.password hash (argon2id). */
  passwordHash: string
}

export interface NeoClawLink {
  label: string
  url: string
}

export interface NeoClawConfig {
  /** neo-claw's context root: one directory per Discord channel. */
  contextDir: string
  /** Claude Code's projects dir (session transcripts). */
  claudeProjectsDir: string
  /** neo-claw.config.json, for remote-host channel routing. Optional. */
  neoClawConfigPath?: string
  /** neo-claw's local web API (src/web-api.ts), e.g. http://127.0.0.1:8761. */
  apiUrl?: string
  /** File holding the API's shared secret (read at startup). */
  apiSecretFile?: string
  users: NeoClawUser[]
  /** HMAC key for session cookies (32+ random bytes, hex or base64). */
  cookieSecret: string
  /** Session cookie lifetime in days (default 30). */
  sessionDays?: number
  /** Link-outs shown in the neo-claw panel (dashboards, nodes...). */
  links?: NeoClawLink[]
  /** How many recent sessions to list per channel (default 5). */
  sessionsPerChannel?: number
  /** Bytes read from the end of a session transcript on first open (default 4 MB). */
  tailBytes?: number
  /** Default for the per-message "mirror to Discord" toggle (default true). */
  mirrorDefault?: boolean
  /** neo-claw repo checkout: bundled skills, deploy log (default: the folder of neoClawConfigPath). */
  neoClawRoot?: string
  /** User-level Claude Code skills (default ~/.claude/skills). */
  globalSkillsDir?: string
  /** User-level Claude Code settings: hooks, MCP servers (default ~/.claude/settings.json). Env values are never shown. */
  claudeSettingsPath?: string
  /** graphiti memory sidecar behind memory-search, e.g. http://127.0.0.1:7878 (optional). */
  memorySidecarUrl?: string
  /** `neo-claw-node` CLI for the compute-node panel (optional). */
  nodeCli?: string
  /** systemd units whose state the ops page shows. */
  services?: string[]
}

export interface LoadedNeoClawConfig extends NeoClawConfig {
  apiSecret: string | null
  remoteRouting: Record<string, string>
}

function expandHome(p: string) {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p
}

let cached: LoadedNeoClawConfig | null | undefined

export function loadNeoClawConfig(env: Record<string, string | undefined> = process.env): LoadedNeoClawConfig | null {
  if (cached !== undefined) return cached
  const file = env.NEO_CLAW_KANNA_CONFIG
  if (!file) {
    cached = null
    return cached
  }
  const raw = JSON.parse(readFileSync(expandHome(file), "utf8")) as NeoClawConfig
  if (!raw.contextDir || !raw.claudeProjectsDir) throw new Error("neo-claw config: contextDir and claudeProjectsDir are required")
  if (!Array.isArray(raw.users) || raw.users.length === 0) throw new Error("neo-claw config: at least one user is required")
  if (!raw.cookieSecret || raw.cookieSecret.length < 32) throw new Error("neo-claw config: cookieSecret must be 32+ chars")
  let apiSecret: string | null = null
  if (raw.apiSecretFile) {
    try {
      apiSecret = readFileSync(expandHome(raw.apiSecretFile), "utf8").trim() || null
    } catch {
      apiSecret = null
    }
  }
  let remoteRouting: Record<string, string> = {}
  if (raw.neoClawConfigPath) {
    try {
      const nc = JSON.parse(readFileSync(expandHome(raw.neoClawConfigPath), "utf8")) as { channelRouting?: Record<string, string> }
      remoteRouting = nc.channelRouting ?? {}
    } catch {
      remoteRouting = {}
    }
  }
  cached = {
    ...raw,
    contextDir: expandHome(raw.contextDir),
    claudeProjectsDir: expandHome(raw.claudeProjectsDir),
    users: raw.users.map((u) => ({ ...u, username: u.username.toLowerCase() })),
    neoClawRoot: raw.neoClawRoot ? expandHome(raw.neoClawRoot) : raw.neoClawConfigPath ? path.dirname(expandHome(raw.neoClawConfigPath)) : undefined,
    globalSkillsDir: expandHome(raw.globalSkillsDir ?? "~/.claude/skills"),
    claudeSettingsPath: expandHome(raw.claudeSettingsPath ?? "~/.claude/settings.json"),
    apiSecret,
    remoteRouting,
  }
  return cached
}

export function isNeoClawMode(env: Record<string, string | undefined> = process.env) {
  return Boolean(env.NEO_CLAW_KANNA_CONFIG)
}
