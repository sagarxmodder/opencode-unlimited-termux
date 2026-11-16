import { color, sanitize, span, textWidth, wrapSpans } from "./ansi.js"

function merge(...styles) {
  return styles.filter(Boolean).join(";").replace(/;;+/g, ";")
}

const INLINE = new RegExp(
  [
    "(`[^`\\n]+`)",
    "(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)",
    "(~~[^~\\n]+~~)",
    "(`[^`\\n]+`)",
    "(!?\\[[^\\]\\n]*\\]\\([^)\\s]+\\))",
    "(\\*[^*\\n]+\\*|_[^_\\n]+_)",
    "(https?:\\/\\/[^\\s<>)]+)"
  ].join("|"),
  "g"
)

function linkLabel(chunk) {
  const match = chunk.match(/^!?\[([^\]]*)\]\(([^)\s]+)\)$/)
  if (!match) return null
  return { text: match[1] || match[2], url: match[2] }
}

export function inlineSpans(value, base = color.text) {
  const text = sanitize(value)
  const out = []
  let last = 0
  INLINE.lastIndex = 0
  let match
  const pushPlain = (chunk) => {
    if (chunk) out.push(span(chunk, base))
  }
  while ((match = INLINE.exec(text))) {
    pushPlain(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith("`")) {
      out.push(span(token.slice(1, -1), merge(color.yellow, "48;5;236")))
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out.push(span(token.slice(2, -2), merge(base, color.bold, color.bright)))
    } else if (token.startsWith("~~")) {
      out.push(span(token.slice(2, -2), merge(base, color.strike, color.faint)))
    } else if (token.startsWith("[") || token.startsWith("![")) {
      const link = linkLabel(token)
      if (link) {
        out.push(span(link.text, merge(color.blue, color.underline)))
        if (link.url !== link.text && textWidth(link.url) < 70) out.push(span(` (${link.url})`, color.faint))
      } else {
        out.push(span(token, base))
      }
    } else if (token.startsWith("*") || token.startsWith("_")) {
      out.push(span(token.slice(1, -1), merge(base, color.italic)))
    } else if (token.startsWith("http")) {
      out.push(span(token, merge(color.blue, color.underline)))
    }
    last = match.index + token.length
  }
  pushPlain(text.slice(last))
  return out.length ? out : [span("", base)]
}

const KEYWORDS = {
  js: "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|super|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|get|set",
  ts: "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|implements|interface|type|enum|new|this|super|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|readonly|public|private|protected|as|satisfies|namespace|declare",
  py: "def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|yield|lambda|pass|global|nonlocal|assert|async|await|and|or|not|in|is|None|True|False",
  sh: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|echo|cd|set|source|shift|trap|exit"
}

function langFamily(lang) {
  const key = String(lang || "").toLowerCase()
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(key)) return "js"
  if (["ts", "tsx", "typescript"].includes(key)) return "ts"
  if (["py", "python"].includes(key)) return "py"
  if (["sh", "bash", "zsh", "shell", "console"].includes(key)) return "sh"
  if (["json", "jsonc"].includes(key)) return "json"
  if (["html", "xml", "svg", "vue"].includes(key)) return "html"
  if (["css", "scss", "less"].includes(key)) return "css"
  return key
}

function tokenRegex(family) {
  const keyword = KEYWORDS[family]
  const parts = []
  if (family === "py" || family === "sh") parts.push("(#[^\\n]*)")
  else if (family !== "json" && family !== "css" && family !== "html") parts.push("(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)")
  parts.push("(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\\\n]|\\\\.)*`)")
  if (keyword) parts.push(`(\\b(?:${keyword})\\b)`)
  parts.push("(\\b\\d+(?:\\.\\d+)?\\b)")
  parts.push("(\\b[A-Za-z_$][\\w$]*(?=\\s*\\())")
  parts.push("(\\b[A-Z][A-Za-z0-9_]*\\b)")
  return new RegExp(parts.join("|"), "g")
}

const TOKEN_STYLES = [color.faint, color.green, color.violetBold, color.orange, color.cyan, color.yellow]

export function highlightCode(line, lang) {
  const family = langFamily(lang)
  const base = color.muted
  if (!family || family === "text" || family === "txt" || family === "md" || family === "markdown") {
    return [span(line, base)]
  }
  const regex = tokenRegex(family)
  const out = []
  let last = 0
  let match
  while ((match = regex.exec(line))) {
    if (match.index > last) out.push(span(line.slice(last, match.index), base))
    let index = match.slice(1).findIndex((part) => part !== undefined)
    let style = TOKEN_STYLES[index] || base
    if (index === 1) style = color.green
    if (index === 2) style = merge(color.violetBold, color.bold)
    if (index === 3) style = color.orange
    if (index === 4) style = color.cyan
    if (index === 5) style = color.yellow
    out.push(span(match[0], style))
    last = match.index + match[0].length
    if (match[0].length === 0) regex.lastIndex++
  }
  if (last < line.length) out.push(span(line.slice(last), base))
  return out.length ? out : [span(line, base)]
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")
}

function renderTable(header, rows, width) {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1)
  const widths = Array.from({ length: columns }, (_, index) => {
    let size = textWidth(header[index] || "")
    for (const row of rows) size = Math.max(size, textWidth(row[index] || ""))
    return Math.max(2, Math.min(size, 40))
  })
  const gap = 3
  let available = width - gap * (columns - 1)
  let total = widths.reduce((sum, value) => sum + value, 0)
  while (total > available && widths.some((value) => value > 3)) {
    let largest = 0
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[largest]) largest = i
    widths[largest]--
    total--
  }
  const lines = []
  const compose = (cells, style) => {
    const out = []
    for (let i = 0; i < columns; i++) {
      let cell = cells[i] || ""
      if (textWidth(cell) > widths[i]) {
        let cut = ""
        let used = 0
        for (const ch of cell) {
          const size = textWidth(ch)
          if (used + size > widths[i] - 1) break
          cut += ch
          used += size
        }
        cell = `${cut}…`
      }
      if (i) out.push(span(" │ ", color.border))
      out.push(span(cell, style))
      const rest = widths[i] - textWidth(cell)
      if (rest > 0) out.push(span(" ".repeat(rest), style))
    }
    return out
  }
  lines.push(compose(header, merge(color.bright, color.bold)))
  const rule = []
  for (let i = 0; i < columns; i++) {
    if (i) rule.push(span("─┼─", color.border))
    rule.push(span("─".repeat(widths[i]), color.border))
  }
  lines.push(rule)
  for (const row of rows) lines.push(compose(row, color.text))
  return lines
}

export function renderMarkdown(value, width, { base = color.text } = {}) {
  const limit = Math.max(8, width)
  const text = sanitize(value).replace(/\t/g, "  ")
  const source = text.split("\n")
  const lines = []
  const blocks = []
  let index = 0

  const blank = () => {
    if (!lines.length) return
    const last = lines[lines.length - 1]
    if (last.length === 0) return
    lines.push([])
  }

  while (index < source.length) {
    const raw = source[index]
    const line = raw.replace(/\s+$/, "")

    if (!line.trim()) {
      blank()
      index++
      continue
    }

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w#+.-]*)\s*$/)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2] || ""
      const body = []
      index++
      while (index < source.length && !source[index].trim().startsWith(marker)) {
        body.push(source[index])
        index++
      }
      if (index < source.length) index++
      blocks.push(body.join("\n"))
      const header = [span("▏ ", color.faint), span(lang || "code", merge(color.muted, color.bold))]
      if (body.length) header.push(span(`  ${body.length} ${body.length === 1 ? "line" : "lines"}`, color.ghost))
      lines.push(header)
      const prefix = 2
      const inner = Math.max(4, limit - prefix)
      if (!body.length) {
        lines.push([span("▏ ", color.faint), span("(empty)", color.ghost)])
      }
      for (const codeLine of body) {
        const spans = highlightCode(codeLine, lang)
        const wrapped = wrapSpans(spans, inner)
        for (const part of wrapped.length ? wrapped : [[]]) {
          lines.push([span("▏ ", color.faint), ...part])
        }
      }
      blank()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blank()
      const level = heading[1].length
      const style = level <= 2
        ? merge(color.violetBold, color.bold)
        : level === 3
          ? merge(color.blueBold, color.bold)
          : merge(color.bright, color.bold)
      lines.push(...wrapSpans(inlineSpans(heading[2], style), limit))
      if (level === 1) lines.push([span("─".repeat(Math.min(limit, 48)), color.border)])
      blank()
      index++
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blank()
      lines.push([span("─".repeat(Math.min(limit, 60)), color.border)])
      blank()
      index++
      continue
    }

    if (line.includes("|") && index + 1 < source.length && isTableSeparator(source[index + 1])) {
      const header = splitTableRow(line)
      const rows = []
      index += 2
      while (index < source.length && source[index].includes("|") && source[index].trim()) {
        rows.push(splitTableRow(source[index]))
        index++
      }
      blank()
      lines.push(...renderTable(header, rows, limit))
      blank()
      continue
    }

    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      const body = []
      while (index < source.length) {
        const next = source[index].match(/^\s*>\s?(.*)$/)
        if (!next) break
        body.push(next[1])
        index++
      }
      const content = body.join(" ")
      const wrapped = wrapSpans(inlineSpans(content, merge(color.muted, color.italic)), Math.max(4, limit - 2))
      for (const part of wrapped) lines.push([span("│ ", color.border), ...part])
      blank()
      continue
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (list) {
      const indent = Math.min(6, Math.floor(list[1].length / 2))
      const ordered = /^\d/.test(list[2])
      let marker = ordered ? list[2].replace(/[.)]$/, ".") : "•"
      let content = list[3]
      let prefixStyle = color.violet
      const task = content.match(/^\[([ xX])]\s+(.*)$/)
      if (task) {
        const done = task[1].toLowerCase() === "x"
        marker = done ? "✓" : "○"
        prefixStyle = done ? color.green : color.faint
        content = task[2]
      }
      const prefix = `${"  ".repeat(indent)}${marker} `
      const wrapped = wrapSpans(inlineSpans(content, base), Math.max(4, limit - textWidth(prefix) - 2))
      lines.push([span(prefix.replace(/\s+$/, " "), prefixStyle), ...(wrapped[0] || [])])
      for (let i = 1; i < wrapped.length; i++) {
        lines.push([span(" ".repeat(textWidth(prefix)), ""), ...wrapped[i]])
      }
      index++
      continue
    }

    const paragraph = []
    while (index < source.length) {
      const next = source[index]
      if (!next.trim()) break
      if (/^\s*(`{3,}|~{3,})/.test(next)) break
      if (/^(#{1,6})\s+/.test(next)) break
      if (/^\s*>\s?/.test(next)) break
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(next)) break
      if (index + 1 < source.length && next.includes("|") && isTableSeparator(source[index + 1])) break
      paragraph.push(next.trim())
      index++
    }
    blank()
    const paragraphText = paragraph.join(" ")
    lines.push(...wrapSpans(inlineSpans(paragraphText, base), limit))
    blank()
  }

  while (lines.length && lines[lines.length - 1].length === 0) lines.pop()
  return { lines, blocks, text }
}

export function plainLines(value, width, style = color.muted) {
  return wrapSpans([span(sanitize(value), style)], width)
}

export function formatArgs(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args
  try {
    const text = JSON.stringify(args)
    return text === "{}" ? "" : text
  } catch {
    return String(args)
  }
}

export function toolSummary(name, args) {
  const value = args && typeof args === "object" ? args : {}
  switch (name) {
    case "read_file":
      return value.path || ""
    case "write_file":
      return value.path || ""
    case "edit_file":
      return value.path || ""
    case "list_files":
      return value.path || "."
    case "search_files":
      return value.query ? `/${value.query}/` : ""
    case "run_command":
      return value.command || ""
    case "delete_file":
      return value.path || ""
    case "rename_file":
      return [value.from, value.to].filter(Boolean).join(" → ")
    case "create_project":
      return value.name || ""
    default:
      return formatArgs(args)
  }
}
