const CSI_LETTERS = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "center",
  F: "end",
  H: "home",
  Z: "shifttab"
}

const CSI_TILDE = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12"
}

function modifier(opts, mod) {
  if (!mod || mod <= 1) return opts
  const bits = mod - 1
  return {
    ...opts,
    shift: Boolean(bits & 1) || opts.shift,
    alt: Boolean(bits & 2) || opts.alt,
    ctrl: Boolean(bits & 4) || opts.ctrl
  }
}

function names(code) {
  if (code === 13) return "enter"
  if (code === 9) return "tab"
  if (code === 127 || code === 8) return "backspace"
  if (code === 27) return "escape"
  if (code === 32) return "space"
  if (code === 0) return "space"
  return ""
}

export class KeyParser {
  constructor() {
    this.buffer = ""
  }

  get pending() {
    return this.buffer
  }

  reset() {
    this.buffer = ""
  }

  feed(chunk) {
    if (chunk) this.buffer += String(chunk)
    const keys = []
    let index = 0
    while (index < this.buffer.length) {
      const result = this.read(index)
      if (!result) break
      if (result.key) keys.push(result.key)
      index = result.next
    }
    this.buffer = this.buffer.slice(index)
    return keys
  }

  flush() {
    const keys = []
    while (this.buffer) {
      const result = this.read(0, true)
      if (!result) {
        this.buffer = ""
        break
      }
      if (result.key) keys.push(result.key)
      this.buffer = this.buffer.slice(result.next)
    }
    return keys
  }

  read(index, force = false) {
    const buffer = this.buffer
    const rest = buffer.length - index
    const ch = buffer[index]

    if (ch === "\x1b") {
      if (rest === 1) return force ? { next: index + 1, key: { name: "escape" } } : null

      if (buffer.startsWith("\x1b[200~", index)) {
        const end = buffer.indexOf("\x1b[201~", index + 6)
        if (end === -1) return force ? { next: buffer.length, key: { name: "paste", text: buffer.slice(index + 6) } } : null
        return { next: end + 6, key: { name: "paste", text: buffer.slice(index + 6, end) } }
      }

      const next = buffer[index + 1]
      if (next === "[") return csiAt(buffer, index, force)
      if (next === "O") {
        if (rest < 3) return force ? { next: buffer.length } : null
        const code = buffer[index + 2]
        const name = CSI_LETTERS[code]
        if (name) {
          return { next: index + 3, key: name === "shifttab" ? { name, shift: true } : { name } }
        }
        return { next: index + 3, key: null }
      }
      if (next === "]") {
        const bel = buffer.indexOf("\x07", index)
        const st = buffer.indexOf("\x1b\\", index)
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        if (end === -1) return force ? { next: buffer.length, key: null } : null
        return { next: end + (end === bel ? 1 : 2), key: null }
      }
      if (next === "\r" || next === "\n") return { next: index + 2, key: { name: "newline" } }
      if (next === "\x7f" || next === "\x08") return { next: index + 2, key: { name: "backspace", alt: true } }
      if (next === "\x1b") return { next: index + 1, key: { name: "escape" } }

      const cp = buffer.codePointAt(index + 1)
      const text = String.fromCodePoint(cp)
      return { next: index + 1 + text.length, key: { name: "char", text, alt: true } }
    }

    if (ch === "\r") return { next: index + 1, key: { name: "enter" } }
    if (ch === "\n") return { next: index + 1, key: { name: "newline" } }
    if (ch === "\t") return { next: index + 1, key: { name: "tab" } }
    if (ch === "\x7f" || ch === "\x08") return { next: index + 1, key: { name: "backspace" } }
    if (ch === "\x00") return { next: index + 1, key: { name: "char", text: " ", ctrl: true } }

    const code = buffer.charCodeAt(index)
    if (code > 0 && code < 27) {
      return {
        next: index + 1,
        key: { name: "ctrl", key: String.fromCharCode(code + 96) }
      }
    }
    if (code === 28) return { next: index + 1, key: { name: "ctrl", key: "\\" } }
    if (code === 29) return { next: index + 1, key: { name: "ctrl", key: "]" } }
    if (code === 30) return { next: index + 1, key: { name: "ctrl", key: "^" } }
    if (code === 31) return { next: index + 1, key: { name: "ctrl", key: "_" } }

    const cp = buffer.codePointAt(index)
    const text = String.fromCodePoint(cp)
    return { next: index + text.length, key: { name: "char", text } }
  }
}

function csiAt(buffer, index, force) {
  const start = index + 2
  let cursor = start
  while (cursor < buffer.length && !/[@-~]/.test(buffer[cursor])) cursor++
  if (cursor >= buffer.length) return force ? { next: buffer.length, key: null } : null
  const body = buffer.slice(start, cursor)
  const final = buffer[cursor]
  const next = cursor + 1

  if (body.startsWith("<") || body.startsWith("?") || body.startsWith(">")) {
    return { next, key: null }
  }

  const params = body ? body.split(";") : []
  const first = Number(params[0] || 0)

  if (final === "u") {
    const code = first || Number(params[0])
    const mod = Number(params[1] || 1)
    return { next, key: unicodeKey(code, mod) }
  }

  if (final === "~") {
    if (first === 27 && params.length >= 3) {
      const code = Number(params[2])
      const mod = Number(params[1] || 1)
      return { next, key: unicodeKey(code, mod) }
    }
    const name = CSI_TILDE[first]
    if (!name) return { next, key: null }
    return { next, key: modifier({ name }, Number(params[1] || 1)) }
  }

  const name = CSI_LETTERS[final]
  if (!name) return { next, key: null }
  if (name === "shifttab") return { next, key: { name, shift: true } }
  return { next, key: modifier({ name }, Number(params[1] || 1)) }
}

function unicodeKey(code, mod) {
  const flags = modifier({}, mod)
  if (code === 13) return flags.shift ? { name: "newline" } : { name: "enter", ...flags }
  if (code === 9) return { name: "tab", ...flags }
  if (code === 127 || code === 8) return { name: "backspace", ...flags }
  if (code === 27) return { name: "escape", ...flags }
  if (code < 32) return { name: "ctrl", key: String.fromCharCode(code + 96), ...flags }
  return { name: "char", text: String.fromCodePoint(code), ...flags }
}

export function isKey(key, name) {
  return Boolean(key && key.name === name)
}

export function isCtrl(key, letter) {
  return Boolean(key && key.name === "ctrl" && key.key === letter)
}

export function keyText(key) {
  if (!key) return ""
  if (key.name === "char") return key.text || ""
  if (key.name === "paste") return key.text || ""
  const names = { enter: "\r", newline: "\n", tab: "\t", backspace: "\x7f", escape: "\x1b", space: " ", delete: "\x1b[3~" }
  return names[key.name] || ""
}
