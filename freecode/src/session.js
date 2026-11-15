import fs from "node:fs"
import path from "node:path"
import { sessionDir } from "./config.js"
import { ensureDir, readJson, sessionStamp, timestamp, writeJson } from "./util.js"

export class Session {
  constructor({ id, cwd, dir, messages = [], meta = {}, createdAt = null, updatedAt = null }) {
    this.id = id
    this.cwd = cwd
    this.dir = dir
    this.messages = Array.isArray(messages) ? messages : []
    this.meta = meta && typeof meta === "object" ? meta : {}
    this.createdAt = createdAt || timestamp()
    this.updatedAt = updatedAt || this.createdAt
  }

  get file() {
    return path.join(this.dir, `${this.id}.json`)
  }

  get messageCount() {
    return this.messages.length
  }

  static create(config, cwd = process.cwd()) {
    ensureDir(sessionDir(config))
    return new Session({
      id: sessionStamp(),
      cwd,
      dir: sessionDir(config),
      meta: { cwd }
    })
  }

  static load(config, idOrPath) {
    if (!idOrPath) return null
    const dir = sessionDir(config)
    const direct = path.isAbsolute(idOrPath) ? idOrPath : path.join(dir, `${idOrPath}.json`)
    const data = readJson(direct, null) || (fs.existsSync(idOrPath) ? readJson(idOrPath, null) : null)
    if (!data || !Array.isArray(data.messages)) return null
    return new Session({
      id: data.id || path.basename(direct, ".json"),
      cwd: data.cwd || data.meta?.cwd || process.cwd(),
      dir,
      messages: data.messages,
      meta: data.meta || {},
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    })
  }

  static list(config) {
    const dir = sessionDir(config)
    let names = []
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
    } catch {
      return []
    }
    const sessions = []
    for (const name of names) {
      const file = path.join(dir, name)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      const data = readJson(file, null)
      if (!data || !Array.isArray(data.messages)) continue
      sessions.push({
        id: data.id || name.replace(/\.json$/, ""),
        cwd: data.cwd || data.meta?.cwd || "",
        updatedAt: data.updatedAt || "",
        messages: data.messages.length,
        mtime: stat.mtimeMs
      })
    }
    return sessions.sort((a, b) => b.mtime - a.mtime)
  }

  static latest(config, cwd = process.cwd()) {
    const sessions = Session.list(config)
    const match = sessions.find((session) => session.cwd === cwd) || sessions[0]
    return match ? Session.load(config, match.id) : null
  }

  save() {
    ensureDir(this.dir)
    this.updatedAt = timestamp()
    writeJson(this.file, {
      id: this.id,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      meta: this.meta,
      messages: this.messages
    })
    return this.file
  }

  append(message) {
    this.messages.push(message)
    this.save()
    return message
  }
}
