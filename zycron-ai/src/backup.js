import fs from "node:fs"
import path from "node:path"
import { all } from "./db.js"
import { now, timestampForFile } from "./util.js"

const KEEP = 12

export function createBackup(db, dataDir, reason = "auto") {
  const dir = path.join(dataDir, "backups")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const conversations = all(db, "SELECT * FROM conversations ORDER BY created_at")
  const messages = all(db, "SELECT * FROM messages ORDER BY created_at, rowid")
  const payload = {
    app: "ZYCRON AI",
    version: 1,
    reason,
    createdAt: now(),
    conversations,
    messages
  }
  const file = path.join(dir, `sessions-${timestampForFile()}.json`)
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 })
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse()
  for (const stale of files.slice(KEEP)) {
    fs.rmSync(path.join(dir, stale), { force: true })
  }
  return { file, createdAt: payload.createdAt, conversations: conversations.length, messages: messages.length, size: fs.statSync(file).size }
}

export function latestBackup(dataDir) {
  const dir = path.join(dataDir, "backups")
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse()
  if (!files.length) return null
  const file = path.join(dir, files[0])
  const stat = fs.statSync(file)
  return { file, size: stat.size, modified: stat.mtimeMs }
}
