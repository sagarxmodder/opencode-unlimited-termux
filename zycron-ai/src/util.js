import crypto from "node:crypto"
import path from "node:path"

export const uid = () => crypto.randomUUID()
export const now = () => Date.now()

export function dayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function monthKey(date = new Date()) {
  return dayKey(date).slice(0, 7)
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project"
}

export function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function truncate(value, max = 4000) {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text
}

export function estimateTokens(value) {
  const text = String(value ?? "")
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function asBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

export function asInt(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : fallback
}

export class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

export function assert(condition, status, message) {
  if (!condition) throw new HttpError(status, message)
}

export async function readJsonBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, "request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new HttpError(400, "invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

export function sendJson(res, status, data, headers = {}) {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(data))
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...headers
  })
  res.end(body)
}

export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const message = error?.message || "internal error"
  sendJson(res, status, { error: message, ...(error?.extra || {}) })
}

export function mimeFor(file) {
  const ext = path.extname(file).toLowerCase()
  return {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".py": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8"
  }[ext] || "application/octet-stream"
}

export function languageFor(file) {
  const ext = path.extname(file).toLowerCase()
  return {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".jsx": "jsx",
    ".py": "python",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".json": "json",
    ".md": "markdown",
    ".sh": "bash",
    ".bash": "bash",
    ".sql": "sql",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".php": "php",
    ".rb": "ruby"
  }[ext] || "text"
}

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19)
}
