import { readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Tui } from "./app.js"
import { ZycronApi } from "./api.js"
import { checkHealth, ensureServer, stopServer } from "./local.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function packageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function usage() {
  return [
    "zycron — terminal client for ZYCRON AI",
    "",
    "Usage: zycron [options]",
    "",
    "Options:",
    "  --url <url>      server base URL (default http://127.0.0.1:8787)",
    "  --token <token>  bearer token when the server requires one",
    "  --no-spawn       never start a local server, fail if it is not running",
    "  -h, --help       show this help",
    "  -v, --version    print the version",
    "",
    "Environment:",
    "  ZYCRON_URL       same as --url",
    "  ZYCRON_TOKEN     same as --token",
    "  ZYCRON_DATA      data directory used when a server is spawned",
    "  ZYCRON_WORKSPACE project root used when a server is spawned",
    ""
  ].join("\n")
}

function parseArgs(argv) {
  const options = {
    url: process.env.ZYCRON_URL || "http://127.0.0.1:8787",
    token: process.env.ZYCRON_TOKEN || "",
    allowSpawn: true,
    help: false,
    version: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") options.help = true
    else if (arg === "-v" || arg === "--version") options.version = true
    else if (arg === "--no-spawn") options.allowSpawn = false
    else if (arg === "--url") options.url = argv[++i] || options.url
    else if (arg.startsWith("--url=")) options.url = arg.slice(6)
    else if (arg === "--token") options.token = argv[++i] || ""
    else if (arg.startsWith("--token=")) options.token = arg.slice(8)
    else if (arg.startsWith("-")) {
      process.stderr.write(`unknown option: ${arg}\n\n${usage()}`)
      process.exit(2)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write(usage())
  process.exit(0)
}
if (options.version) {
  process.stdout.write(`${packageVersion()}\n`)
  process.exit(0)
}

let child = null
let stopping = false

function cleanup() {
  if (child) {
    stopServer(child)
    child = null
  }
}

async function ensure({ onLog } = {}) {
  const baseUrl = String(options.url || "").replace(/\/+$/, "")
  const health = await checkHealth(baseUrl, options.token)
  if (health) return new ZycronApi({ baseUrl, token: options.token })
  if (!options.allowSpawn) {
    throw new Error(`ZYCRON is not running at ${baseUrl}. Start it with "npm start" or drop --no-spawn.`)
  }
  if (onLog) onLog("starting local server")
  const server = await ensureServer({ baseUrl, token: options.token, allowSpawn: true, onLog })
  child = server.child
  if (onLog) onLog(`server ready at ${server.url}`)
  return new ZycronApi({ baseUrl: server.url, token: options.token })
}

const tui = new Tui({
  ensure,
  onExit: () => {
    cleanup()
    process.exit(0)
  }
})

function shutdown(code) {
  if (stopping) return
  stopping = true
  try {
    tui.shutdown()
  } catch {}
  cleanup()
  process.exit(code)
}

process.on("SIGINT", () => shutdown(130))
process.on("SIGTERM", () => shutdown(143))
process.on("uncaughtException", (error) => {
  try {
    tui.shutdown()
  } catch {}
  cleanup()
  process.stderr.write(`zycron: ${error?.stack || error}\n`)
  process.exit(1)
})

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("zycron: an interactive terminal is required\n")
  process.exit(1)
}

tui.start()
