import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { all, one, run } from "./db.js"
import { now } from "./util.js"

const cache = new Map()

export function ensurePlugins(dataDir, sourceDir) {
  const dir = path.join(dataDir, "plugins")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (sourceDir && fs.existsSync(sourceDir)) {
    for (const name of fs.readdirSync(sourceDir)) {
      if (!name.endsWith(".js")) continue
      const target = path.join(dir, name)
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(sourceDir, name), target)
    }
  }
  return dir
}

export function pluginDir(dataDir) {
  return path.join(dataDir, "plugins")
}

async function loadFile(file) {
  const stat = await fsp.stat(file)
  const cached = cache.get(file)
  if (cached && cached.mtime === stat.mtimeMs) return cached.module
  const module = await import(`${pathToFileURL(file).href}?v=${Math.trunc(stat.mtimeMs)}`)
  const plugin = module.default || module
  cache.set(file, { mtime: stat.mtimeMs, module: plugin })
  return plugin
}

export async function listPlugins(db, dataDir) {
  const dir = pluginDir(dataDir)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".js")) : []
  const result = []
  for (const file of files) {
    const id = file.replace(/\.js$/, "")
    const absolute = path.join(dir, file)
    let plugin = null
    try {
      plugin = await loadFile(absolute)
    } catch (error) {
      result.push({ id, name: id, description: `failed to load: ${error.message}`, enabled: false, error: true })
      continue
    }
    const name = String(plugin.name || id)
    const description = String(plugin.description || "")
    const existing = one(db, "SELECT * FROM plugins WHERE id = ?", id)
    if (!existing) {
      run(db, "INSERT INTO plugins (id, name, enabled, config) VALUES (?, ?, 1, '{}')", id, name)
    }
    const enabled = existing ? Boolean(existing.enabled) : true
    result.push({ id, name, description, enabled, hooks: ["beforeChat", "afterResponse"].filter((hook) => typeof plugin[hook] === "function") })
  }
  return result
}

export function setPluginEnabled(db, id, enabled) {
  if (!one(db, "SELECT id FROM plugins WHERE id = ?", id)) {
    run(db, "INSERT INTO plugins (id, name, enabled, config) VALUES (?, ?, ?, '{}')", id, id, enabled ? 1 : 0)
  } else {
    run(db, "UPDATE plugins SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id)
  }
  return { id, enabled: Boolean(enabled), updatedAt: now() }
}

export async function pluginHooks(db, dataDir) {
  const hooks = { beforeChat: [], afterResponse: [] }
  const dir = pluginDir(dataDir)
  if (!fs.existsSync(dir)) return hooks
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    const id = file.replace(/\.js$/, "")
    const row = one(db, "SELECT * FROM plugins WHERE id = ?", id)
    if (row && !row.enabled) continue
    let plugin
    try {
      plugin = await loadFile(path.join(dir, file))
    } catch {
      continue
    }
    for (const hook of ["beforeChat", "afterResponse"]) {
      if (typeof plugin[hook] === "function") {
        hooks[hook].push(async (context) => {
          try {
            await plugin[hook](context)
          } catch {}
        })
      }
    }
  }
  return hooks
}
