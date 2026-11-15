import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { collect, httpRequest } from "./providers.js"
import { escapeRegExp, expandHome, truncate } from "./util.js"

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"])
const MAX_READ_LINES = 2000
const MAX_LINE = 2000
const MAX_GREP_FILE = 2 * 1024 * 1024
const MAX_FETCH = 2 * 1024 * 1024

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file from disk. Returns numbered lines. Use offset and limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, absolute or relative to the working directory." },
          offset: { type: "number", description: "1-based first line to read. Default 1." },
          limit: { type: "number", description: "Maximum lines to return. Default and max 2000." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Full file content." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace an exact string in a file. Fails unless the old string matches exactly once, unless replaceAll is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          oldString: { type: "string", description: "Exact text to replace." },
          newString: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace every occurrence. Default false." }
        },
        required: ["path", "oldString", "newString"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern. Supports *, **, ? and character classes. Skips node_modules and .git.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.js or *.md." },
          path: { type: "string", description: "Directory to search. Default working directory." },
          limit: { type: "number", description: "Maximum results. Default 200." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression. Returns file:line:text matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: { type: "string", description: "Directory to search. Default working directory." },
          include: { type: "string", description: "Optional glob filter, e.g. *.js or src/**/*.ts." },
          ignoreCase: { type: "boolean", description: "Case-insensitive search." },
          limit: { type: "number", description: "Maximum matches. Default 200." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the working directory. Prefer read/glob/grep for inspection.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run with bash -lc." },
          timeout: { type: "number", description: "Timeout in milliseconds. Default 120000, max 600000." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "webfetch",
      description: "Fetch a URL and return its content as plain text. HTML is converted to text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP or HTTPS URL." }
        },
        required: ["url"]
      }
    }
  }
]

function resolvePath(cwd, input) {
  if (!input) throw new Error("path required")
  const value = String(input)
  if (value === "~" || value.startsWith("~/")) return expandHome(value)
  return path.resolve(cwd, value)
}

async function readTextFile(file, maxBytes = MAX_GREP_FILE) {
  const stat = await fs.promises.stat(file)
  if (!stat.isFile()) return null
  if (maxBytes && stat.size > maxBytes) return null
  const buffer = await fs.promises.readFile(file)
  if (buffer.subarray(0, 8192).includes(0)) return null
  return buffer.toString("utf8")
}

async function walkFiles(root, visit) {
  let visited = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      visited++
      if (visited > 50000) return
      if (await visit(path.join(dir, entry.name))) return
    }
  }
}

function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, "/")
  let out = "^"
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 2
        } else {
          out += ".*"
          i++
        }
      } else {
        out += "[^/]*"
      }
    } else if (ch === "?") {
      out += "[^/]"
    } else if (ch === "[") {
      const end = normalized.indexOf("]", i + 1)
      if (end === -1) {
        out += "\\["
      } else {
        let body = normalized.slice(i + 1, end)
        if (body.startsWith("!")) body = `^${body.slice(1)}`
        out += `[${body}]`
        i = end
      }
    } else {
      out += escapeRegExp(ch)
    }
  }
  return new RegExp(`${out}$`)
}

function matchGlob(pattern, relative, basename) {
  const regex = globToRegExp(pattern)
  if (regex.test(relative)) return true
  if (!String(pattern).includes("/")) return regex.test(basename)
  return false
}

function numberLines(lines, start, end) {
  const width = String(end).length
  const out = []
  for (let i = start; i < end; i++) {
    let line = lines[i] ?? ""
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} … [line truncated]`
    out.push(`${String(i + 1).padStart(width)}| ${line}`)
  }
  return out.join("\n")
}

async function toolRead(args, context) {
  const file = resolvePath(context.cwd, args.path)
  const stat = await fs.promises.stat(file)
  if (!stat.isFile()) throw new Error(`not a file: ${file}`)
  if (stat.size > 5 * 1024 * 1024) throw new Error(`file too large (${stat.size} bytes): ${file}`)
  const raw = await fs.promises.readFile(file)
  if (raw.subarray(0, 8192).includes(0)) throw new Error(`binary file: ${file}`)
  const lines = raw.toString("utf8").split(/\r?\n/)
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(args.limit) || MAX_READ_LINES)))
  if (offset > lines.length) return `${file}: only ${lines.length} lines`
  const end = Math.min(lines.length, offset - 1 + limit)
  const body = numberLines(lines, offset - 1, end)
  const suffix = end < lines.length ? `\n\n[${lines.length - end} more lines, use offset/limit]` : ""
  return `${file}\n${body}${suffix}`
}

async function toolWrite(args, context) {
  const file = resolvePath(context.cwd, args.path)
  const content = String(args.content ?? "")
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, content)
  return `Wrote ${Buffer.byteLength(content)} bytes to ${file}`
}

async function toolEdit(args, context) {
  const file = resolvePath(context.cwd, args.path)
  const oldString = String(args.oldString ?? "")
  const newString = String(args.newString ?? "")
  if (!oldString) throw new Error("oldString required")
  const text = await fs.promises.readFile(file, "utf8")
  const count = oldString === "" ? 0 : text.split(oldString).length - 1
  if (count === 0) throw new Error(`oldString not found in ${file}`)
  if (count > 1 && !args.replaceAll) {
    throw new Error(`oldString matches ${count} times in ${file}; add more context or set replaceAll`)
  }
  const next = args.replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, () => newString)
  await fs.promises.writeFile(file, next)
  return `Replaced ${args.replaceAll ? count : 1} occurrence(s) in ${file}`
}

async function toolGlob(args, context) {
  const pattern = String(args.pattern || "")
  if (!pattern) throw new Error("pattern required")
  const root = resolvePath(context.cwd, args.path || ".")
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(args.limit) || 200)))
  const matches = []
  await walkFiles(root, async (file) => {
    const relative = path.relative(root, file).split(path.sep).join("/")
    if (!matchGlob(pattern, relative, path.basename(file))) return false
    matches.push(relative)
    return matches.length >= limit
  })
  if (!matches.length) return `No files matching ${pattern} in ${root}`
  return `${matches.join("\n")}${matches.length >= limit ? `\n[limit ${limit} reached]` : ""}`
}

async function toolGrep(args, context) {
  const pattern = String(args.pattern || "")
  if (!pattern) throw new Error("pattern required")
  let regex
  try {
    regex = new RegExp(pattern, args.ignoreCase ? "i" : "")
  } catch (error) {
    throw new Error(`invalid regex: ${error.message}`)
  }
  const root = resolvePath(context.cwd, args.path || ".")
  const include = args.include ? String(args.include) : ""
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(args.limit) || 200)))
  const matches = []
  await walkFiles(root, async (file) => {
    const relative = path.relative(root, file).split(path.sep).join("/")
    const base = path.basename(file)
    if (include && !matchGlob(include, relative, base)) return false
    const text = await readTextFile(file)
    if (text == null) return false
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue
      matches.push(`${relative}:${i + 1}: ${truncate(lines[i].trim(), 300)}`)
      if (matches.length >= limit) return true
    }
    return false
  })
  if (!matches.length) return `No matches for ${pattern} in ${root}`
  return `${matches.join("\n")}${matches.length >= limit ? `\n[limit ${limit} reached]` : ""}`
}

function truncateOutput(text, limit = 100000) {
  const value = String(text || "")
  if (value.length <= limit) return value
  const head = value.slice(0, Math.floor(limit * 0.7))
  const tail = value.slice(-Math.floor(limit * 0.2))
  return `${head}\n… [${value.length - head.length - tail.length} chars truncated] …\n${tail}`
}

function toolBash(args, context) {
  const command = String(args.command || "")
  if (!command.trim()) throw new Error("command required")
  const timeout = Math.min(600000, Math.max(1000, Number(args.timeout) || 120000))
  const result = spawnSync("bash", ["-lc", command], {
    cwd: context.cwd,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    env: process.env
  })
  const parts = [`exit: ${result.status == null ? "killed" : result.status}`]
  const stdout = truncateOutput(result.stdout)
  const stderr = truncateOutput(result.stderr)
  parts.push("stdout:", stdout.trimEnd() || "(empty)")
  parts.push("stderr:", stderr.trimEnd() || "(empty)")
  if (result.error) parts.push(`error: ${result.error.message}`)
  return parts.join("\n")
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (match, name) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " "
    })[name] || match)
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
  ).trim()
}

async function toolWebfetch(args) {
  const initial = String(args.url || "")
  if (!/^https?:\/\//i.test(initial)) throw new Error("url must start with http:// or https://")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    let url = initial
    let response
    for (let redirect = 0; redirect <= 5; redirect++) {
      response = await httpRequest({
        url,
        headers: { "user-agent": "freecode/0.1 (+https://github.com/freecode-ai/freecode)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8" },
        signal: controller.signal
      })
      const status = response.status
      const location = response.headers.location
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.stream.destroy()
        if (redirect === 5) throw new Error("too many redirects")
        const next = new URL(location, url)
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(`redirected to unsupported protocol: ${next.protocol}`)
        }
        url = next.toString()
        continue
      }
      break
    }
    const type = String(response.headers["content-type"] || "text/plain")
    const raw = await collect(response.stream, MAX_FETCH)
    const text = /html/i.test(type) ? htmlToText(raw) : raw
    const body = text.length > 50000 ? `${text.slice(0, 50000)}\n\n[content truncated at 50000 chars]` : text
    return `HTTP ${response.status} ${type}\n${url}\n\n${body}`
  } catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted) throw new Error("webfetch timed out")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function executeTool(name, args = {}, context = {}) {
  const cwd = context.cwd || process.cwd()
  try {
    switch (name) {
      case "read":
        return await toolRead(args, { cwd })
      case "write":
        return await toolWrite(args, { cwd })
      case "edit":
        return await toolEdit(args, { cwd })
      case "glob":
        return await toolGlob(args, { cwd })
      case "grep":
        return await toolGrep(args, { cwd })
      case "bash":
        return toolBash(args, { cwd })
      case "webfetch":
        return await toolWebfetch(args)
      default:
        return `Error: unknown tool "${name}"`
    }
  } catch (error) {
    return `Error: ${error?.message || String(error)}`
  }
}
