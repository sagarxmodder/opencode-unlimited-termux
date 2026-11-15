import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

export const VERSION = "0.1.0"

export class AbortedError extends Error {
  constructor(message = "aborted") {
    super(message)
    this.name = "AbortedError"
    this.kind = "abort"
  }
}

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(`HTTP ${status}`)
    this.name = "HttpError"
    this.status = status
    this.body = body
    this.headers = headers
  }
}

export function timestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function sessionStamp(date = new Date()) {
  return `${timestamp(date).replace(/[:T]/g, "-")}-${crypto.randomBytes(2).toString("hex")}`
}

export function expandHome(input) {
  if (!input) return input
  const value = String(input)
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function truncate(text, max = 120) {
  const value = String(text ?? "")
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

export function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra === undefined ? base : extra
  const out = { ...(base || {}) }
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key]
    out[key] = value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
      ? deepMerge(current, value)
      : value
  }
  return out
}

export function parseKeys(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value).split(/[\n,;]/).map((item) => item.trim()).filter(Boolean)
}

export function unique(list) {
  return [...new Set(list)]
}

export function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "model"
}

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
