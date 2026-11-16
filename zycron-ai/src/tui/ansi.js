import { spawnSync } from "node:child_process"

export const ESC = "\x1b["
export const RESET = "\x1b[0m"
export const ALT_ON = "\x1b[?1049h"
export const ALT_OFF = "\x1b[?1049l"
export const CURSOR_HIDE = "\x1b[?25l"
export const CURSOR_SHOW = "\x1b[?25h"
export const WRAP_OFF = "\x1b[?7l"
export const WRAP_ON = "\x1b[?7h"
export const PASTE_ON = "\x1b[?2004h"
export const PASTE_OFF = "\x1b[?2004l"
export const SYNC_ON = "\x1b[?2026h"
export const SYNC_OFF = "\x1b[?2026l"

export const color = {
  text: "38;5;252",
  bright: "38;5;255;1",
  muted: "38;5;246",
  faint: "38;5;240",
  ghost: "38;5;238",
  border: "38;5;237",
  violet: "38;5;141",
  violetBold: "38;5;141;1",
  purple: "38;5;99",
  purpleBg: "48;5;236",
  blue: "38;5;111",
  blueBold: "38;5;111;1",
  cyan: "38;5;117",
  green: "38;5;114",
  greenBold: "38;5;114;1",
  yellow: "38;5;221",
  orange: "38;5;215",
  red: "38;5;203",
  redBold: "38;5;203;1",
  selection: "48;5;236",
  codeBg: "48;5;234",
  userGutter: "38;5;110",
  assistantGutter: "38;5;140",
  bold: "1",
  dim: "2",
  italic: "3",
  underline: "4",
  reverse: "7",
  strike: "9"
}

const ZERO_WIDTH = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x200b, 0x200f], [0x2060, 0x2064]
]

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd]
]

export function charWidth(cp) {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  for (const [start, end] of ZERO_WIDTH) if (cp >= start && cp <= end) return 0
  for (const [start, end] of WIDE) if (cp >= start && cp <= end) return 2
  return 1
}

export function sanitize(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
}

export function textWidth(value) {
  let width = 0
  for (const ch of String(value ?? "")) width += charWidth(ch.codePointAt(0))
  return width
}

export function truncate(value, width, ellipsis = "…") {
  const text = String(value ?? "")
  if (width <= 0) return ""
  if (textWidth(text) <= width) return text
  const limit = Math.max(0, width - textWidth(ellipsis))
  let out = ""
  let used = 0
  for (const ch of text) {
    const size = charWidth(ch.codePointAt(0))
    if (used + size > limit) break
    out += ch
    used += size
  }
  return out + ellipsis
}

export function pad(value, width) {
  const text = String(value ?? "")
  return text + " ".repeat(Math.max(0, width - textWidth(text)))
}

export function span(text, style = "") {
  return { t: String(text ?? ""), s: style }
}

export function paint(text, style) {
  return `${ESC}${style}m${text}${RESET}`
}

export function wrapSpans(spans, width) {
  const limit = Math.max(1, Math.floor(width))
  const lines = []
  let current = []
  let used = 0
  let lastSpace = -1

  const push = () => {
    while (current.length && current[current.length - 1].ch === " ") current.pop()
    lines.push(current)
    current = []
    used = 0
    lastSpace = -1
  }

  const append = (item) => {
    current.push(item)
    used += item.w
  }

  for (const entry of spans) {
    const text = String(entry.t ?? "")
    const style = entry.s || ""
    for (const ch of text) {
      if (ch === "\n") {
        push()
        continue
      }
      const cp = ch.codePointAt(0)
      const w = charWidth(cp)
      if (w === 0) {
        if (current.length) current[current.length - 1].ch += ch
        continue
      }
      if (used + w > limit && current.length) {
        if (lastSpace > 0 && lastSpace < current.length - 1) {
          const carry = current.slice(lastSpace + 1)
          current = current.slice(0, lastSpace)
          push()
          for (const item of carry) {
            if (item.ch === " " && current.length === 0) continue
            append(item)
          }
        } else {
          push()
        }
      }
      append({ ch, s: style, w })
      if (ch === " ") lastSpace = current.length - 1
    }
  }
  push()
  while (lines.length > 1 && lines[lines.length - 1].length === 0 && lines[lines.length - 2].length === 0) lines.pop()
  return lines.map((line) => {
    const out = []
    for (const item of line) {
      const last = out[out.length - 1]
      if (last && last.s === item.s) last.t += item.ch
      else out.push({ t: item.ch, s: item.s })
    }
    return out
  })
}

export function wrapText(text, width, style = "") {
  return wrapSpans([{ t: sanitize(text), s: style }], width)
}

export function clipSpans(spans, width, ellipsis = true) {
  const limit = Math.max(0, Math.floor(width))
  if (!limit) return []
  let used = 0
  const out = []
  for (const entry of spans) {
    let text = ""
    for (const ch of String(entry.t ?? "")) {
      const w = charWidth(ch.codePointAt(0))
      if (used + w > limit) {
        if (ellipsis && textWidth("…") <= limit - used) text += "…"
        if (text) out.push({ t: text, s: entry.s || "" })
        return out
      }
      text += ch
      used += w
    }
    if (text) out.push({ t: text, s: entry.s || "" })
  }
  return out
}

export function spansWidth(spans) {
  let width = 0
  for (const entry of spans) width += textWidth(entry.t)
  return width
}

export class Grid {
  constructor(width, height) {
    this.w = Math.max(1, Math.floor(width))
    this.h = Math.max(1, Math.floor(height))
    this.rows = Array.from({ length: this.h }, () =>
      Array.from({ length: this.w }, () => ({ ch: " ", s: "", w: 1, cont: false }))
    )
  }

  clear(style = "") {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) this.rows[y][x] = { ch: " ", s: style, w: 1, cont: false }
    }
  }

  set(x, y, ch, style, width) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return
    const row = this.rows[y]
    for (let i = x; i < Math.min(this.w, x + width); i++) {
      const old = row[i]
      if (old.cont && i > 0) row[i - 1] = { ch: " ", s: old.s, w: 1, cont: false }
      if (old.w === 2 && i + 1 < this.w) row[i + 1] = { ch: " ", s: old.s, w: 1, cont: false }
    }
    row[x] = { ch, s: style, w: width, cont: false }
    for (let i = 1; i < width; i++) {
      if (x + i < this.w) row[x + i] = { ch: "", s: style, w: 0, cont: true }
    }
  }

  put(x, y, text, style = "") {
    if (y < 0 || y >= this.h) return
    let cx = x
    for (const ch of sanitize(text)) {
      if (ch === "\n") break
      const w = charWidth(ch.codePointAt(0))
      if (w === 0) {
        if (cx > 0) {
          const cell = this.rows[y][cx - 1]
          if (cell && !cell.cont) cell.ch += ch
        }
        continue
      }
      if (cx + w > this.w) break
      this.set(cx, y, ch, style, w)
      cx += w
    }
  }

  putSpans(x, y, spans, limit = this.w - x, ellipsis = false) {
    const clipped = clipSpans(spans, limit, ellipsis)
    let cx = x
    for (const entry of clipped) {
      const start = cx
      this.put(cx, y, entry.t, entry.s)
      cx = start + textWidth(entry.t)
    }
  }

  fill(x, y, width, height, style = "") {
    for (let row = y; row < y + height; row++) {
      for (let col = x; col < x + width; col++) {
        if (row < 0 || row >= this.h || col < 0 || col >= this.w) continue
        const old = this.rows[row][col]
        if (old.cont && col > 0) this.rows[row][col - 1] = { ch: " ", s: old.s, w: 1, cont: false }
        this.rows[row][col] = { ch: " ", s: style, w: 1, cont: false }
      }
    }
  }

  box(x, y, width, height, { border = color.border, background = "", title = "", titleStyle = color.muted, hint = "", hintStyle = color.faint } = {}) {
    if (width < 2 || height < 2) return
    this.fill(x, y, width, height, background)
    const right = x + width - 1
    const bottom = y + height - 1
    this.put(x, y, "┌", border)
    this.put(right, y, "┐", border)
    this.put(x, bottom, "└", border)
    this.put(right, bottom, "┘", border)
    for (let col = x + 1; col < right; col++) {
      this.put(col, y, "─", border)
      this.put(col, bottom, "─", border)
    }
    for (let row = y + 1; row < bottom; row++) {
      this.put(x, row, "│", border)
      this.put(right, row, "│", border)
    }
    if (title) this.put(x + 2, y, ` ${truncate(title, Math.max(0, width - 6))} `, titleStyle)
    if (hint) this.putSpans(right - 2 - Math.min(textWidth(hint), width - 8), y, [{ t: truncate(hint, width - 8), s: hintStyle }])
  }

  toLines() {
    const lines = []
    for (let y = 0; y < this.h; y++) {
      let out = ""
      let active = null
      const row = this.rows[y]
      for (let x = 0; x < this.w; x++) {
        const cell = row[x]
        if (cell.cont) continue
        const style = cell.s || ""
        if (style !== active) {
          out += RESET
          const parts = style ? [style] : []
          if (!style.includes("48;5;") && !style.includes("48;2;") && !style.includes("49")) parts.push("48;5;16")
          out += `${ESC}${parts.join(";")}m`
          active = style
        }
        out += cell.ch
      }
      out += RESET
      lines.push(out)
    }
    return lines
  }

  toPlain() {
    return this.rows.map((row) => row.filter((cell) => !cell.cont).map((cell) => cell.ch).join(""))
  }
}

export function copyToClipboard(text) {
  const value = String(text ?? "")
  if (!value) return false
  try {
    const result = spawnSync("termux-clipboard-set", { input: value, encoding: "utf8" })
    if (!result.error && result.status === 0) return true
  } catch {}
  try {
    process.stdout.write(`\x1b]52;c;${Buffer.from(value, "utf8").toString("base64")}\x07`)
    return true
  } catch {
    return false
  }
}

export function timeAgo(timestamp) {
  const diff = Math.max(0, Date.now() - Number(timestamp || 0))
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return "now"
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`
  return new Date(Number(timestamp)).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function formatTokens(value) {
  const number = Math.max(0, Number(value) || 0)
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`
  return String(Math.round(number))
}
