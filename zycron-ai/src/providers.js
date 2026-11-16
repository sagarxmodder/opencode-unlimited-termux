import { decryptSecret, encryptSecret, keyHint } from "./crypto.js"
import { all, one, run } from "./db.js"
import { PROVIDERS } from "./presets.js"
import { asBool, estimateTokens, HttpError, now, slugify, truncate } from "./util.js"

const PRESET_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]))
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"])

export class ProviderError extends Error {
  constructor(message, { status = 0, body = "", retryable = true } = {}) {
    super(message)
    this.status = status
    this.body = body
    this.retryable = retryable
  }
}

export function providerRow(db, id) {
  return one(db, "SELECT * FROM providers WHERE id = ?", id)
}

export function modelRow(db, key) {
  return one(db, "SELECT * FROM models WHERE id = ?", key)
}

export function keylessProvider(row) {
  if (!row) return false
  if (PRESET_BY_ID.get(row.id)?.keyless) return true
  try {
    return LOCAL_HOSTS.has(new URL(row.base_url).hostname)
  } catch {
    return false
  }
}

export function providerKey(row, secret) {
  return decryptSecret(row?.api_key || "", secret)
}

export function providerReady(row, secret) {
  if (!row) return false
  return Boolean(providerKey(row, secret)) || keylessProvider(row)
}

export function publicProvider(db, row, secret) {
  const key = providerKey(row, secret)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    free: Boolean(row.free),
    docs: row.docs,
    keyless: keylessProvider(row),
    hasKey: Boolean(key),
    keyHint: keyHint(key),
    modelCount: Number(one(db, "SELECT COUNT(*) AS n FROM models WHERE provider_id = ?", row.id)?.n || 0),
    fetchedAt: Number(row.models_fetched_at || 0)
  }
}

export function listProviders(db, secret) {
  return all(db, "SELECT * FROM providers ORDER BY name COLLATE NOCASE")
    .map((row) => publicProvider(db, row, secret))
}

export function saveProvider(db, secret, input) {
  const baseUrl = String(input.baseUrl || input.base_url || "").trim().replace(/\/+$/, "")
  let parsed = null
  try {
    parsed = new URL(baseUrl)
  } catch {}
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "base URL must be a valid http(s) URL")
  }
  const id = slugify(input.id || input.name || parsed.hostname)
  const existing = providerRow(db, id)
  const name = String(input.name || existing?.name || id).trim()
  const free = asBool(input.free, existing ? Boolean(existing.free) : true)
  const kind = String(input.kind || existing?.kind || "openai")
  const docs = String(input.docs || existing?.docs || "")
  const enabled = asBool(input.enabled, existing ? Boolean(existing.enabled) : true)
  let apiKey = existing?.api_key || ""
  if (input.clearKey) apiKey = ""
  else if (input.apiKey !== undefined && String(input.apiKey).trim()) {
    apiKey = encryptSecret(String(input.apiKey).trim(), secret)
  }
  run(
    db,
    `INSERT INTO providers
      (id, name, kind, base_url, api_key, enabled, free, docs, headers, models_fetched_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       enabled = excluded.enabled,
       free = excluded.free,
       docs = excluded.docs`,
    id,
    name,
    kind,
    baseUrl,
    apiKey,
    enabled ? 1 : 0,
    free ? 1 : 0,
    docs,
    now()
  )
  return publicProvider(db, providerRow(db, id), secret)
}

export function removeProvider(db, id) {
  const row = providerRow(db, id)
  if (!row) throw new HttpError(404, "provider not found")
  run(db, "DELETE FROM models WHERE provider_id = ?", id)
  run(db, "DELETE FROM providers WHERE id = ?", id)
  run(db, "UPDATE conversations SET provider_id = 'auto', model = 'auto' WHERE provider_id = ?", id)
}

export function listModels(db, { q = "", providerId = "", free = "" } = {}) {
  const where = []
  const params = []
  if (providerId) {
    where.push("m.provider_id = ?")
    params.push(providerId)
  }
  if (free === "1" || free === "true") where.push("m.free = 1")
  if (free === "0" || free === "false") where.push("m.free = 0")
  if (q) {
    where.push("(m.model LIKE ? OR m.label LIKE ? OR p.name LIKE ?)")
    params.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  return all(
    db,
    `SELECT m.*, p.name AS provider_name, p.enabled AS provider_enabled
     FROM models m JOIN providers p ON p.id = m.provider_id
     ${clause}
     ORDER BY p.name COLLATE NOCASE, m.free DESC, m.label COLLATE NOCASE
     LIMIT 500`,
    ...params
  ).map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    provider: row.provider_name,
    providerEnabled: Boolean(row.provider_enabled),
    model: row.model,
    label: row.label,
    free: Boolean(row.free),
    vision: Boolean(row.vision),
    tools: Boolean(row.tools),
    context: Number(row.context || 0)
  }))
}

export function upsertModel(db, providerId, model) {
  const id = `${providerId}:${model.id}`
  run(
    db,
    `INSERT INTO models (id, provider_id, model, label, free, vision, tools, context, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       free = excluded.free,
       vision = excluded.vision,
       tools = excluded.tools,
       context = excluded.context,
       updated_at = excluded.updated_at`,
    id,
    providerId,
    model.id,
    model.label || model.id,
    model.free ? 1 : 0,
    model.vision ? 1 : 0,
    model.tools ? 1 : 0,
    Number(model.context) || 0,
    now()
  )
  return id
}

function looksVision(row, model) {
  if (model.vision !== undefined) return Boolean(model.vision)
  const modalities = model.architecture?.input_modalities || model.input_modalities
  if (Array.isArray(modalities)) return modalities.includes("image")
  return /vision|gpt-4o|gpt-4\.1|gemini|claude-3|pixtral/i.test(row.id)
}

function looksFree(provider, model) {
  if (model.free !== undefined) return Boolean(model.free)
  const prompt = Number(model.pricing?.prompt ?? 1)
  const completion = Number(model.pricing?.completion ?? 1)
  if (prompt === 0 && completion === 0) return true
  return Boolean(provider.free)
}

function looksTools(model) {
  const params = model.supported_parameters
  if (Array.isArray(params) && params.length) return params.includes("tools")
  return model.tools !== false
}

export async function fetchModels(db, secret, providerId) {
  const row = providerRow(db, providerId)
  if (!row) throw new HttpError(404, "provider not found")
  const key = providerKey(row, secret)
  if (!key && !keylessProvider(row)) throw new HttpError(400, "add an API key first")
  let url = `${row.base_url.replace(/\/+$/, "")}/models`
  if (row.id === "pollinations") url = "https://text.pollinations.ai/models"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) throw new HttpError(response.status, `provider returned HTTP ${response.status}: ${truncate(text, 240)}`)
    const payload = JSON.parse(text)
    const list = Array.isArray(payload) ? payload : payload.data || payload.models || []
    if (!Array.isArray(list) || !list.length) throw new HttpError(502, "provider returned no models")
    const seen = new Set()
    for (const item of list) {
      const id = String(item.id || item.name || item.model || "").trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      upsertModel(db, row.id, {
        id,
        label: String(item.name || item.label || id),
        free: looksFree(row, item),
        vision: looksVision(item, item),
        tools: looksTools(item),
        context: Number(item.context_length || item.context_window || item.context || 0)
      })
    }
    run(db, "UPDATE providers SET models_fetched_at = ? WHERE id = ?", now(), row.id)
    return listModels(db, { providerId: row.id })
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(502, `could not fetch models: ${error.message}`)
  } finally {
    clearTimeout(timer)
  }
}

export function messageContentParts(message) {
  if (!message.atts || !message.atts.length) return message.content
  const parts = []
  if (message.content) parts.push({ type: "text", text: message.content })
  for (const file of message.atts) {
    if (file.dataUrl && String(file.type || "").startsWith("image/")) {
      parts.push({ type: "image_url", image_url: { url: file.dataUrl } })
    } else if (file.text) {
      parts.push({ type: "text", text: `\n[Attached file: ${file.name}]\n${file.text}` })
    }
  }
  return parts.length ? parts : message.content
}

function normalizeContent(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part
      return part?.text || part?.content || ""
    }).join("")
  }
  return ""
}

function parseRetryable(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

export async function streamChat(provider, secret, {
  model,
  messages,
  tools = [],
  temperature = 0.7,
  signal,
  onDelta,
  onThinking
}) {
  const key = providerKey(provider, secret)
  if (!key && !keylessProvider(provider)) throw new ProviderError("missing API key", { status: 401, retryable: false })
  const url = `${provider.base_url.replace(/\/+$/, "")}/chat/completions`
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(key ? { authorization: `Bearer ${key}` } : {})
  }
  if (provider.id === "openrouter") {
    headers["http-referer"] = "http://localhost:8787"
    headers["x-title"] = "ZYCRON AI"
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 300000)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const requestBody = {
    model,
    messages,
    stream: true,
    temperature: Math.max(0, Math.min(2, Number(temperature) || 0.7))
  }
  if (tools.length) {
    requestBody.tools = tools
    requestBody.tool_choice = "auto"
  }
  try {
    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await response.text()
      if (response.status === 400 && tools.length && /tool|function/i.test(text)) {
        delete requestBody.tools
        delete requestBody.tool_choice
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })
      }
      if (!response.ok) {
        const finalText = await response.text().catch(() => text)
        let message = `HTTP ${response.status}`
        try {
          const parsed = JSON.parse(finalText)
          message = parsed.error?.message || parsed.message || message
        } catch {
          if (finalText.trim()) message = `${message}: ${truncate(finalText.trim(), 300)}`
        }
        throw new ProviderError(message, {
          status: response.status,
          body: finalText,
          retryable: parseRetryable(response.status)
        })
      }
    }
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("text/event-stream")) {
      const payload = await response.json()
      const choice = payload.choices?.[0] || {}
      const content = normalizeContent(choice.message?.content ?? choice.text)
      if (content) onDelta?.(content)
      return {
        content,
        thinking: "",
        toolCalls: choice.message?.tool_calls || [],
        usage: normalizeUsage(payload.usage, requestBody.messages, content),
        toolsDropped: !requestBody.tools
      }
    }
    const decoder = new TextDecoder()
    let buffer = ""
    let content = ""
    let thinking = ""
    const toolMap = new Map()
    let usage = null
    let finished = false
    const handleData = (data) => {
      if (!data || data === "[DONE]") {
        if (data === "[DONE]") finished = true
        return
      }
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      if (payload.error) {
        throw new ProviderError(payload.error.message || String(payload.error), {
          status: Number(payload.error.code) || 0,
          body: data,
          retryable: true
        })
      }
      if (payload.usage) usage = payload.usage
      for (const choice of payload.choices || []) {
        const delta = choice.delta || choice.message || {}
        const text = normalizeContent(delta.content)
        if (text) {
          content += text
          onDelta?.(text)
        }
        const reason = delta.reasoning_content || delta.reasoning || delta.thinking
        if (reason) {
          thinking += reason
          onThinking?.(reason)
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const fragment of delta.tool_calls) {
            const index = Number.isInteger(fragment.index) ? fragment.index : toolMap.size
            const current = toolMap.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } }
            if (fragment.id) current.id = fragment.id
            if (fragment.type) current.type = fragment.type
            if (fragment.function?.name) current.function.name += fragment.function.name
            if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments
            toolMap.set(index, current)
          }
        }
      }
    }
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "")
      let index = buffer.indexOf("\n\n")
      while (index !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const lines = block.split("\n").filter((line) => line.startsWith("data:"))
        const data = lines.map((line) => line.slice(5).trimStart()).join("\n")
        handleData(data)
        index = buffer.indexOf("\n\n")
      }
      if (finished) break
    }
    if (buffer.trim()) {
      const lines = buffer.split("\n").filter((line) => line.startsWith("data:"))
      if (lines.length) handleData(lines.map((line) => line.slice(5).trimStart()).join("\n"))
    }
    const toolCalls = [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)
    if (!content && !toolCalls.length) {
      throw new ProviderError("empty response", { status: 502, retryable: true })
    }
    return {
      content,
      thinking,
      toolCalls,
      usage: normalizeUsage(usage, requestBody.messages, content),
      toolsDropped: !requestBody.tools
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (timedOut) throw new ProviderError("request timed out", { status: 408, retryable: true })
    if (error.name === "AbortError") throw new ProviderError("request aborted", { status: 499, retryable: false })
    throw new ProviderError(error.message || "network error", { retryable: true })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

function normalizeUsage(usage, messages, content) {
  if (usage && (usage.prompt_tokens !== undefined || usage.total_tokens !== undefined)) {
    return {
      input: Number(usage.prompt_tokens || usage.input_tokens || 0),
      output: Number(usage.completion_tokens || usage.output_tokens || 0),
      total: Number(usage.total_tokens || 0)
    }
  }
  const input = estimateTokens(messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"))
  const output = estimateTokens(content)
  return { input, output, total: input + output }
}
