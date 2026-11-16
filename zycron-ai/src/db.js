import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PROVIDERS } from "./presets.js"
import { dayKey, monthKey, now, safeJson } from "./util.js"

export const DEFAULT_SETTINGS = {
  systemPrompt: "You are ZYCRON AI, a precise coding and reasoning assistant. Use tools only when they help. Read before editing, keep changes minimal, and explain what you changed.",
  defaultProvider: "auto",
  defaultModel: "auto",
  routing: "free-first",
  maxAgentSteps: 12,
  contextChars: 60000,
  approvalsRequired: true,
  dailyTokenLimit: 0,
  monthlyTokenLimit: 0,
  temperature: 0.7,
  autoTitle: true,
  theme: "amoled",
  accent: "violet"
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai',
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  free INTEGER NOT NULL DEFAULT 1,
  docs TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',
  models_fetched_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  label TEXT NOT NULL,
  free INTEGER NOT NULL DEFAULT 1,
  vision INTEGER NOT NULL DEFAULT 0,
  tools INTEGER NOT NULL DEFAULT 1,
  context INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT 'auto',
  model TEXT NOT NULL DEFAULT 'auto',
  system_prompt TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  mode TEXT NOT NULL DEFAULT 'build',
  compact_at INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  tool_call_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_conversation ON changes(conversation_id, created_at DESC);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_conversation ON approvals(conversation_id, created_at DESC);
CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_log(day);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'storyboard',
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  aspect TEXT NOT NULL DEFAULT '16:9',
  duration REAL NOT NULL DEFAULT 0,
  scenes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL DEFAULT '',
  poster TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_updated ON videos(updated_at);
`

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)
  ensureColumn(db, "conversations", "mode", "TEXT NOT NULL DEFAULT 'build'")
  ensureColumn(db, "conversations", "compact_at", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "conversations", "archived", "INTEGER NOT NULL DEFAULT 0")
  seed(db)
  return db
}

export const all = (db, sql, ...params) => db.prepare(sql).all(...params)
export const one = (db, sql, ...params) => db.prepare(sql).get(...params) || null
export const run = (db, sql, ...params) => db.prepare(sql).run(...params)

function seed(db) {
  const insertProvider = db.prepare(`
    INSERT OR IGNORE INTO providers
      (id, name, kind, base_url, api_key, enabled, free, docs, headers, models_fetched_at, created_at)
    VALUES (?, ?, 'openai', ?, '', ?, ?, ?, '{}', 0, ?)
  `)
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models
      (id, provider_id, model, label, free, vision, tools, context, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const provider of PROVIDERS) {
    insertProvider.run(
      provider.id,
      provider.name,
      provider.baseUrl,
      provider.keyless ? 1 : 0,
      provider.free ? 1 : 0,
      provider.docs || "",
      now()
    )
    for (const model of provider.models) {
      insertModel.run(
        `${provider.id}:${model.id}`,
        provider.id,
        model.id,
        model.label || model.id,
        model.free === false ? 0 : 1,
        model.vision ? 1 : 0,
        model.tools === false ? 0 : 1,
        Number(model.context) || 0,
        now()
      )
    }
  }
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, JSON.stringify(value))
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export function getSettings(db) {
  const settings = { ...DEFAULT_SETTINGS }
  for (const row of all(db, "SELECT key, value FROM settings")) {
    if (row.key in DEFAULT_SETTINGS) {
      const parsed = safeJson(row.value, DEFAULT_SETTINGS[row.key])
      settings[row.key] = parsed
    }
  }
  return settings
}

export function saveSettings(db, patch) {
  const statement = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue
    statement.run(key, JSON.stringify(value))
  }
  return getSettings(db)
}

export function recordUsage(db, { providerId, model, tokensIn = 0, tokensOut = 0 }) {
  const date = new Date()
  run(
    db,
    `INSERT INTO usage_log (id, day, month, provider_id, model, tokens_in, tokens_out, requests, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    cryptoId(),
    dayKey(date),
    monthKey(date),
    providerId,
    model,
    Math.max(0, Math.trunc(tokensIn)),
    Math.max(0, Math.trunc(tokensOut)),
    now()
  )
}

export function usageTotals(db, { day = "", month = "" } = {}) {
  const where = []
  const params = []
  if (day) {
    where.push("day = ?")
    params.push(day)
  }
  if (month) {
    where.push("month = ?")
    params.push(month)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  return one(
    db,
    `SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(requests), 0) AS requests
     FROM usage_log ${clause}`,
    ...params
  )
}

export function usageByProvider(db) {
  return all(
    db,
    `SELECT provider_id, model,
            SUM(tokens_in) AS tokens_in,
            SUM(tokens_out) AS tokens_out,
            SUM(requests) AS requests
     FROM usage_log
     WHERE day = ?
     GROUP BY provider_id, model
     ORDER BY (SUM(tokens_in) + SUM(tokens_out)) DESC`,
    dayKey()
  )
}

export function insertMessage(db, message) {
  const id = message.id || cryptoId()
  run(
    db,
    `INSERT INTO messages
      (id, conversation_id, role, content, attachments, tool_calls, tool_call_id, name, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    message.conversationId,
    message.role,
    message.content || "",
    JSON.stringify(message.attachments || []),
    JSON.stringify(message.toolCalls || []),
    message.toolCallId || "",
    message.name || "",
    JSON.stringify(message.meta || {}),
    message.createdAt || now()
  )
  return id
}

export function cryptoId() {
  return globalThis.crypto.randomUUID()
}
