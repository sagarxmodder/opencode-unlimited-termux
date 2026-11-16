import fs from "node:fs"
import path from "node:path"
import { HttpError, mimeFor, uid } from "./util.js"

const MAX_BYTES = 15 * 1024 * 1024

export function ensureUploads(dataDir) {
  const dir = path.join(dataDir, "uploads")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function saveUpload(uploadsDir, file) {
  const name = String(file?.name || "upload").replace(/[\r\n"]/g, "").slice(0, 160)
  const type = String(file?.type || "application/octet-stream")
  const dataUrl = String(file?.dataUrl || "")
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new HttpError(400, "invalid upload data")
  const buffer = Buffer.from(match[3], "base64")
  if (!buffer.length) throw new HttpError(400, "empty upload")
  if (buffer.length > MAX_BYTES) throw new HttpError(413, "upload is larger than 15 MB")
  const ext = path.extname(name).toLowerCase() || {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "text/plain": ".txt"
  }[type] || ""
  const stored = `${uid()}${ext}`
  fs.writeFileSync(path.join(uploadsDir, stored), buffer, { mode: 0o600 })
  return {
    name,
    type,
    size: buffer.length,
    upload: stored,
    url: `/uploads/${stored}`,
    kind: type.startsWith("image/") ? "image" : "file",
    mime: mimeFor(stored)
  }
}

export function uploadPath(uploadsDir, name) {
  const base = path.basename(String(name || ""))
  const file = path.join(uploadsDir, base)
  if (!file.startsWith(path.resolve(uploadsDir))) throw new HttpError(403, "invalid upload")
  return file
}
