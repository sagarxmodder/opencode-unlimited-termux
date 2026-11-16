const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

const KEYWORDS = {
  js: "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined",
  ts: "abstract any as asserts async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
  sh: "case do done elif else esac fi for function if in local return select then time until while export readonly declare",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient try void volatile while true false",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true false null",
  css: "important media supports keyframes font-face import from to",
  sql: "select from where insert into update delete create table drop alter add primary key foreign references join left right inner outer on group by order having limit offset as and or not null values set distinct union all index"
}

const RULE_SETS = {
  js: [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y],
    ["str", /`(?:\\.|[^`\\])*`/y],
    ["num", /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy],
    ["key", keyRule("js")],
    ["fn", /\b[A-Za-z_$][\w$]*(?=\s*\()/y],
    ["type", /\b[A-Z][A-Za-z0-9_$]*\b/y]
  ],
  py: [
    ["com", /#[^\n]*/y],
    ["str", /"""[\s\S]*?"""/y],
    ["str", /'''[\s\S]*?'''/y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y],
    ["num", /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/iy],
    ["key", keyRule("py")],
    ["fn", /\b[A-Za-z_]\w*(?=\s*\()/y],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/y]
  ],
  sh: [
    ["com", /#[^\n]*/y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'[^']*'/y],
    ["key", keyRule("sh")],
    ["var", /\$\{[^}]+\}|\$[A-Za-z_]\w*/y],
    ["num", /\b\d+\b/y]
  ],
  go: [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /`[^`]*`/y],
    ["num", /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/iy],
    ["key", keyRule("go")],
    ["fn", /\b[A-Za-z_]\w*(?=\s*\()/y],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/y]
  ],
  rust: [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y],
    ["num", /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/iy],
    ["key", keyRule("rust")],
    ["fn", /\b[a-z_]\w*(?=\s*\()/y],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/y]
  ],
  java: [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y],
    ["num", /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)[lfd]?\b/iy],
    ["key", keyRule("java")],
    ["fn", /\b[A-Za-z_$][\w$]*(?=\s*\()/y],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/y]
  ],
  c: [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y],
    ["pre", /^\s*#\w+/my],
    ["num", /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)[ulf]?\b/iy],
    ["key", keyRule("c")],
    ["fn", /\b[A-Za-z_]\w*(?=\s*\()/y],
    ["type", /\b[A-Za-z_]\w*_t\b/y]
  ],
  css: [
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y],
    ["num", /-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|fr|deg)?\b/y],
    ["type", /--[\w-]+/y],
    ["fn", /#[\da-fA-F]{3,8}\b/y],
    ["key", /@[A-Za-z-]+/y]
  ],
  sql: [
    ["com", /--[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /'(?:''|[^'])*'/y],
    ["num", /\b\d+(?:\.\d+)?\b/y],
    ["key", new RegExp(`\\b(?:${KEYWORDS.sql.split(" ").join("|")})\\b`, "iy")],
    ["fn", /\b[A-Za-z_]\w*(?=\s*\()/y]
  ],
  html: [
    ["com", /<!--[\s\S]*?-->/y],
    ["tag", /<\/?[A-Za-z][\w:-]*/y],
    ["attr", /\b[A-Za-z_:][\w:.-]*(?=\s*=)/y],
    ["str", /"(?:\\.|[^"\\])*"/y],
    ["str", /'(?:\\.|[^'\\])*'/y]
  ]
}

function keyRule(name) {
  return new RegExp(`\\b(?:${KEYWORDS[name].split(" ").join("|")})\\b`, "y")
}

const LANGUAGE_ALIASES = {
  javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
  typescript: "ts", tsx: "ts",
  python: "py", py: "py",
  bash: "sh", shell: "sh", zsh: "sh", console: "sh",
  golang: "go", rs: "rust",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  json: "js", jsonc: "js",
  scss: "css", less: "css"
}

export function normalizeLanguage(language) {
  const key = String(language || "").trim().toLowerCase()
  return LANGUAGE_ALIASES[key] || key
}

function matchRule(code, index, rules) {
  let best = null
  for (const [type, regex] of rules) {
    regex.lastIndex = index
    const match = regex.exec(code)
    if (!match || match.index !== index || !match[0]) continue
    if (!best || match[0].length > best.text.length) best = { type, text: match[0] }
  }
  return best
}

export function highlightCode(code, language = "") {
  const source = String(code ?? "")
  const lang = normalizeLanguage(language)
  const rules = RULE_SETS[lang]
  if (!rules) return escapeHtml(source)
  let output = ""
  let index = 0
  while (index < source.length) {
    const hit = matchRule(source, index, rules)
    if (hit) {
      output += `<span class="tok-${hit.type}">${escapeHtml(hit.text)}</span>`
      index += hit.text.length
    } else {
      const next = source[index]
      output += escapeHtml(next)
      index++
    }
  }
  return output
}

function safeHref(value) {
  const href = String(value || "").trim().replace(/&amp;/g, "&")
  if (/^(https?:\/\/|mailto:)/i.test(href) || /^(\/|#|\.{0,2}\/)/.test(href)) return href
  return ""
}

export function renderInline(raw) {
  const tokens = []
  const stash = (html) => {
    const key = `\u0000Z${tokens.length}\u0000`
    tokens.push(html)
    return key
  }
  let text = String(raw ?? "")
  text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code class="inline">${escapeHtml(code)}</code>`))
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = safeHref(href)
    if (!safe) return label
    return stash(`<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`)
  })
  text = escapeHtml(text)
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/ {2,}\n/g, "<br>\n")
    .replace(/\n/g, "<br>")
  return text.replace(/\u0000Z(\d+)\u0000/g, (_, at) => tokens[Number(at)] || "")
}

function codeBlock(code, language) {
  const lang = String(language || "").trim() || "text"
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(lang)}</span><button class="copy-code" type="button"><svg class="icon"><use href="#i-copy"></use></svg>copy</button></div><pre><code>${highlightCode(code, lang)}</code></pre></div>`
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
}

function startsBlock(line) {
  return /^\s*(#{1,4}\s|```|~~~|>\s?|([-*+]|\d+\.)\s|\|.*\||-{3,}|\*{3,}|_{3,})/.test(line)
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")
  const output = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }
    const fence = /^\s*(```|~~~)\s*([\w.+-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1]
      const language = fence[2] || ""
      const code = []
      index++
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        code.push(lines[index])
        index++
      }
      if (index < lines.length) index++
      output.push(codeBlock(code.join("\n"), language))
      continue
    }
    const heading = /^\s*(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      output.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`)
      index++
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push("<hr>")
      index++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""))
        index++
      }
      output.push(`<blockquote>${quote.map((entry) => renderInline(entry)).join("<br>")}</blockquote>`)
      continue
    }
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]))
        index++
      }
      output.push(`<table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    const listMatch = /^\s*([-*+]|\d+\.)\s+/.exec(line)
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1])
      const items = []
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[index])
        if (!item) break
        let content = item[2]
        const task = /^\[([ xX])\]\s+(.*)$/.exec(content)
        if (task) {
          content = `<span class="task-box">${task[1].toLowerCase() === "x" ? "☑" : "☐"}</span> ${renderInline(task[2])}`
        } else {
          content = renderInline(content)
        }
        items.push(`<li>${content}</li>`)
        index++
      }
      output.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`)
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index])
      index++
    }
    output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`)
  }
  return output.join("\n")
}
