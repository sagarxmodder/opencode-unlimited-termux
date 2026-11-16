import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export function ensureSecret(dataDir) {
  const file = path.join(dataDir, "secret.key")
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file)
    if (key.length === 32) return key
  }
  const key = crypto.randomBytes(32)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, key, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  return key
}

export function encryptSecret(plain, key) {
  if (!plain) return ""
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const sealed = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), sealed.toString("base64url")].join(":")
}

export function decryptSecret(value, key) {
  if (!value) return ""
  const parts = String(value).split(":")
  if (parts.length !== 4 || parts[0] !== "v1") return ""
  try {
    const iv = Buffer.from(parts[1], "base64url")
    const tag = Buffer.from(parts[2], "base64url")
    const sealed = Buffer.from(parts[3], "base64url")
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8")
  } catch {
    return ""
  }
}

export function keyHint(plain) {
  if (!plain) return ""
  const text = String(plain)
  if (text.length <= 4) return "••••"
  return `••••${text.slice(-4)}`
}
