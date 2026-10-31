import { spawn } from "node:child_process"

/** A stdio MCP server definition, as in .mcp.json / settings.json. */
export interface StdioServer {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * Start a stdio MCP server, run one request after the handshake, then kill it.
 * Used on demand only (listing tools, a search), never on a timer.
 */
export function mcpRequest<T>(server: StdioServer, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], {
      cwd: server.cwd,
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let buf = ""
    let stderr = ""
    let done = false
    const finish = (err: Error | null, value?: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.()
      if (err) reject(err)
      else resolve(value as T)
    }
    const timer = setTimeout(() => finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    const send = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
    child.on("error", (e) => finish(new Error(`could not start: ${e.message}`)))
    child.on("exit", (code) => finish(new Error(`exited (${code}) before answering${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`)))
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString()
      if (buf.length > 4_000_000) return finish(new Error("response too large"))
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message ?? "initialize failed"))
          send({ method: "notifications/initialized" })
          send({ id: 2, method, params })
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(msg.error.message ?? `${method} failed`))
          return finish(null, msg.result as T)
        }
      }
    })
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kanna-neo-claw", version: "1" } },
    })
  })
}
