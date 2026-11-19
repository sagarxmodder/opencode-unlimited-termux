// opencode-warp-retry (warp-minimal edition) — flat plugin for opencode 1.x and 2.x
//
// Adapted from lipey1/opencode-warp-retry (MIT) for a warp-minimal pool on
// Termux. Instead of warp-cli disconnect/connect it calls the proxy's
// POST /recycle admin endpoint, waits for warp=on with a changed egress IP,
// then asks opencode to retry the request.
//
// Install: flat file ~/.config/opencode/plugins/opencode-warp-retry.ts
//
// The file is deliberately version-adaptive and dependency-free:
//   opencode 2.x  -> loads the default export as a Plugin object and calls setup(ctx)
//   opencode 1.x  -> calls the default export as a function; it is a no-op there
//                    (the lane plugin already rotates WARP on 1.x)

import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

type Options = {
  proxyUrl?: string
  recyclePath?: string
  healthPath?: string
  curl?: string
  logFile?: string
  retryDelayMs?: number
  networkRetryDelayMs?: number
  maxRotations?: number
  maxNetworkRetries?: number
  requireProxyEnv?: boolean
  requireProxyHealth?: boolean
}

const DEFAULT_PROXY_URL = "http://127.0.0.1:8789"
const DEFAULT_RECYCLE_PATH = "/recycle"
const DEFAULT_HEALTH_PATH = "/health"
const DEFAULT_RETRY_DELAY_MS = 1_200
const DEFAULT_NETWORK_RETRY_DELAY_MS = 900
const DEFAULT_MAX_ROTATIONS = 2
const DEFAULT_MAX_NETWORK_RETRIES = 3
const TRACE_TIMEOUT_MS = 8_000
const TRACE_POLL_MS = 750
const TRACE_POLL_ATTEMPTS = 24
const SETTLE_MS = 800
const HEALTH_TIMEOUT_MS = 3_000

const state = (() => {
  const key = Symbol.for("opencode.warp-retry.state")
  const g = globalThis as Record<symbol, unknown>
  const fresh = { inFlight: null as Promise<boolean> | null, netStreak: 0, netAt: 0 }
  if (!g[key]) g[key] = fresh
  return g[key] as typeof fresh
})()

function envValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

function resolveConfig(options: Options) {
  return {
    proxyUrl: options.proxyUrl ?? envValue("WARP_RETRY_PROXY") ?? DEFAULT_PROXY_URL,
    recyclePath: options.recyclePath ?? envValue("WARP_RETRY_RECYCLE_PATH") ?? DEFAULT_RECYCLE_PATH,
    healthPath: options.healthPath ?? envValue("WARP_RETRY_HEALTH_PATH") ?? DEFAULT_HEALTH_PATH,
    curl: options.curl ?? envValue("WARP_RETRY_CURL") ?? "curl",
    logFile:
      options.logFile ??
      envValue("WARP_RETRY_LOG") ??
      `${homedir()}/.local/share/opencode-unlimited-warp/logs/retry-plugin.log`,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    networkRetryDelayMs: options.networkRetryDelayMs ?? DEFAULT_NETWORK_RETRY_DELAY_MS,
    maxRotations: Math.min(5, Math.max(1, options.maxRotations ?? DEFAULT_MAX_ROTATIONS)),
    maxNetworkRetries: Math.min(8, Math.max(0, options.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES)),
    requireProxyEnv: options.requireProxyEnv ?? envValue("WARP_RETRY_REQUIRE_PROXY") === "true",
    requireProxyHealth: options.requireProxyHealth ?? envValue("WARP_RETRY_REQUIRE_HEALTH") !== "false",
  }
}

type Config = ReturnType<typeof resolveConfig>

function log(config: Config, message: string) {
  try {
    mkdirSync(dirname(config.logFile), { recursive: true })
    appendFileSync(config.logFile, `${new Date().toISOString()}  ${message}\n`, "utf8")
  } catch {
    // logging must never break the retry
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function run(file: string, args: string[], timeout: number) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(file, args, { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ""}${stderr ?? ""}`.trim() })
    })
  })
}

// The proxy is what matters, not the env vars. opencode only exports
// HTTP(S)_PROXY when the lane shim launched it, so an env match test wrongly
// disables retry on every direct/manual launch. Ask the proxy itself instead.
async function proxyHealth(config: Config) {
  const result = await run(
    config.curl,
    ["-sS", "-m", "3", "--noproxy", "*", `${config.proxyUrl}${config.healthPath}`],
    HEALTH_TIMEOUT_MS,
  )
  if (!result.ok) return false
  try {
    const body = JSON.parse(result.output) as { ok?: boolean; healthy?: number }
    if (body?.ok === false) return false
    if (typeof body?.healthy === "number") return body.healthy > 0
    return true
  } catch {
    return /\bok\b/i.test(result.output)
  }
}

function proxyEnvMatches(proxyUrl: string) {
  try {
    const url = new URL(proxyUrl)
    const port = url.port || "80"
    const hostPort = `${url.hostname}:${port}`
    return ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value))
      .some((value) => value.includes(hostPort))
  } catch {
    return false
  }
}

async function proxyTrace(config: Config) {
  const result = await run(
    config.curl,
    ["-sS", "--max-time", "8", "--proxy", config.proxyUrl, "https://www.cloudflare.com/cdn-cgi/trace"],
    TRACE_TIMEOUT_MS,
  )
  if (!result.ok) return { ready: false, ip: null as string | null }
  const ready = /(^|\r?\n)warp=on(\r?\n|$)/i.test(result.output)
  const ip = /(^|\r?\n)ip=([^\r\n]+)/.exec(result.output)?.[2]?.trim() ?? null
  return { ready, ip }
}

async function rotate(config: Config) {
  const before = await proxyTrace(config)
  let previousIp = before.ip

  for (let attempt = 1; attempt <= config.maxRotations; attempt++) {
    log(config, `free limit: recycling WARP pool (${attempt}/${config.maxRotations})`)
    const recycle = await run(
      config.curl,
      ["-sS", "-m", "12", "-X", "POST", `${config.proxyUrl}${config.recyclePath}`],
      15_000,
    )
    if (!recycle.ok) {
      log(config, `recycle failed: ${recycle.output}`)
      return false
    }

    let trace: { ready: boolean; ip: string | null } = { ready: false, ip: null }
    for (let i = 0; i < TRACE_POLL_ATTEMPTS; i++) {
      await delay(TRACE_POLL_MS)
      trace = await proxyTrace(config)
      if (trace.ready) break
    }
    if (!trace.ready) {
      log(config, "proxy did not come back with warp=on")
      return false
    }

    if (previousIp && trace.ip && trace.ip === previousIp && attempt < config.maxRotations) {
      log(config, `same egress ${trace.ip}; rotating again`)
      previousIp = trace.ip
      await delay(SETTLE_MS)
      continue
    }

    log(config, `WARP ready: ${previousIp ?? "?"} -> ${trace.ip ?? "?"}`)
    await delay(SETTLE_MS)
    return true
  }
  return false
}

function ensureRotation(config: Config) {
  if (state.inFlight) return state.inFlight
  const task = rotate(config)
    .catch((error) => {
      log(config, `rotation error: ${error instanceof Error ? error.message : String(error)}`)
      return false
    })
    .finally(() => {
      state.inFlight = null
    })
  state.inFlight = task
  return task
}

function isFreeLimit(error: { type?: string; message?: unknown }) {
  return (
    error.type === "provider.free-limit" ||
    error.type === "provider.quota" ||
    /free usage limit|free usage exceeded|usage exceeded|quota exceeded|rate.?limit|429|subscribe to/i.test(String(error.message ?? ""))
  )
}

// WARP tears the MASQUE tunnel down on its own schedule ("connection reset by
// peer", "connection aborted", 30m cooldown then re-enroll). opencode sees that
// as a bare socket/transport failure and surfaces it as ECONNRESET even though
// the proxy came back healthy a second later. Those are safe to replay: the
// request either never reached the provider or failed before any token stream.
function errorText(error: unknown, depth = 0): string {
  if (!error || depth > 4) return ""
  if (typeof error === "string") return error
  const e = error as Record<string, unknown>
  const parts = [e.name, e.type, e.code, e.message, e.errno, e.cause]
    .map((value) => (value && typeof value === "object" ? errorText(value, depth + 1) : String(value ?? "")))
    .filter(Boolean)
  return parts.join(" ")
}

function isNetworkReset(error: unknown) {
  const e = (error ?? {}) as Record<string, unknown>
  if (e.type === "provider.network" || e.type === "provider.transport") return true
  const text = errorText(error)
  if (!text) return false
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CLOSED|SocketError/i.test(text) ||
    /socket (connection was )?closed|other side closed|fetch failed|connection reset by peer|connection aborted|network (error|unreachable)|terminated|proxy.*\b(502|503|504)\b|\b(502|503|504)\b.*proxy/i.test(text)
}

function countNetworkRetry(config: Config) {
  const now = Date.now()
  // A burst of resets from one tunnel teardown is one event; a wider window
  // means a genuinely dead upstream and we should stop replaying.
  if (now - state.netAt > 120_000) state.netStreak = 0
  state.netAt = now
  state.netStreak += 1
  if (state.netStreak > config.maxNetworkRetries) {
    log(config, `network reset streak ${state.netStreak} exceeded ${config.maxNetworkRetries}; surfacing error`)
    return false
  }
  return true
}

async function setup(ctx: any) {
  const options = (ctx?.options ?? {}) as Options
  const config = resolveConfig(options)

  if (config.requireProxyEnv && !proxyEnvMatches(config.proxyUrl)) {
    log(config, `no proxy env matches ${config.proxyUrl}; auto-retry disabled by WARP_RETRY_REQUIRE_PROXY`)
    return
  }

  const hook = ctx?.session?.hook
  if (typeof hook !== "function") {
    log(config, "session.hook unavailable on this build; auto-retry idle")
    return
  }

  // Informational only. The lane may be down right now and come back mid
  // session, so a cold proxy must not disable retry for the whole process.
  const healthy = await proxyHealth(config)
  log(
    config,
    healthy
      ? `plugin loaded; proxy healthy at ${config.proxyUrl}; free-limit -> recycle, network reset -> retry`
      : `plugin loaded; proxy not healthy yet at ${config.proxyUrl}; retry armed, will recover when lane returns`,
  )

  await hook("retry", async (event: any) => {
    const error = event?.error ?? {}

    if (isFreeLimit(error)) {
      log(config, `free limit on attempt ${event.attempt}; rotating`)
      const ready = await ensureRotation(config)
      if (!ready) {
        log(config, "rotation not ready; letting the original error surface")
        return
      }
      event.decision = { retry: true, delay: config.retryDelayMs }
      return
    }

    if (isNetworkReset(error)) {
      if (!countNetworkRetry(config)) return
      const attempt = event?.attempt ?? "?"
      // Short backoff: the tunnel is usually back before the proxy reports it.
      // Only pay for a full recycle when the proxy itself is gone.
      const alive = await proxyHealth(config)
      log(
        config,
        `network reset on attempt ${attempt} (${errorText(error).slice(0, 160)}); proxy ${alive ? "healthy" : "unhealthy"}; retry ${state.netStreak}/${config.maxNetworkRetries}`,
      )
      if (!alive) {
        const ready = await ensureRotation(config)
        if (!ready) {
          log(config, "rotation not ready; letting the network error surface")
          return
        }
      }
      event.decision = {
        retry: true,
        delay: config.networkRetryDelayMs * Math.min(3, state.netStreak),
      }
    }
  })
}

// One export shape for every build:
//   opencode 1.x  -> validates an object with server() and calls it once.
//                    There is no retry hook on that API, so it returns no
//                    hooks and stays out of the way (lane plugin rotates).
//   opencode 2.x  -> calls setup(ctx) and hands us ctx.session.hook("retry").
const plugin = {
  id: "warp-minimal-retry",
  async server() {
    return {}
  },
  setup,
}

export default plugin
export { setup, plugin }
