/**
 * Read-only Discord REST lookups with the bot's token, so the console can show
 * the server the way Discord does (category names, order, threads) even when
 * neo-claw's own API is down. The token stays on the server; responses are
 * reduced to names, ids and positions and cached.
 */

const API = "https://discord.com/api/v10"
const GUILD_MS = 5 * 60_000
const THREADS_MS = 60_000
const FAIL_BACKOFF_MS = 60_000

export interface DiscordCategory {
  id: string
  guildId: string
  name: string
  position: number
}

export interface DiscordChannel {
  id: string
  guildId: string
  name: string
  type: number
  parentId: string | null
  position: number
  topic: string | null
}

export interface DiscordThread {
  id: string
  guildId: string
  parentId: string
  name: string
  archived: boolean
  messageCount: number | null
  createdAt: number | null
  lastMessageAt: number | null
}

export interface DiscordGuildView {
  id: string
  name: string
  categories: DiscordCategory[]
  channels: DiscordChannel[]
}

const DISCORD_EPOCH = 1420070400000n

/** Creation time of a snowflake, in ms. */
export function snowflakeTime(id: string | null | undefined) {
  if (!id || !/^\d{5,25}$/.test(id)) return null
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
  } catch {
    return null
  }
}

// Text, announcement and forum channels hold conversations; voice/stage don't.
const TEXTLIKE = new Set([0, 5, 15])

export class DiscordDirectory {
  private guilds: DiscordGuildView[] | null = null
  private guildsAt = 0
  private threads: DiscordThread[] = []
  private threadsAt = 0
  private failedAt = 0
  private pending: Promise<void> | null = null
  private pendingThreads: Promise<void> | null = null

  constructor(private readonly token: string | null) {}

  get configured() {
    return Boolean(this.token)
  }

  private async get<T>(pathname: string): Promise<T> {
    const res = await fetch(`${API}${pathname}`, {
      headers: { Authorization: `Bot ${this.token}`, "User-Agent": "neo-claw-kanna (read-only directory)" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`discord ${res.status} on ${pathname.replace(/\d{5,}/g, ":id")}`)
    return (await res.json()) as T
  }

  /** Guilds with their categories and text-like channels; cached, refreshed in the background. */
  async directory(): Promise<DiscordGuildView[]> {
    if (!this.token) return []
    const fresh = Date.now() - this.guildsAt < GUILD_MS
    if (this.guilds && fresh) return this.guilds
    if (!this.guilds && Date.now() - this.failedAt < FAIL_BACKOFF_MS) return []
    this.pending ??= this.load().finally(() => {
      this.pending = null
    })
    // Serve the old copy while refreshing; wait only on the first load.
    if (this.guilds) return this.guilds
    await this.pending
    return this.guilds ?? []
  }

  private async load() {
    try {
      const guilds = await this.get<{ id: string; name: string }[]>("/users/@me/guilds?limit=200")
      const out: DiscordGuildView[] = []
      for (const g of guilds) {
        const raw = await this.get<{ id: string; name: string; type: number; parent_id?: string | null; position?: number; topic?: string | null }[]>(`/guilds/${g.id}/channels`)
        out.push({
          id: g.id,
          name: g.name,
          categories: raw.filter((c) => c.type === 4).map((c) => ({ id: c.id, guildId: g.id, name: c.name, position: c.position ?? 0 })),
          channels: raw
            .filter((c) => TEXTLIKE.has(c.type))
            .map((c) => ({ id: c.id, guildId: g.id, name: c.name, type: c.type, parentId: c.parent_id ?? null, position: c.position ?? 0, topic: c.topic ?? null })),
        })
      }
      this.guilds = out
      this.guildsAt = Date.now()
    } catch (e) {
      this.failedAt = Date.now()
      // Keep serving the last good copy; retry after the backoff.
      this.guildsAt = Date.now() - GUILD_MS + FAIL_BACKOFF_MS
      console.warn("[neoclaw] discord directory:", e instanceof Error ? e.message : String(e))
    }
  }

  /** Active threads across guilds (archived ones are fetched per channel on demand). */
  async activeThreads(): Promise<DiscordThread[]> {
    if (!this.token) return []
    if (Date.now() - this.threadsAt < THREADS_MS) return this.threads
    this.pendingThreads ??= (async () => {
      try {
        const guilds = await this.directory()
        const out: DiscordThread[] = []
        for (const g of guilds) {
          const r = await this.get<{ threads: RawThread[] }>(`/guilds/${g.id}/threads/active`)
          for (const t of r.threads ?? []) out.push(toThread(t, g.id))
        }
        this.threads = out
      } catch (e) {
        console.warn("[neoclaw] discord threads:", e instanceof Error ? e.message : String(e))
      } finally {
        this.threadsAt = Date.now()
      }
    })().finally(() => {
      this.pendingThreads = null
    })
    await this.pendingThreads
    return this.threads
  }

  private archived = new Map<string, { at: number; threads: DiscordThread[] }>()

  /** Recently archived public threads of one channel (cached 5 min). */
  async archivedThreads(channelId: string, guildId: string): Promise<DiscordThread[]> {
    if (!this.token || !/^\d{5,25}$/.test(channelId)) return []
    const hit = this.archived.get(channelId)
    if (hit && Date.now() - hit.at < GUILD_MS) return hit.threads
    let threads: DiscordThread[] = []
    try {
      const r = await this.get<{ threads: RawThread[] }>(`/channels/${channelId}/threads/archived/public?limit=25`)
      threads = (r.threads ?? []).map((t) => toThread(t, guildId))
    } catch {
      threads = hit?.threads ?? []
    }
    this.archived.set(channelId, { at: Date.now(), threads })
    return threads
  }

  /** Forget cached data (after creating a channel or thread). */
  invalidate() {
    this.guildsAt = 0
    this.threadsAt = 0
    this.archived.clear()
  }
}

interface RawThread {
  id: string
  parent_id: string
  name: string
  message_count?: number
  last_message_id?: string | null
  thread_metadata?: { archived?: boolean; create_timestamp?: string; archive_timestamp?: string }
}

function toThread(t: RawThread, guildId: string): DiscordThread {
  const created = t.thread_metadata?.create_timestamp ? Date.parse(t.thread_metadata.create_timestamp) : snowflakeTime(t.id)
  return {
    id: t.id,
    guildId,
    parentId: t.parent_id,
    name: t.name,
    archived: Boolean(t.thread_metadata?.archived),
    messageCount: typeof t.message_count === "number" ? t.message_count : null,
    createdAt: created,
    lastMessageAt: snowflakeTime(t.last_message_id) ?? created,
  }
}
