import { all, one, run } from "./db.js"
import { deleteProjectPath, projectById, readProjectFile, renameProjectPath, writeProjectFile } from "./projects.js"
import { HttpError, now, uid } from "./util.js"

const MAX_SNAPSHOT = 1024 * 1024

export function recordChange(db, { conversationId, projectId, path, action, before = null, after = null, meta = {} }) {
  if (typeof before === "string" && before.length > MAX_SNAPSHOT) return null
  if (typeof after === "string" && after.length > MAX_SNAPSHOT) return null
  const id = uid()
  run(
    db,
    `INSERT INTO changes (id, conversation_id, project_id, path, action, before, after, meta, undone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    conversationId,
    projectId,
    String(path || ""),
    action,
    before,
    after,
    JSON.stringify(meta || {}),
    now()
  )
  return id
}

async function inverse(db, workspace, change) {
  const project = projectById(db, change.project_id, workspace)
  if (change.action === "rename") {
    const meta = JSON.parse(change.meta || "{}")
    await renameProjectPath(project, meta.to, meta.from)
    return `renamed ${meta.to} back to ${meta.from}`
  }
  if (change.before === null) {
    await deleteProjectPath(project, change.path)
    return `removed ${change.path}`
  }
  await writeProjectFile(project, change.path, change.before)
  return `restored ${change.path}`
}

async function forward(db, workspace, change) {
  const project = projectById(db, change.project_id, workspace)
  if (change.action === "rename") {
    const meta = JSON.parse(change.meta || "{}")
    await renameProjectPath(project, meta.from, meta.to)
    return `renamed ${meta.from} to ${meta.to}`
  }
  if (change.after === null) {
    await deleteProjectPath(project, change.path)
    return `deleted ${change.path}`
  }
  await writeProjectFile(project, change.path, change.after)
  return `reapplied ${change.path}`
}

export async function undoChange(db, workspace, conversationId) {
  const change = one(
    db,
    "SELECT * FROM changes WHERE conversation_id = ? AND undone = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1",
    conversationId
  )
  if (!change) throw new HttpError(404, "nothing to undo")
  const message = await inverse(db, workspace, change)
  run(db, "UPDATE changes SET undone = 1 WHERE id = ?", change.id)
  return { id: change.id, action: change.action, path: change.path, message }
}

export async function redoChange(db, workspace, conversationId) {
  const change = one(
    db,
    "SELECT * FROM changes WHERE conversation_id = ? AND undone = 1 ORDER BY created_at ASC, rowid ASC LIMIT 1",
    conversationId
  )
  if (!change) throw new HttpError(404, "nothing to redo")
  const message = await forward(db, workspace, change)
  run(db, "UPDATE changes SET undone = 0 WHERE id = ?", change.id)
  return { id: change.id, action: change.action, path: change.path, message }
}

export function listChanges(db, conversationId) {
  return all(db, "SELECT id, action, path, undone, created_at FROM changes WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50", conversationId)
}
