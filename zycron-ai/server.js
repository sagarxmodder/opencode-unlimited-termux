import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createApp } from "./src/app.js"
import { ensureSecret } from "./src/crypto.js"
import { openDb } from "./src/db.js"
import { ensurePlugins } from "./src/plugins.js"
import { ensureDefaultProject } from "./src/projects.js"
import { createBackup } from "./src/backup.js"
import { ensureUploads } from "./src/uploads.js"

const ROOT = path.dirname(fileURLToPath(import.meta.url))

function expand(value) {
  const text = String(value || "")
  if (text === "~" || text.startsWith("~/")) return path.join(os.homedir(), text.slice(2))
  return text
}

const dataDir = path.resolve(expand(process.env.ZYCRON_DATA || "~/.local/share/zycron-ai"))
const workspace = path.resolve(expand(process.env.ZYCRON_WORKSPACE || "~/zycron-projects"))
const publicDir = path.join(ROOT, "public")
const port = Number(process.env.PORT || process.env.ZYCRON_PORT || 8787)
const host = process.env.ZYCRON_HOST || "127.0.0.1"
const token = process.env.ZYCRON_TOKEN || ""

const secret = ensureSecret(dataDir)
const uploadsDir = ensureUploads(dataDir)
const db = openDb(path.join(dataDir, "zycron.db"))
ensurePlugins(dataDir, path.join(ROOT, "plugins"))
ensureDefaultProject(db, workspace)
createBackup(db, dataDir, "startup")
const backupTimer = setInterval(() => {
  try {
    createBackup(db, dataDir, "auto")
  } catch {}
}, 30 * 60 * 1000)
backupTimer.unref()

const server = createApp({ db, secret, dataDir, uploadsDir, workspace, publicDir, token })

server.listen(port, host, () => {
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`
  console.log("")
  console.log("  ╭──────────────────────────────────────────╮")
  console.log("  │  ✦ ZYCRON AI · AI CODING AGENT           │")
  console.log("  ╰──────────────────────────────────────────╯")
  console.log(`  local     ${url}`)
  console.log(`  data      ${dataDir}`)
  console.log(`  projects  ${workspace}`)
  console.log(`  auth      ${token ? "token required" : "local-only, no token"}`)
  console.log("")
})

function shutdown() {
  clearInterval(backupTimer)
  server.close(() => {
    try {
      db.close()
    } catch {}
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
