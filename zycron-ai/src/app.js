import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { runChat, resolveApproval, pendingApprovals } from "./agent.js"
import { listChanges, redoChange, undoChange } from "./changes.js"
import { createBackup, latestBackup } from "./backup.js"
import { getSettings, one, all, run, saveSettings, usageByProvider, usageTotals, insertMessage, getSettings as settingsOf } from "./db.js"
import {
  fetchModels,
  listModels,
  listProviders,
  providerRow,
  removeProvider,
  saveProvider
} from "./providers.js"
import {
  createProject,
  deleteProjectPath,
  listProjects,
  previewFile,
  projectById,
  projectTree,
  readProjectFile,
  readProjectInstructions,
  removeProject,
  renameProjectPath,
  replaceProject,
  runCommand,
  searchProject,
  writeProjectFile
} from "./projects.js"
import { listPlugins, setPluginEnabled } from "./plugins.js"
import { saveUpload, uploadPath } from "./uploads.js"
import {
  assetPath,
  createVideo,
  deleteVideo,
  generateStoryboard,
  getVideo,
  listVideos,
  patchVideo,
  saveRendered,
  saveSceneImage,
  startRender,
  videoFilePath,
  videoPublic
} from "./videos.js"
import {
  asBool,
  asInt,
  dayKey,
  HttpError,
  monthKey,
  mimeFor,
  now,
  readJsonBody,
  sendError,
  sendJson,
  truncate,
  uid
} from "./util.js"

const VERSION = "0.1.0"

function conversationPublic(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id,
    model: row.model,
    systemPrompt: row.system_prompt,
    projectId: row.project_id,
    mode: row.mode || "build",
    compactAt: Number(row.compact_at || 0),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    messageCount: Number(row.message_count || 0),
    preview: row.preview || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function messagePublic(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    attachments: JSON.parse(row.attachments || "[]"),
    toolCalls: JSON.parse(row.tool_calls || "[]"),
    toolCallId: row.tool_call_id,
    name: row.name,
    meta: JSON.parse(row.meta || "{}"),
    createdAt: row.created_at
  }
}

function conversationRows(db, q = "", { archived = "all", sort = "updated" } = {}) {
  const where = []
  const params = []
  if (q) {
    where.push("(c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))")
    params.push(`%${q}%`, `%${q}%`)
  }
  if (archived === "0") where.push("c.archived = 0")
  if (archived === "1") where.push("c.archived = 1")
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const order = sort === "created"
    ? "c.pinned DESC, c.created_at DESC"
    : sort === "title"
      ? "c.pinned DESC, c.title COLLATE NOCASE"
      : "c.pinned DESC, c.updated_at DESC"
  return all(
    db,
    `SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT substr(content, 1, 160) FROM messages m
        WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview
     FROM conversations c
     ${clause}
     ORDER BY ${order}
     LIMIT 400`,
    ...params
  ).map(conversationPublic)
}

function createConversation(db, input = {}) {
  const settings = getSettings(db)
  let providerId = String(input.providerId || settings.defaultProvider || "auto")
  let model = String(input.model || settings.defaultModel || "auto")
  if (!providerId || providerId === "auto" || !model) {
    providerId = "auto"
    model = "auto"
  }
  let projectId = input.projectId || null
  if (projectId && !one(db, "SELECT id FROM projects WHERE id = ?", projectId)) projectId = null
  const id = uid()
  run(
    db,
    `INSERT INTO conversations (id, title, provider_id, model, system_prompt, project_id, mode, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id,
    String(input.title || "New chat").slice(0, 160),
    providerId,
    model,
    String(input.systemPrompt || ""),
    projectId,
    ["plan", "build", "debug", "review"].includes(input.mode) ? input.mode : "build",
    now(),
    now()
  )
  return one(db, "SELECT * FROM conversations WHERE id = ?", id)
}

function sanitizeAttachments(db, files) {
  if (!Array.isArray(files)) return []
  return files.slice(0, 6).map((file) => ({
    name: String(file?.name || "attachment").slice(0, 160),
    type: String(file?.type || "application/octet-stream"),
    size: asInt(file?.size, 0),
    upload: file?.upload ? path.basename(String(file.upload)) : "",
    kind: file?.kind === "image" ? "image" : "text",
    text: file?.text ? truncate(String(file.text), 20000) : ""
  })).filter((file) => file.upload || file.text)
}

function authorize(req, url, token) {
  if (!token) return true
  const header = String(req.headers.authorization || "")
  const supplied = header.startsWith("Bearer ")
    ? header.slice(7)
    : String(req.headers["x-zycron-token"] || url.searchParams.get("token") || "")
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function publicSettings(db) {
  const settings = getSettings(db)
  return settings
}

function exportMarkdown(conversation, messages) {
  const lines = [`# ${conversation.title}`, "", `Model: ${conversation.model} · Created: ${new Date(conversation.createdAt).toISOString()}`, ""]
  for (const message of messages) {
    if (message.role === "tool") continue
    lines.push(`## ${message.role === "user" ? "You" : "ZYCRON AI"}`, "", message.content || "_empty_", "")
    if (message.attachments?.length) {
      lines.push(`Attachments: ${message.attachments.map((file) => file.name).join(", ")}`, "")
    }
  }
  return lines.join("\n")
}

export function createApp({ db, secret, dataDir, uploadsDir, workspace, publicDir, token = "" }) {
  const controllers = new Map()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    const pathname = decodeURIComponent(url.pathname)
    const segments = pathname.split("/").filter(Boolean)
    const method = req.method || "GET"
    res.setHeader("x-content-type-options", "nosniff")
    res.setHeader("referrer-policy", "no-referrer")
    try {
      if (method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, version: VERSION, name: "ZYCRON AI" })
      }
      if (pathname.startsWith("/api/") && !authorize(req, url, token)) {
        return sendJson(res, 401, { error: "unauthorized" })
      }
      if (!pathname.startsWith("/api/")) {
        if (pathname.startsWith("/uploads/")) {
          if (!authorize(req, url, token)) return sendJson(res, 401, { error: "unauthorized" })
          return await serveUpload(req, res, pathname)
        }
        if (pathname.startsWith("/preview/")) {
          if (!authorize(req, url, token)) return sendJson(res, 401, { error: "unauthorized" })
          return await servePreview(req, res, segments)
        }
        return await serveStatic(req, res, pathname)
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        const settings = publicSettings(db)
        const usage = {
          today: usageTotals(db, { day: dayKey() }),
          month: usageTotals(db, { month: monthKey() }),
          byProvider: usageByProvider(db)
        }
        return sendJson(res, 200, {
          app: { name: "ZYCRON AI", version: VERSION, workspace, tokenRequired: Boolean(token), today: dayKey() },
          settings,
          providers: listProviders(db, secret),
          models: listModels(db),
          conversations: conversationRows(db),
          projects: listProjects(db),
          plugins: await listPlugins(db, dataDir),
          usage,
          videos: listVideos(db),
          backup: latestBackup(dataDir)
        })
      }

      if (method === "GET" && pathname === "/api/settings") {
        return sendJson(res, 200, { settings: publicSettings(db) })
      }
      if (method === "PATCH" && pathname === "/api/settings") {
        const body = await readJsonBody(req)
        const patch = {}
        const allowed = ["systemPrompt", "defaultProvider", "defaultModel", "routing", "maxAgentSteps", "contextChars", "approvalsRequired", "dailyTokenLimit", "monthlyTokenLimit", "temperature", "autoTitle", "theme", "accent"]
        for (const key of allowed) if (key in body) patch[key] = body[key]
        if ("systemPrompt" in patch) patch.systemPrompt = String(patch.systemPrompt).slice(0, 8000)
        if ("routing" in patch && !["free-first", "paid-first", "manual"].includes(patch.routing)) patch.routing = "free-first"
        if ("maxAgentSteps" in patch) patch.maxAgentSteps = Math.max(1, Math.min(30, asInt(patch.maxAgentSteps, 12)))
        if ("contextChars" in patch) patch.contextChars = Math.max(4000, Math.min(400000, asInt(patch.contextChars, 60000)))
        if ("dailyTokenLimit" in patch) patch.dailyTokenLimit = Math.max(0, asInt(patch.dailyTokenLimit, 0))
        if ("monthlyTokenLimit" in patch) patch.monthlyTokenLimit = Math.max(0, asInt(patch.monthlyTokenLimit, 0))
        if ("temperature" in patch) patch.temperature = Math.max(0, Math.min(2, Number(patch.temperature) || 0.7))
        if ("autoTitle" in patch) patch.autoTitle = asBool(patch.autoTitle, true)
        if ("approvalsRequired" in patch) patch.approvalsRequired = true
        if ("theme" in patch) patch.theme = ["amoled", "midnight"].includes(patch.theme) ? patch.theme : "amoled"
        if ("accent" in patch) patch.accent = ["violet", "blue", "cyan", "rose"].includes(patch.accent) ? patch.accent : "violet"
        const settings = saveSettings(db, patch)
        return sendJson(res, 200, { settings })
      }

      if (method === "GET" && pathname === "/api/usage") {
        return sendJson(res, 200, {
          today: usageTotals(db, { day: dayKey() }),
          month: usageTotals(db, { month: monthKey() }),
          byProvider: usageByProvider(db),
          settings: publicSettings(db)
        })
      }

      if (pathname === "/api/conversations" && method === "GET") {
        return sendJson(res, 200, {
          conversations: conversationRows(db, url.searchParams.get("q") || "", {
            archived: url.searchParams.get("archived") || "all",
            sort: url.searchParams.get("sort") || "updated"
          })
        })
      }
      if (pathname === "/api/conversations" && method === "DELETE") {
        const keepPinned = url.searchParams.get("keepPinned") === "1"
        const rows = all(db, `SELECT id FROM conversations ${keepPinned ? "WHERE pinned = 0" : ""}`)
        for (const row of rows) {
          run(db, "DELETE FROM messages WHERE conversation_id = ?", row.id)
          run(db, "DELETE FROM approvals WHERE conversation_id = ?", row.id)
          run(db, "DELETE FROM conversations WHERE id = ?", row.id)
        }
        return sendJson(res, 200, { deleted: rows.length })
      }
      if (pathname === "/api/conversations" && method === "POST") {
        const body = await readJsonBody(req)
        const conversation = createConversation(db, body)
        return sendJson(res, 201, { conversation: conversationPublic(conversation) })
      }

      if (segments[1] === "conversations" && segments[2]) {
        const id = segments[2]
        const conversation = one(db, "SELECT * FROM conversations WHERE id = ?", id)
        if (!conversation) throw new HttpError(404, "conversation not found")
        if (method === "GET" && segments.length === 3) {
          const messages = all(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", id).map(messagePublic)
          return sendJson(res, 200, {
            conversation: conversationPublic(conversation),
            messages,
            project: conversation.project_id ? projectById(db, conversation.project_id, workspace) : null
          })
        }
        if (method === "PATCH" && segments.length === 3) {
          const body = await readJsonBody(req)
          const fields = []
          const values = []
          if ("title" in body) {
            fields.push("title = ?")
            values.push(String(body.title || "New chat").slice(0, 160))
          }
          if ("providerId" in body) {
            fields.push("provider_id = ?")
            values.push(String(body.providerId || "auto"))
          }
          if ("model" in body) {
            fields.push("model = ?")
            values.push(String(body.model || "auto"))
          }
          if ("systemPrompt" in body) {
            fields.push("system_prompt = ?")
            values.push(String(body.systemPrompt || "").slice(0, 8000))
          }
          if ("projectId" in body) {
            const projectId = body.projectId && one(db, "SELECT id FROM projects WHERE id = ?", body.projectId) ? body.projectId : null
            fields.push("project_id = ?")
            values.push(projectId)
          }
          if ("mode" in body) {
            fields.push("mode = ?")
            values.push(["plan", "build", "debug", "review"].includes(body.mode) ? body.mode : "build")
          }
          if ("archived" in body) {
            fields.push("archived = ?")
            values.push(asBool(body.archived) ? 1 : 0)
          }
          if ("pinned" in body) {
            fields.push("pinned = ?")
            values.push(asBool(body.pinned) ? 1 : 0)
          }
          fields.push("updated_at = ?")
          values.push(now())
          run(db, `UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`, ...values, id)
          return sendJson(res, 200, { conversation: conversationPublic(one(db, "SELECT * FROM conversations WHERE id = ?", id)) })
        }
        if (method === "DELETE" && segments.length === 3) {
          run(db, "DELETE FROM messages WHERE conversation_id = ?", id)
          run(db, "DELETE FROM approvals WHERE conversation_id = ?", id)
          run(db, "DELETE FROM conversations WHERE id = ?", id)
          return sendJson(res, 200, { ok: true })
        }
        if (method === "POST" && segments[3] === "duplicate") {
          const copyId = uid()
          run(
            db,
            `INSERT INTO conversations (id, title, provider_id, model, system_prompt, project_id, mode, compact_at, pinned, archived, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
            copyId,
            `${conversation.title} copy`.slice(0, 160),
            conversation.provider_id,
            conversation.model,
            conversation.system_prompt,
            conversation.project_id,
            conversation.mode || "build",
            now(),
            now()
          )
          for (const row of all(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", id)) {
            insertMessage(db, {
              conversationId: copyId,
              role: row.role,
              content: row.content,
              attachments: JSON.parse(row.attachments || "[]"),
              toolCalls: JSON.parse(row.tool_calls || "[]"),
              toolCallId: row.tool_call_id,
              name: row.name,
              meta: JSON.parse(row.meta || "{}"),
              createdAt: row.created_at
            })
          }
          return sendJson(res, 201, { conversation: conversationPublic(one(db, "SELECT * FROM conversations WHERE id = ?", copyId)) })
        }
        if (method === "POST" && segments[3] === "clear") {
          run(db, "DELETE FROM messages WHERE conversation_id = ?", id)
          run(db, "UPDATE conversations SET compact_at = 0, updated_at = ? WHERE id = ?", now(), id)
          return sendJson(res, 200, { ok: true, conversation: conversationPublic(one(db, "SELECT * FROM conversations WHERE id = ?", id)) })
        }
        if (method === "POST" && segments[3] === "compact") {
          run(db, "UPDATE conversations SET compact_at = ?, updated_at = ? WHERE id = ?", now(), now(), id)
          const updated = one(db, "SELECT * FROM conversations WHERE id = ?", id)
          return sendJson(res, 200, { conversation: conversationPublic(updated), compacted: true })
        }
        if (method === "POST" && segments[3] === "undo") {
          return sendJson(res, 200, { result: await undoChange(db, workspace, id), changes: listChanges(db, id) })
        }
        if (method === "POST" && segments[3] === "redo") {
          return sendJson(res, 200, { result: await redoChange(db, workspace, id), changes: listChanges(db, id) })
        }
        if (method === "GET" && segments[3] === "changes") {
          return sendJson(res, 200, { changes: listChanges(db, id) })
        }
        if (method === "GET" && segments[3] === "export") {
          const messages = all(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", id).map(messagePublic)
          const format = url.searchParams.get("format") || "md"
          if (format === "json") {
            const payload = Buffer.from(JSON.stringify({ conversation: conversationPublic(conversation), messages }, null, 2))
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="zycron-${id}.json"`,
              "content-length": payload.length
            })
            return res.end(payload)
          }
          const payload = Buffer.from(exportMarkdown(conversationPublic(conversation), messages))
          res.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="zycron-${id}.md"`,
            "content-length": payload.length
          })
          return res.end(payload)
        }
      }

      if (segments[1] === "messages" && segments[2] && method === "PATCH") {
        const body = await readJsonBody(req)
        const row = one(db, "SELECT * FROM messages WHERE id = ?", segments[2])
        if (!row) throw new HttpError(404, "message not found")
        if (row.role !== "user") throw new HttpError(400, "only user messages can be edited")
        const content = String(body.content ?? "").slice(0, 100000)
        run(db, "UPDATE messages SET content = ? WHERE id = ?", content, row.id)
        run(
          db,
          "DELETE FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND rowid > (SELECT rowid FROM messages WHERE id = ?)))",
          row.conversation_id,
          row.created_at,
          row.created_at,
          row.id
        )
        run(db, "UPDATE conversations SET updated_at = ? WHERE id = ?", now(), row.conversation_id)
        return sendJson(res, 200, { ok: true, conversationId: row.conversation_id })
      }

      if (pathname === "/api/chat" && method === "POST") {
        const body = await readJsonBody(req)
        let conversation = body.conversationId ? one(db, "SELECT * FROM conversations WHERE id = ?", body.conversationId) : null
        if (!conversation) conversation = createConversation(db, body)
        if (body.providerId || body.model) {
          const providerId = body.providerId || conversation.provider_id
          const model = body.model || conversation.model
          run(db, "UPDATE conversations SET provider_id = ?, model = ? WHERE id = ?", providerId, model, conversation.id)
          conversation = one(db, "SELECT * FROM conversations WHERE id = ?", conversation.id)
        }
        const text = String(body.message || "").slice(0, 100000)
        const attachments = sanitizeAttachments(db, body.attachments)
        if (!text.trim() && !attachments.length) throw new HttpError(400, "message is empty")
        return startChat(req, res, {
          conversation,
          userText: text,
          attachments
        })
      }

      if (pathname === "/api/chat/regenerate" && method === "POST") {
        const body = await readJsonBody(req)
        const conversation = one(db, "SELECT * FROM conversations WHERE id = ?", body.conversationId)
        if (!conversation) throw new HttpError(404, "conversation not found")
        const lastUser = one(
          db,
          "SELECT rowid AS rid, * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
          conversation.id
        )
        if (!lastUser) throw new HttpError(400, "no user message to regenerate")
        run(
          db,
          "DELETE FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))",
          conversation.id,
          lastUser.created_at,
          lastUser.created_at,
          lastUser.rid
        )
        run(db, "UPDATE conversations SET updated_at = ? WHERE id = ?", now(), conversation.id)
        return startChat(req, res, { conversation, userText: null, attachments: [], regenerate: true })
      }

      if (segments[1] === "chat" && segments[3] === "stop" && method === "POST") {
        const controller = controllers.get(segments[2])
        if (controller) controller.abort()
        return sendJson(res, 200, { stopped: Boolean(controller) })
      }

      if (segments[1] === "approvals" && segments[2] && method === "POST") {
        const body = await readJsonBody(req)
        return sendJson(res, 200, resolveApproval(db, segments[2], Boolean(body.approve)))
      }
      if (pathname === "/api/approvals" && method === "GET") {
        const ids = new Set(pendingApprovals().map((item) => item.id))
        const rows = all(db, "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20")
          .filter((row) => ids.has(row.id))
          .map((row) => ({
            id: row.id,
            conversationId: row.conversation_id,
            kind: row.kind,
            payload: JSON.parse(row.payload || "{}"),
            createdAt: row.created_at
          }))
        return sendJson(res, 200, { approvals: rows })
      }

      if (pathname === "/api/providers" && method === "GET") {
        return sendJson(res, 200, { providers: listProviders(db, secret) })
      }
      if (pathname === "/api/providers" && method === "POST") {
        const body = await readJsonBody(req)
        const provider = saveProvider(db, secret, body)
        return sendJson(res, 201, { provider })
      }
      if (segments[1] === "providers" && segments[2]) {
        const id = segments[2]
        if (method === "PATCH" && segments.length === 3) {
          const body = await readJsonBody(req)
          const provider = saveProvider(db, secret, { ...body, id })
          return sendJson(res, 200, { provider })
        }
        if (method === "DELETE" && segments.length === 3) {
          removeProvider(db, id)
          return sendJson(res, 200, { ok: true })
        }
        if (method === "POST" && segments[3] === "models") {
          const models = await fetchModels(db, secret, id)
          return sendJson(res, 200, { models, provider: listProviders(db, secret).find((item) => item.id === id) })
        }
      }

      if (pathname === "/api/videos" && method === "GET") {
        return sendJson(res, 200, { videos: listVideos(db) })
      }
      if (pathname === "/api/videos" && method === "POST") {
        const body = await readJsonBody(req)
        return sendJson(res, 201, { video: createVideo(db, body) })
      }
      if (segments[1] === "videos" && segments[2] === "assets" && segments[3] && method === "GET") {
        const file = assetPath(dataDir, segments[3])
        const stat = await fsp.stat(file)
        res.writeHead(200, {
          "content-type": mimeFor(file),
          "content-length": stat.size,
          "cache-control": "private, max-age=86400"
        })
        if (req.method === "HEAD") return res.end()
        return fs.createReadStream(file).pipe(res)
      }
      if (segments[1] === "videos" && segments[2]) {
        const id = segments[2]
        if (method === "GET" && segments.length === 3) {
          return sendJson(res, 200, { video: videoPublic(getVideo(db, id)) })
        }
        if (method === "PATCH" && segments.length === 3) {
          const body = await readJsonBody(req)
          return sendJson(res, 200, { video: patchVideo(db, id, body) })
        }
        if (method === "DELETE" && segments.length === 3) {
          await deleteVideo(db, dataDir, id)
          return sendJson(res, 200, { ok: true })
        }
        if (method === "POST" && segments[3] === "storyboard") {
          const body = await readJsonBody(req)
          return sendJson(res, 200, { video: await generateStoryboard(db, dataDir, secret, id, body) })
        }
        if (method === "POST" && segments[3] === "scenes" && segments[5] === "image") {
          return sendJson(res, 200, { video: await saveSceneImage(db, dataDir, id, segments[4], req) })
        }
        if (method === "POST" && segments[3] === "render") {
          return sendJson(res, 200, { video: startRender(db, dataDir, secret, id) })
        }
        if (segments[3] === "file") {
          if (method === "POST" || method === "PUT") {
            return sendJson(res, 200, { video: await saveRendered(db, dataDir, id, req) })
          }
          if (method === "GET" || method === "HEAD") {
            return await serveVideoFile(req, res, videoFilePath(db, dataDir, id))
          }
        }
      }

      if (pathname === "/api/models" && method === "GET") {
        return sendJson(res, 200, {
          models: listModels(db, {
            q: url.searchParams.get("q") || "",
            providerId: url.searchParams.get("provider") || "",
            free: url.searchParams.get("free") || ""
          })
        })
      }

      if (pathname === "/api/projects" && method === "GET") {
        return sendJson(res, 200, { projects: listProjects(db), workspace })
      }
      if (pathname === "/api/projects" && method === "POST") {
        const body = await readJsonBody(req)
        const project = createProject(db, workspace, body.name)
        return sendJson(res, 201, { project })
      }
      if (segments[1] === "projects" && segments[2]) {
        const project = projectById(db, segments[2], workspace)
        if (method === "DELETE" && segments.length === 3) {
          removeProject(db, project.id, url.searchParams.get("deleteFiles") === "1", workspace)
          return sendJson(res, 200, { ok: true })
        }
        if (method === "GET" && segments[3] === "tree") {
          const tree = await projectTree(project, url.searchParams.get("path") || ".", Math.max(1, Math.min(8, asInt(url.searchParams.get("depth"), 4))))
          return sendJson(res, 200, { project, tree })
        }
        if (method === "GET" && segments[3] === "instructions") {
          return sendJson(res, 200, { instructions: readProjectInstructions(project) })
        }
        if (method === "GET" && segments[3] === "file") {
          const file = await readProjectFile(project, url.searchParams.get("path") || "")
          return sendJson(res, 200, { file })
        }
        if (method === "PUT" && segments[3] === "file") {
          const body = await readJsonBody(req)
          const result = await writeProjectFile(project, body.path, body.content)
          return sendJson(res, 200, { file: result })
        }
        if (method === "DELETE" && segments[3] === "file") {
          const result = await deleteProjectPath(project, url.searchParams.get("path") || "")
          return sendJson(res, 200, { ok: true, ...result })
        }
        if (method === "POST" && segments[3] === "rename") {
          const body = await readJsonBody(req)
          return sendJson(res, 200, { result: await renameProjectPath(project, body.from, body.to) })
        }
        if (method === "GET" && segments[3] === "search") {
          const results = await searchProject(project, url.searchParams.get("q") || "", url.searchParams.get("path") || ".")
          return sendJson(res, 200, { results })
        }
        if (method === "POST" && segments[3] === "replace") {
          const body = await readJsonBody(req)
          return sendJson(res, 200, { result: await replaceProject(project, body.query, body.replacement, body.path || ".") })
        }
        if (method === "POST" && segments[3] === "run") {
          const body = await readJsonBody(req)
          if (!String(body.command || "").trim()) throw new HttpError(400, "command is empty")
          const result = await runCommand(project.path, body.command)
          return sendJson(res, 200, { result })
        }
      }

      if (pathname === "/api/backup" && method === "POST") {
        return sendJson(res, 200, { backup: createBackup(db, dataDir, "manual") })
      }
      if (pathname === "/api/backup" && method === "GET") {
        return sendJson(res, 200, { backup: latestBackup(dataDir) })
      }

      if (pathname === "/api/uploads" && method === "POST") {
        const body = await readJsonBody(req)
        return sendJson(res, 201, { upload: saveUpload(uploadsDir, body) })
      }

      if (pathname === "/api/plugins" && method === "GET") {
        return sendJson(res, 200, { plugins: await listPlugins(db, dataDir) })
      }
      if (segments[1] === "plugins" && segments[2] && method === "PATCH") {
        const body = await readJsonBody(req)
        return sendJson(res, 200, setPluginEnabled(db, segments[2], Boolean(body.enabled)))
      }

      throw new HttpError(404, "not found")
    } catch (error) {
      sendError(res, error)
    }

    async function startChat(req, res, { conversation, userText, attachments, regenerate = false }) {
      const requestId = uid()
      if (controllers.has(requestId)) throw new HttpError(409, "request already running")
      const controller = new AbortController()
      controllers.set(requestId, controller)
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      })
      let closed = false
      const emit = (event, data) => {
        if (closed || res.writableEnded) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      const heartbeat = setInterval(() => {
        if (!closed && !res.writableEnded) res.write(": keep-alive\n\n")
      }, 15000)
      const onClose = () => {
        if (!closed) controller.abort()
      }
      res.on("close", onClose)
      try {
        emit("ready", {
          requestId,
          conversationId: conversation.id,
          conversation: conversationPublic(conversation),
          regenerate
        })
        await runChat({
          db,
          secret,
          dataDir,
          uploadsDir,
          workspace,
          conversationId: conversation.id,
          userText,
          attachments,
          emit,
          signal: controller.signal
        })
      } catch (error) {
        if (error?.status === 499 || controller.signal.aborted) {
          emit("stopped", { requestId })
        } else {
          emit("error", { message: error?.message || "chat failed", status: error?.status || 500 })
        }
      } finally {
        closed = true
        clearInterval(heartbeat)
        res.off("close", onClose)
        controllers.delete(requestId)
        if (!res.writableEnded) res.end()
      }
    }

    async function serveVideoFile(req, res, file) {
      const stat = await fsp.stat(file)
      const type = mimeFor(file)
      const range = req.headers.range
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range)
        const start = match && match[1] ? Number(match[1]) : 0
        const end = match && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
        if (start >= stat.size || start > end) {
          res.writeHead(416, { "content-range": `bytes */${stat.size}` })
          return res.end()
        }
        res.writeHead(206, {
          "content-type": type,
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=3600"
        })
        if (req.method === "HEAD") return res.end()
        return fs.createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, {
        "content-type": type,
        "content-length": stat.size,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=3600"
      })
      if (req.method === "HEAD") return res.end()
      fs.createReadStream(file).pipe(res)
    }

    async function serveStatic(req, res, pathname) {
      let relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
      if (relative === "flow" || relative === "flow/") relative = "flow.html"
      if (!relative || relative.includes("\0")) throw new HttpError(404, "not found")
      const root = path.resolve(publicDir)
      const file = path.resolve(root, relative)
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new HttpError(403, "forbidden")
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        throw new HttpError(404, "not found")
      }
      if (!stat.isFile()) throw new HttpError(404, "not found")
      const headers = {
        "content-type": mimeFor(file),
        "content-length": stat.size,
        "cache-control": relative.endsWith(".html") ? "no-cache" : "public, max-age=3600",
        "content-security-policy": relative.endsWith(".html")
          ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
          : "default-src 'self'"
      }
      res.writeHead(200, headers)
      if (req.method === "HEAD") return res.end()
      fs.createReadStream(file).pipe(res)
    }

    async function serveUpload(req, res, pathname) {
      const name = pathname.split("/").pop()
      const file = uploadPath(uploadsDir, name)
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        throw new HttpError(404, "not found")
      }
      res.writeHead(200, {
        "content-type": mimeFor(file),
        "content-length": stat.size,
        "cache-control": "private, max-age=86400",
        "content-disposition": `inline; filename="${path.basename(file)}"`
      })
      if (req.method === "HEAD") return res.end()
      fs.createReadStream(file).pipe(res)
    }

    async function servePreview(req, res, segments) {
      const id = segments[1]
      let rel = segments.slice(2).map((part) => decodeURIComponent(part)).join("/")
      if (!rel) rel = "index.html"
      const project = projectById(db, id, workspace)
      let file
      try {
        file = await previewFile(project, rel)
        const stat = await fsp.stat(file)
        if (stat.isDirectory()) {
          file = await previewFile(project, path.join(rel, "index.html"))
        }
      } catch {
        throw new HttpError(404, "not found")
      }
      const stat = await fsp.stat(file)
      res.writeHead(200, {
        "content-type": mimeFor(file),
        "content-length": stat.size,
        "cache-control": "no-cache"
      })
      if (req.method === "HEAD") return res.end()
      fs.createReadStream(file).pipe(res)
    }
  })
  return server
}
