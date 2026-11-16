import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { all, getSettings, insertMessage, one, recordUsage, run, usageTotals } from "./db.js"
import { providerReady, providerRow, streamChat } from "./providers.js"
import {
  createProject,
  deleteProjectPath,
  projectById,
  projectTree,
  readProjectFile,
  readProjectInstructions,
  renameProjectPath,
  runCommand,
  searchProject,
  writeProjectFile
} from "./projects.js"
import { dayKey, estimateTokens, HttpError, monthKey, now, truncate, uid } from "./util.js"
import { pluginHooks } from "./plugins.js"
import { recordChange } from "./changes.js"

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders in the current project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative directory, default ." } },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "1-based start line" },
          limit: { type: "number", description: "Max lines, default 400" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search text across project files and return matching lines.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a project file. The user must approve the write.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact string in a project file. The user must approve the change.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" }
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or folder. The user must approve the deletion.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a project file. The user must approve the move.",
      parameters: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the project. The user must approve each command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Relative working directory" }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Create a new project folder. The user must approve it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      }
    }
  }
]

const MODE_PROMPTS = {
  plan: "MODE: PLAN. Read-only session. Inspect files, reason, and propose a concrete plan. Never modify files or run commands.",
  build: "MODE: BUILD. Implement the request end-to-end. Read before editing, keep changes focused, and verify with commands when useful.",
  debug: "MODE: DEBUG. Reproduce the problem, inspect logs and code, isolate the root cause, then apply the smallest correct fix.",
  review: "MODE: REVIEW. Read-only session. Review code for bugs, security issues, regressions, and missing tests. Report findings with file and line references."
}
const READ_ONLY_MODES = new Set(["plan", "review"])
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "rename_file", "run_command", "create_project"])

const pending = new Map()
const cooldowns = new Map()

function cooldownKey(providerId, model) {
  return `${providerId}:${model}`
}

function cooling(key) {
  const until = cooldowns.get(key) || 0
  if (until <= Date.now()) {
    cooldowns.delete(key)
    return false
  }
  return true
}

function safeEmit(emit, event, data) {
  try {
    emit(event, data)
  } catch {}
}

export function conversationContext(db, conversation, project) {
  return `Current project: ${project.name}\nPath: ${project.path}\nUse relative paths with the file tools. File writes, deletes and shell commands pause for user approval.`
}

function titleFrom(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim()
  return clean.length > 58 ? `${clean.slice(0, 58)}…` : clean || "New chat"
}

export function checkLimits(db, settings) {
  const daily = usageTotals(db, { day: dayKey() })
  const monthly = usageTotals(db, { month: monthKey() })
  const dailyTokens = Number(daily.tokens_in || 0) + Number(daily.tokens_out || 0)
  const monthlyTokens = Number(monthly.tokens_in || 0) + Number(monthly.tokens_out || 0)
  if (Number(settings.dailyTokenLimit) > 0 && dailyTokens >= Number(settings.dailyTokenLimit)) {
    throw new HttpError(429, `daily token limit reached (${dailyTokens.toLocaleString()})`)
  }
  if (Number(settings.monthlyTokenLimit) > 0 && monthlyTokens >= Number(settings.monthlyTokenLimit)) {
    throw new HttpError(429, `monthly token limit reached (${monthlyTokens.toLocaleString()})`)
  }
}

function candidateList(db, secret, conversation, settings) {
  const explicit = conversation.model && conversation.model !== "auto" && conversation.provider_id && conversation.provider_id !== "auto"
  if (explicit) {
    const provider = providerRow(db, conversation.provider_id)
    if (!provider) throw new HttpError(404, "selected provider no longer exists")
    if (!providerReady(provider, secret)) throw new HttpError(400, `${provider.name} has no API key`)
    return [{ provider, model: conversation.model }]
  }
  const rows = all(
    db,
    `SELECT m.*, p.name AS p_name, p.base_url, p.api_key, p.enabled, p.free AS p_free, p.kind, p.docs, p.headers, p.models_fetched_at
     FROM models m JOIN providers p ON p.id = m.provider_id
     WHERE p.enabled = 1
     ORDER BY m.updated_at DESC
     LIMIT 120`
  ).map((row) => ({
    provider: {
      id: row.provider_id,
      name: row.p_name,
      base_url: row.base_url,
      api_key: row.api_key,
      enabled: row.enabled,
      free: row.p_free,
      kind: row.kind,
      docs: row.docs,
      headers: row.headers,
      models_fetched_at: row.models_fetched_at
    },
    model: row.model,
    free: Boolean(row.free),
    updated: Number(row.updated_at || 0)
  }))
  const ready = rows.filter((item) => providerReady(item.provider, secret))
  if (!ready.length) throw new HttpError(400, "no enabled model with a key. Add a provider or start Ollama.")
  const freeFirst = settings.routing !== "paid-first"
  const sorted = [...ready].sort((a, b) => {
    if (a.free !== b.free) return freeFirst ? (a.free ? -1 : 1) : (a.free ? 1 : -1)
    if (a.provider.free !== b.provider.free) return freeFirst ? (a.provider.free ? -1 : 1) : (a.provider.free ? 1 : -1)
    return b.updated - a.updated
  })
  const fresh = sorted.filter((item) => !cooling(cooldownKey(item.provider.id, item.model)))
  const pool = fresh.length ? fresh : sorted
  const seen = new Set()
  const result = []
  for (const item of pool) {
    const key = cooldownKey(item.provider.id, item.model)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ provider: item.provider, model: item.model })
    if (result.length >= 6) break
  }
  return result
}

function toDataUrl(file) {
  const ext = path.extname(file).toLowerCase()
  const mime = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp"
  }[ext] || "application/octet-stream"
  const base64 = fs.readFileSync(file).toString("base64")
  return `data:${mime};base64,${base64}`
}

function attachmentParts(attachments, uploadsDir) {
  const parts = []
  for (const file of attachments || []) {
    if (!file || file.kind === "text") continue
    if (!/^image\//.test(file.type || "")) continue
    const filePath = path.join(uploadsDir, path.basename(String(file.upload || "")))
    if (!fs.existsSync(filePath)) continue
    parts.push({ type: "image_url", image_url: { url: toDataUrl(filePath) } })
  }
  return parts
}

function textAttachments(attachments) {
  return (attachments || [])
    .filter((file) => file?.text)
    .map((file) => `\n[Attached file: ${file.name}]\n${truncate(file.text, 12000)}`)
    .join("")
}

function messageForModel(row, uploadsDir) {
  if (row.role === "tool") {
    return {
      role: "tool",
      tool_call_id: row.tool_call_id || "",
      content: truncate(row.content || "", 20000)
    }
  }
  if (row.role === "assistant") {
    const toolCalls = JSON.parse(row.tool_calls || "[]")
    return {
      role: "assistant",
      content: row.content || "",
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    }
  }
  const attachments = JSON.parse(row.attachments || "[]")
  const images = attachmentParts(attachments, uploadsDir)
  let text = `${row.content || ""}${textAttachments(attachments)}`
  if (!images.length) return { role: "user", content: text }
  const content = []
  if (text) content.push({ type: "text", text })
  content.push(...images)
  return { role: "user", content }
}

export function buildMessages(db, conversation, settings, project, uploadsDir) {
  const mode = MODE_PROMPTS[conversation.mode] || MODE_PROMPTS.build
  const compactNote = conversation.compact_at ? "Earlier conversation was compacted. Continue from the recent messages only." : ""
  const guide = readProjectInstructions(project)
  const guideNote = guide
    ? `PROJECT INSTRUCTIONS from ${guide.path}. Follow them for this project's conventions, workflow, and requirements. They never override tool approvals or safety constraints.${guide.truncated ? " The file was truncated." : ""}\n\n${guide.content}`
    : ""
  const system = [conversation.system_prompt || settings.systemPrompt, mode, guideNote, compactNote, conversationContext(db, conversation, project)]
    .filter(Boolean)
    .join("\n\n")
  const rows = all(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", conversation.id)
    .filter((row) => ["user", "assistant", "tool"].includes(row.role))
    .filter((row) => !conversation.compact_at || Number(row.created_at) >= Number(conversation.compact_at))
  const mapped = rows.map((row) => messageForModel(row, uploadsDir))
  let start = 0
  let chars = 0
  for (let i = mapped.length - 1; i >= 0; i--) {
    const message = mapped[i]
    const size = typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length
    if (chars + size > settings.contextChars && start > 0) break
    chars += size
    start = i
    if (mapped.length - start >= 60) break
  }
  while (start < mapped.length && mapped[start].role === "tool") start--
  if (start < 0) start = 0
  return [{ role: "system", content: system }, ...mapped.slice(start)]
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((call, index) => {
    const fn = call.function || {}
    let args = fn.arguments
    if (typeof args === "string") {
      try {
        args = JSON.parse(args || "{}")
      } catch {
        args = { __parse_error: args }
      }
    }
    return {
      id: call.id || `call_${index}_${Date.now()}`,
      type: "function",
      function: {
        name: fn.name || "",
        arguments: typeof args === "string" ? args : JSON.stringify(args || {})
      },
      parsed: args && typeof args === "object" ? args : {}
    }
  })
}

async function requestApproval(db, conversation, kind, payload, emit, signal) {
  const id = uid()
  run(
    db,
    "INSERT INTO approvals (id, conversation_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    id,
    conversation.id,
    kind,
    JSON.stringify(payload),
    now()
  )
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (approved) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      pending.delete(id)
      run(db, "UPDATE approvals SET status = ? WHERE id = ?", approved ? "approved" : "denied", id)
      resolve(approved)
    }
    const onAbort = () => {
      finish(false)
      reject(new HttpError(499, "request cancelled"))
    }
    const timer = setTimeout(() => finish(false), 10 * 60 * 1000)
    pending.set(id, { approve: () => finish(true), deny: () => finish(false), conversationId: conversation.id })
    signal?.addEventListener("abort", onAbort, { once: true })
    safeEmit(emit, "approval", { id, kind, payload, conversationId: conversation.id, createdAt: now() })
  })
}

function approvalDescription(kind, payload) {
  if (kind === "run_command") return `Run command: ${payload.command}`
  if (kind === "write_file") return `Write file: ${payload.path}`
  if (kind === "edit_file") return `Edit file: ${payload.path}`
  if (kind === "delete_file") return `Delete: ${payload.path}`
  if (kind === "rename_file") return `Rename ${payload.from} → ${payload.to}`
  if (kind === "create_project") return `Create project: ${payload.name}`
  return kind
}

async function executeTool(db, secret, workspace, conversation, projectRef, call, emit, signal) {
  const name = call.function?.name || ""
  const args = call.parsed || {}
  const project = projectRef.current
  if (READ_ONLY_MODES.has(conversation.mode) && MUTATING_TOOLS.has(name)) {
    return { name, id: call.id, status: "error", output: `${conversation.mode} mode is read-only. Switch to build or debug first.`, args }
  }
  const status = (value, output, extra = {}) => ({
    name,
    id: call.id,
    status: value,
    output: truncate(output, 20000),
    args,
    summary: approvalDescription(value, args),
    ...extra
  })
  try {
    if (name === "list_files") {
      const tree = await projectTree(project, args.path || ".", 3)
      return status("done", JSON.stringify(tree, null, 2))
    }
    if (name === "read_file") {
      const file = await readProjectFile(project, args.path)
      if (file.binary) return status("error", "file is binary")
      let lines = file.content.split("\n")
      const offset = Math.max(1, Number(args.offset) || 1)
      const limit = Math.max(1, Math.min(2000, Number(args.limit) || 400))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice.map((line, index) => `${offset + index}: ${line}`).join("\n")
      return status("done", `${file.path}\n${numbered}`)
    }
    if (name === "search_files") {
      const results = await searchProject(project, args.query, args.path || ".")
      return status("done", results.length ? results.map((item) => `${item.path}:${item.line}: ${item.text}`).join("\n") : "no matches")
    }
    if (name === "write_file") {
      const approved = await requestApproval(db, conversation, "write_file", {
        path: args.path,
        bytes: String(args.content || "").length,
        preview: truncate(args.content || "", 6000)
      }, emit, signal)
      if (!approved) return status("denied", "User denied the file write.")
      let before = null
      try {
        const current = await readProjectFile(project, args.path)
        if (!current.binary) before = current.content
      } catch {}
      const result = await writeProjectFile(project, args.path, args.content || "")
      if (before !== String(args.content || "")) {
        recordChange(db, {
          conversationId: conversation.id,
          projectId: project.id,
          path: args.path,
          action: "write",
          before,
          after: String(args.content || "")
        })
      }
      safeEmit(emit, "file_changed", { projectId: project.id, path: args.path, action: "write" })
      return status("done", `wrote ${result.path} (${result.size} bytes)`)
    }
    if (name === "edit_file") {
      if (!args.old_string) return status("error", "old_string is required")
      const file = await readProjectFile(project, args.path)
      if (file.binary) return status("error", "file is binary")
      const count = file.content.split(args.old_string).length - 1
      if (count === 0) return status("error", "old_string was not found")
      if (count > 1) return status("error", `old_string appears ${count} times; provide a unique block`)
      const approved = await requestApproval(db, conversation, "edit_file", {
        path: args.path,
        oldString: truncate(args.old_string, 4000),
        newString: truncate(args.new_string || "", 4000)
      }, emit, signal)
      if (!approved) return status("denied", "User denied the edit.")
      const next = file.content.replace(args.old_string, () => args.new_string || "")
      await writeProjectFile(project, args.path, next)
      recordChange(db, {
        conversationId: conversation.id,
        projectId: project.id,
        path: args.path,
        action: "edit",
        before: file.content,
        after: next
      })
      safeEmit(emit, "file_changed", { projectId: project.id, path: args.path, action: "edit" })
      return status("done", `edited ${args.path}`)
    }
    if (name === "delete_file") {
      const approved = await requestApproval(db, conversation, "delete_file", { path: args.path }, emit, signal)
      if (!approved) return status("denied", "User denied the deletion.")
      let before = null
      try {
        const current = await readProjectFile(project, args.path)
        if (!current.binary) before = current.content
      } catch {}
      await deleteProjectPath(project, args.path)
      if (before !== null) {
        recordChange(db, {
          conversationId: conversation.id,
          projectId: project.id,
          path: args.path,
          action: "delete",
          before,
          after: null
        })
      }
      safeEmit(emit, "file_changed", { projectId: project.id, path: args.path, action: "delete" })
      return status("done", `deleted ${args.path}`)
    }
    if (name === "rename_file") {
      const approved = await requestApproval(db, conversation, "rename_file", { from: args.from, to: args.to }, emit, signal)
      if (!approved) return status("denied", "User denied the rename.")
      await renameProjectPath(project, args.from, args.to)
      recordChange(db, {
        conversationId: conversation.id,
        projectId: project.id,
        path: args.to,
        action: "rename",
        before: null,
        after: null,
        meta: { from: args.from, to: args.to }
      })
      safeEmit(emit, "file_changed", { projectId: project.id, path: args.to, action: "rename" })
      return status("done", `renamed ${args.from} → ${args.to}`)
    }
    if (name === "run_command") {
      if (!args.command) return status("error", "command is required")
      const cwd = args.cwd ? path.resolve(project.path, args.cwd) : project.path
      if (!cwd.startsWith(path.resolve(project.path))) return status("error", "cwd is outside the project")
      const approved = await requestApproval(db, conversation, "run_command", {
        command: args.command,
        cwd: path.relative(project.path, cwd) || ".",
        project: project.name
      }, emit, signal)
      if (!approved) return status("denied", "User denied the command.")
      safeEmit(emit, "command_start", { command: args.command })
      const result = await runCommand(cwd, args.command)
      safeEmit(emit, "command_end", { command: args.command, code: result.code })
      const output = [
        `exit code: ${result.code ?? "killed"}${result.timedOut ? " (timed out)" : ""}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : ""
      ].filter(Boolean).join("\n")
      return status("done", output)
    }
    if (name === "create_project") {
      const approved = await requestApproval(db, conversation, "create_project", { name: args.name }, emit, signal)
      if (!approved) return status("denied", "User denied project creation.")
      const created = createProject(db, workspace, args.name)
      if (!conversation.project_id) {
        run(db, "UPDATE conversations SET project_id = ? WHERE id = ?", created.id, conversation.id)
        conversation.project_id = created.id
      }
      projectRef.current = projectById(db, created.id, workspace)
      safeEmit(emit, "project", { project: created, conversationId: conversation.id })
      return status("done", `created project ${created.name} at ${created.path}`)
    }
    return status("error", `unknown tool: ${name}`)
  } catch (error) {
    if (error?.status === 499) throw error
    return status("error", error.message || String(error))
  }
}

export async function runChat({
  db,
  secret,
  dataDir,
  uploadsDir,
  workspace,
  conversationId,
  userText,
  attachments = [],
  emit,
  signal
}) {
  const settings = getSettings(db)
  const conversation = one(db, "SELECT * FROM conversations WHERE id = ?", conversationId)
  if (!conversation) throw new HttpError(404, "conversation not found")
  const projectRef = { current: projectById(db, conversation.project_id, workspace) }
  if (userText !== undefined && userText !== null) {
    insertMessage(db, {
      conversationId,
      role: "user",
      content: userText,
      attachments,
      meta: { attachments: attachments.length }
    })
  }
  const messageCount = Number(one(db, "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", conversationId)?.n || 0)
  let titleUpdated = false
  if (settings.autoTitle && (conversation.title === "New chat" || !conversation.title) && userText) {
    const title = titleFrom(userText)
    run(db, "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", title, now(), conversationId)
    conversation.title = title
    titleUpdated = true
  }
  run(db, "UPDATE conversations SET updated_at = ? WHERE id = ?", now(), conversationId)
  const fresh = one(db, "SELECT * FROM conversations WHERE id = ?", conversationId)
  safeEmit(emit, "conversation", { conversation: fresh, messageCount, titleUpdated })
  checkLimits(db, settings)
  const hooks = await pluginHooks(db, dataDir)
  const maxSteps = Math.max(1, Math.min(30, Number(settings.maxAgentSteps) || 12))
  let steps = 0
  let finalText = ""
  let lastUsage = null
  while (steps < maxSteps) {
    steps++
    const candidates = candidateList(db, secret, conversation, settings)
    let result = null
    let used = null
    let partial = ""
    let lastError = null
    for (const candidate of candidates) {
      if (signal?.aborted) throw new HttpError(499, "request cancelled")
      const context = {
        provider: candidate.provider,
        providerName: candidate.provider.name,
        model: candidate.model,
        attempt: steps
      }
      safeEmit(emit, "meta", context)
      try {
        const messages = buildMessages(db, conversation, settings, projectRef.current, uploadsDir)
        if (hooks.beforeChat) {
          for (const hook of hooks.beforeChat) await hook({ messages, conversation: fresh, settings })
        }
        result = await streamChat(candidate.provider, secret, {
          model: candidate.model,
          messages,
          tools: TOOL_DEFS,
          temperature: settings.temperature,
          signal,
          onDelta: (text) => {
            partial += text
            finalText += text
            safeEmit(emit, "delta", { text })
          },
          onThinking: (text) => safeEmit(emit, "thinking", { text })
        })
        used = candidate
        cooldowns.delete(cooldownKey(candidate.provider.id, candidate.model))
        break
      } catch (error) {
        lastError = error
        if (error?.status === 499 || signal?.aborted) throw new HttpError(499, "request cancelled")
        cooldowns.set(cooldownKey(candidate.provider.id, candidate.model), Date.now() + 60000)
        safeEmit(emit, "notice", {
          message: `${candidate.provider.name} · ${candidate.model}: ${error.message}`,
          retry: candidate !== candidates[candidates.length - 1]
        })
        if (partial) break
      }
    }
    if (!result) {
      if (partial) {
        insertMessage(db, {
          conversationId,
          role: "assistant",
          content: partial,
          meta: { error: lastError?.message || "provider failed" }
        })
      }
      throw lastError || new HttpError(502, "all providers failed")
    }
    const toolCalls = normalizeToolCalls(result.toolCalls)
    const usage = result.usage || { input: 0, output: 0, total: 0 }
    lastUsage = usage
    recordUsage(db, {
      providerId: used.provider.id,
      model: used.model,
      tokensIn: usage.input,
      tokensOut: usage.output
    })
    safeEmit(emit, "usage", {
      ...usage,
      provider: used.provider.name,
      model: used.model
    })
    const toolResults = []
    const project = projectRef.current
    if (toolCalls.length) {
      for (const call of toolCalls) {
        safeEmit(emit, "tool_start", { id: call.id, name: call.function.name, args: call.parsed })
        const outcome = await executeTool(db, secret, workspace, conversation, projectRef, call, emit, signal)
        toolResults.push({ call, outcome })
        safeEmit(emit, "tool_end", {
          id: outcome.id,
          name: outcome.name,
          status: outcome.status,
          output: outcome.output,
          args: outcome.args
        })
      }
    }
    insertMessage(db, {
      conversationId,
      role: "assistant",
      content: result.content || "",
      toolCalls: toolCalls.map(({ parsed, ...call }) => call),
      meta: {
        provider: used.provider.id,
        providerName: used.provider.name,
        model: used.model,
        usage,
        thinking: result.thinking || ""
      }
    })
    for (const item of toolResults) {
      insertMessage(db, {
        conversationId,
        role: "tool",
        content: item.outcome.output,
        toolCallId: item.call.id,
        name: item.call.function.name,
        meta: { status: item.outcome.status }
      })
    }
    if (hooks.afterResponse) {
      for (const hook of hooks.afterResponse) {
        await hook({ conversation: fresh, content: result.content, usage }).catch(() => {})
      }
    }
    run(db, "UPDATE conversations SET updated_at = ? WHERE id = ?", now(), conversationId)
    if (!toolCalls.length) {
      const messageId = one(db, "SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", conversationId)?.id
      safeEmit(emit, "done", {
        messageId,
        usage,
        provider: used.provider.name,
        model: used.model,
        steps
      })
      return { text: result.content, usage, provider: used.provider.name, model: used.model }
    }
    safeEmit(emit, "step", { step: steps, tools: toolCalls.length })
  }
  throw new HttpError(500, `agent stopped after ${maxSteps} steps`)
}

export function resolveApproval(db, id, approved) {
  const entry = pending.get(id)
  if (!entry) {
    const row = one(db, "SELECT * FROM approvals WHERE id = ?", id)
    if (!row) throw new HttpError(404, "approval not found")
    if (row.status !== "pending") throw new HttpError(409, `approval already ${row.status}`)
    run(db, "UPDATE approvals SET status = ? WHERE id = ?", approved ? "approved" : "denied", id)
    return { status: approved ? "approved" : "denied", stale: true }
  }
  if (approved) entry.approve()
  else entry.deny()
  return { status: approved ? "approved" : "denied" }
}

export function cancelApprovals(conversationId) {
  for (const [id, entry] of pending) {
    if (entry.conversationId === conversationId) {
      entry.deny()
      pending.delete(id)
    }
  }
}

export function pendingApprovals() {
  return [...pending.entries()].map(([id, entry]) => ({ id, conversationId: entry.conversationId }))
}
