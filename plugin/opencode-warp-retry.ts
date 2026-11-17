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
  curl?: string
  logFile?: string
  retryDelayMs?: number
  maxRotations?: number
  requireProxyEnv?: boolean
}

const DEFAULT_PROXY_URL = "http://127.0.0.1:8789"
const DEFAULT_RECYCLE_PATH = "/recycle"
const DEFAULT_RETRY_DELAY_MS = 1_200
const DEFAULT_MAX_ROTATIONS = 2
const TRACE_TIMEOUT_MS = 8_000
const TRACE_POLL_MS = 750
const TRACE_POLL_ATTEMPTS = 24
const SETTLE_MS = 800

const state = (() => {
  const key = Symbol.for("opencode.warp-retry.state")
  const g = globalThis as Record<symbol, unknown>
  if (!g[key]) g[key] = { inFlight: null as Promise<boolean> | null }
  return g[key] as { inFlight: Promise<boolean> | null }
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
    curl: options.curl ?? envValue("WARP_RETRY_CURL") ?? "curl",
    logFile:
      options.logFile ??
      envValue("WARP_RETRY_LOG") ??
      `${homedir()}/.local/share/opencode-unlimited-warp/logs/retry-plugin.log`,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    maxRotations: Math.min(5, Math.max(1, options.maxRotations ?? DEFAULT_MAX_ROTATIONS)),
    requireProxyEnv: options.requireProxyEnv ?? envValue("WARP_RETRY_REQUIRE_PROXY") !== "false",
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

function proxyMatches(proxyUrl: string) {
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

async function setup(ctx: any) {
  const options = (ctx?.options ?? {}) as Options
  const config = resolveConfig(options)

  if (config.requireProxyEnv && !proxyMatches(config.proxyUrl)) {
    log(config, `no proxy env matches ${config.proxyUrl}; auto-retry disabled`)
    return
  }

  const hook = ctx?.session?.hook
  if (typeof hook !== "function") {
    log(config, "session.hook unavailable on this build; auto-retry idle")
    return
  }

  log(config, "plugin loaded; free-limit -> /recycle -> retry enabled")

  await hook("retry", async (event: any) => {
    if (!isFreeLimit(event?.error ?? {})) return
    log(config, `free limit on attempt ${event.attempt}; rotating`)
    const ready = await ensureRotation(config)
    if (!ready) {
      log(config, "rotation not ready; letting the original error surface")
      return
    }
    event.decision = { retry: true, delay: config.retryDelayMs }
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
