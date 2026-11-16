import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { all, one, run } from "./db.js"
import { HttpError, languageFor, now, slugify } from "./util.js"

const IGNORE = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".DS_Store", "dist", "build", ".next"])
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".py", ".html", ".htm", ".css", ".md", ".txt", ".sh", ".bash", ".yml", ".yaml", ".toml", ".sql", ".xml", ".svg", ".env", ".ini", ".cfg", ".conf", ".rs", ".go", ".java", ".c", ".h", ".cpp", ".php", ".rb", ".lua", ".kt", ".swift"])

export function ensureDefaultProject(db, workspace) {
  const root = path.join(workspace, "playground")
  fs.mkdirSync(root, { recursive: true })
  run(db, "INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('playground', 'Playground', ?, ?)", root, now())
  return one(db, "SELECT * FROM projects WHERE id = 'playground'")
}

export function listProjects(db) {
  return all(db, "SELECT * FROM projects ORDER BY created_at DESC").map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at
  }))
}

export function projectById(db, id, workspace) {
  if (!id || id === "auto") return ensureDefaultProject(db, workspace)
  const row = one(db, "SELECT * FROM projects WHERE id = ?", id)
  if (!row) throw new HttpError(404, "project not found")
  return row
}

export function createProject(db, workspace, name) {
  const clean = String(name || "").trim() || "New project"
  const base = slugify(clean)
  let id = base
  let suffix = 2
  while (one(db, "SELECT id FROM projects WHERE id = ?", id)) {
    id = `${base}-${suffix++}`
  }
  const root = path.join(workspace, id)
  fs.mkdirSync(root, { recursive: true })
  run(db, "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)", id, clean, root, now())
  return { id, name: clean, path: root, createdAt: now() }
}

export function removeProject(db, id, deleteFiles = false, workspace = "") {
  if (id === "playground") throw new HttpError(400, "the playground project cannot be removed")
  const row = one(db, "SELECT * FROM projects WHERE id = ?", id)
  if (!row) throw new HttpError(404, "project not found")
  run(db, "DELETE FROM projects WHERE id = ?", id)
  run(db, "UPDATE conversations SET project_id = NULL WHERE project_id = ?", id)
  if (deleteFiles) {
    const root = path.resolve(row.path)
    const base = workspace ? path.resolve(workspace) : ""
    if (base && root.startsWith(`${base}${path.sep}`)) fs.rmSync(root, { recursive: true, force: true })
  }
}

async function safePath(project, rel = ".", { mustExist = true } = {}) {
  const root = await fsp.realpath(project.path).catch(() => path.resolve(project.path))
  const target = path.resolve(root, String(rel || "."))
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new HttpError(403, "path is outside this project")
  }
  if (mustExist) {
    const real = await fsp.realpath(target).catch(() => null)
    if (!real) throw new HttpError(404, `not found: ${rel}`)
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new HttpError(403, "path escapes the project")
    return real
  }
  const parent = await fsp.realpath(path.dirname(target)).catch(() => null)
  if (!parent) throw new HttpError(404, `parent directory not found: ${path.dirname(rel)}`)
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new HttpError(403, "path escapes the project")
  return target
}

export async function projectTree(project, rel = ".", depth = 4) {
  const root = await safePath(project, rel)
  const build = async (absolute, relative, level) => {
    const entries = await fsp.readdir(absolute, { withFileTypes: true })
    const nodes = []
    const sorted = entries.filter((entry) => !IGNORE.has(entry.name)).sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of sorted.slice(0, 300)) {
      const childAbs = path.join(absolute, entry.name)
      const childRel = relative === "." ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        const node = { name: entry.name, path: childRel, type: "dir", children: [] }
        if (level < depth) node.children = await build(childAbs, childRel, level + 1)
        nodes.push(node)
      } else if (entry.isFile()) {
        const stat = await fsp.stat(childAbs).catch(() => null)
        nodes.push({ name: entry.name, path: childRel, type: "file", size: stat?.size || 0, language: languageFor(entry.name) })
      }
    }
    return nodes
  }
  return build(root, ".", 1)
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  return sample.includes(0)
}

export function readProjectInstructions(project, maxChars = 24000) {
  let root = ""
  try {
    root = fs.realpathSync(project.path)
  } catch {
    return null
  }
  for (const name of ["AGENTS.md", "agents.md"]) {
    const candidate = path.join(root, name)
    let file = ""
    try {
      file = fs.realpathSync(candidate)
    } catch {
      continue
    }
    if (!file.startsWith(`${root}${path.sep}`)) continue
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size === 0) continue
    const limit = Math.max(1000, Math.min(64000, Number(maxChars) || 24000))
    const buffer = Buffer.alloc(Math.min(stat.size, limit * 2))
    const fd = fs.openSync(file, "r")
    try {
      fs.readSync(fd, buffer, 0, buffer.length, 0)
    } finally {
      fs.closeSync(fd)
    }
    const content = buffer.toString("utf8").slice(0, limit)
    return {
      name,
      path: name,
      content,
      chars: content.length,
      truncated: stat.size > buffer.length || content.length >= limit
    }
  }
  return null
}

export async function readProjectFile(project, rel) {
  const file = await safePath(project, rel)
  const stat = await fsp.stat(file)
  if (stat.isDirectory()) throw new HttpError(400, "path is a directory")
  if (stat.size > 2 * 1024 * 1024) throw new HttpError(413, "file is larger than 2 MB")
  const buffer = await fsp.readFile(file)
  const binary = isBinary(buffer)
  return {
    path: rel,
    name: path.basename(file),
    size: stat.size,
    language: languageFor(file),
    binary,
    content: binary ? "" : buffer.toString("utf8"),
    modified: stat.mtimeMs
  }
}

export async function writeProjectFile(project, rel, content) {
  const target = await safePath(project, rel, { mustExist: false })
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const text = String(content ?? "")
  await fsp.writeFile(target, text, "utf8")
  return { path: rel, size: Buffer.byteLength(text), language: languageFor(target) }
}

export async function deleteProjectPath(project, rel) {
  const target = await safePath(project, rel)
  const root = await fsp.realpath(project.path)
  if (target === root) throw new HttpError(400, "cannot delete the project root")
  await fsp.rm(target, { recursive: true, force: true })
  return { path: rel }
}

export async function renameProjectPath(project, from, to) {
  const source = await safePath(project, from)
  const target = await safePath(project, to, { mustExist: false })
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.rename(source, target)
  return { from, to }
}

async function walkTextFiles(project, rel, limit = 500) {
  const root = await safePath(project, rel)
  const files = []
  const walk = async (dir) => {
    if (files.length >= limit) return
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= limit || IGNORE.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile() && (TEXT_EXT.has(path.extname(entry.name).toLowerCase()) || !path.extname(entry.name))) {
        const stat = await fsp.stat(abs).catch(() => null)
        if (stat && stat.size <= 1024 * 1024) files.push(abs)
      }
    }
  }
  await walk(root)
  return files
}

export async function searchProject(project, query, rel = ".") {
  const needle = String(query || "").trim()
  if (!needle) return []
  const files = await walkTextFiles(project, rel)
  const results = []
  for (const file of files) {
    const text = await fsp.readFile(file, "utf8").catch(() => "")
    if (!text.includes(needle)) continue
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle.toLowerCase())) continue
      results.push({
        path: path.relative(path.resolve(project.path), file).split(path.sep).join("/"),
        line: i + 1,
        text: lines[i].slice(0, 300)
      })
      if (results.length >= 200) return results
    }
  }
  return results
}

export async function replaceProject(project, query, replacement, rel = ".") {
  const needle = String(query || "")
  if (!needle) throw new HttpError(400, "search text is empty")
  const files = await walkTextFiles(project, rel, 300)
  let changed = 0
  let count = 0
  const paths = []
  for (const file of files) {
    const text = await fsp.readFile(file, "utf8").catch(() => null)
    if (text === null || !text.includes(needle)) continue
    const next = text.split(needle).join(String(replacement ?? ""))
    const hits = text.split(needle).length - 1
    await fsp.writeFile(file, next, "utf8")
    changed++
    count += hits
    paths.push(path.relative(path.resolve(project.path), file).split(path.sep).join("/"))
  }
  return { files: changed, replacements: count, paths }
}

export function runCommand(cwd, command, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", String(command)], {
      cwd,
      detached: true,
      env: { ...process.env, TERM: "dumb" }
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {}
    }, timeoutMs)
    const collect = (chunk, target) => {
      const text = chunk.toString("utf8")
      if (target === "out") stdout = (stdout + text).slice(-30000)
      else stderr = (stderr + text).slice(-30000)
    }
    child.stdout.on("data", (chunk) => collect(chunk, "out"))
    child.stderr.on("data", (chunk) => collect(chunk, "err"))
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

export async function previewFile(project, rel) {
  return safePath(project, rel)
}
