import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function resolveDataDir() {
  return process.env.ZYCRON_DATA || path.join(os.homedir(), ".local", "share", "zycron-ai")
}

export function serverEntry() {
  return path.join(ROOT, "server.js")
}

export function logPath() {
  return path.join(resolveDataDir(), "tui-server.log")
}

export async function checkHealth(baseUrl, token = "", timeout = 800) {
  try {
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/health`, {
      headers,
      signal: AbortSignal.timeout(timeout)
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function tail(file, lines = 24) {
  try {
    const text = readFileSync(file, "utf8")
    return text.split("\n").slice(-lines).join("\n").trim()
  } catch {
    return ""
  }
}

export async function ensureServer({ baseUrl, token = "", allowSpawn = true, waitMs = 30000, onLog } = {}) {
  const url = String(baseUrl || "http://127.0.0.1:8787").replace(/\/+$/, "")
  const existing = await checkHealth(url, token)
  if (existing) return { spawned: false, child: null, url, health: existing, logFile: logPath() }

  if (!allowSpawn) {
    throw new Error(`ZYCRON is not running at ${url}`)
  }

  const parsed = new URL(url)
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  if (!local) throw new Error(`cannot auto-start a server for ${url}`)

  const dataDir = resolveDataDir()
  mkdirSync(dataDir, { recursive: true })
  const logFile = logPath()
  const fd = openSync(logFile, "a")
  const env = {
    ...process.env,
    ZYCRON_HOST: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname.replace(/^\[|\]$/g, ""),
    PORT: parsed.port || "8787"
  }
  const child = spawn(process.execPath, [serverEntry()], {
    cwd: ROOT,
    env,
    stdio: ["ignore", fd, fd]
  })
  closeSync(fd)
  child.on("error", (error) => {
    if (onLog) onLog(`server spawn failed: ${error.message}`)
  })

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const log = tail(logFile)
      throw new Error(`ZYCRON exited during startup (code ${child.exitCode})${log ? `\n${log}` : ""}`)
    }
    const health = await checkHealth(url, token)
    if (health) return { spawned: true, child, url, health, logFile }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  const log = tail(logFile)
  stopServer(child)
  throw new Error(`ZYCRON did not respond at ${url} within ${Math.round(waitMs / 1000)}s${log ? `\n${log}` : ""}`)
}

export function stopServer(child) {
  if (!child || child.exitCode !== null) return
  try {
    child.kill("SIGTERM")
  } catch {}
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL")
    } catch {}
  }, 2500)
  timer.unref?.()
}

export { ROOT as serverRoot }
