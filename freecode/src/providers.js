import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import {
  AbortedError,
  HttpError,
  parseKeys,
  sleep,
  truncate,
  unique
} from "./util.js"

export const PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    headers: {
      "HTTP-Referer": "https://github.com/freecode-ai/freecode",
      "X-Title": "freecode"
    }
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY"
  },
  gemini: {
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY"
  },
  cerebras: {
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY"
  },
  mistral: {
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY"
  },
  github: {
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    keyEnv: "GITHUB_TOKEN"
  },
  sambanova: {
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    keyEnv: "SAMBANOVA_API_KEY"
  },
  nvidia: {
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY"
  },
  pollinations: {
    name: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    keyEnv: "POLLINATIONS_API_KEY",
    keyless: true
  },
  llm7: {
    name: "LLM7 (keyless)",
    baseUrl: "https://api.llm7.io/v1",
    keyEnv: "LLM7_API_KEY",
    keyless: true
  },
  ollama: {
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyless: true
  },
  lmstudio: {
    name: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyless: true
  }
}

const proxyAgents = new Map()

class ProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false })
    const url = new URL(proxyUrl)
    if (url.protocol !== "http:") throw new Error(`unsupported proxy protocol: ${url.protocol}`)
    this.proxyHost = url.hostname
    this.proxyPort = Number(url.port) || 80
    this.proxyAuth = url.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
      : ""
  }

  createConnection(options, callback) {
    let finished = false
    const finish = (error, socket) => {
      if (finished) {
        socket?.destroy?.()
        return
      }
      finished = true
      callback(error, socket)
    }
    const socket = net.connect(this.proxyPort, this.proxyHost)
    socket.setNoDelay(true)
    socket.once("error", (error) => finish(error))
    socket.once("connect", () => {
      const target = `${options.host}:${options.port}`
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
      if (this.proxyAuth) lines.push(`Proxy-Authorization: ${this.proxyAuth}`)
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
    })
    let buffer = ""
    const onData = (chunk) => {
      buffer += chunk.toString("latin1")
      const end = buffer.indexOf("\r\n\r\n")
      if (end === -1) {
        if (buffer.length > 65536) {
          socket.destroy()
          finish(new Error("proxy response too large"))
        }
        return
      }
      socket.removeListener("data", onData)
      const head = buffer.slice(0, end)
      const match = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)
      const status = match ? Number(match[1]) : 0
      if (status !== 200) {
        socket.destroy()
        finish(new Error(`proxy CONNECT failed: ${head.split("\r\n")[0] || "no response"}`))
        return
      }
      const secure = tls.connect({
        socket,
        servername: options.servername || options.host,
        rejectUnauthorized: options.rejectUnauthorized !== false
      })
      secure.once("error", (error) => finish(error))
      secure.once("secureConnect", () => finish(null, secure))
    }
    socket.on("data", onData)
  }
}

function proxyAgentFor(proxyUrl) {
  if (!proxyAgents.has(proxyUrl)) proxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl))
  return proxyAgents.get(proxyUrl)
}

function proxyEnv() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ""
  ).trim()
}

export function proxyFor(target) {
  const value = proxyEnv()
  if (!value) return null
  const url = typeof target === "string" ? new URL(target) : target
  const host = url.hostname
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  for (const pattern of noProxy) {
    if (pattern === "*") return null
    const clean = pattern.replace(/^\./, "")
    if (host === clean || host.endsWith(`.${clean}`)) return null
  }
  return value
}

export function httpRequest({ url, method = "GET", headers = {}, body = null, signal = null }) {
  const target = new URL(url)
  const isHttps = target.protocol === "https:"
  const transport = isHttps ? https : http
  const port = Number(target.port) || (isHttps ? 443 : 80)
  const options = {
    method,
    host: target.hostname,
    port,
    path: `${target.pathname}${target.search}`,
    headers: { host: target.host, ...headers }
  }
  const proxy = isHttps ? proxyFor(target) : null
  if (proxy) options.agent = proxyAgentFor(proxy)
  return new Promise((resolve, reject) => {
    let settled = false
    let stream = null
    let request
    try {
      request = transport.request(options)
    } catch (error) {
      reject(error)
      return
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      const error = new AbortedError()
      if (stream) stream.destroy(error)
      else request.destroy(error)
    }
    if (signal) {
      if (signal.aborted) {
        request.destroy()
        fail(new AbortedError())
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    request.once("response", (response) => {
      if (settled) {
        response.destroy()
        return
      }
      settled = true
      stream = response
      response.once("close", cleanup)
      resolve({ status: response.statusCode || 0, headers: response.headers, stream: response })
    })
    request.once("error", (error) => {
      cleanup()
      if (settled) return
      settled = true
      reject(signal?.aborted ? new AbortedError() : error)
    })
    if (body != null) request.write(body)
    request.end()
  })
}

export async function collect(stream, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buffer)
    size += buffer.length
    if (size >= limit) {
      stream.destroy()
      break
    }
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, limit)
}

function contentText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
  }
  return ""
}

function parseArguments(raw) {
  if (!raw) return {}
  if (typeof raw === "object") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: String(raw) }
  }
}

function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return []
  return calls
    .filter(Boolean)
    .map((call, index) => ({
      id: call.id || `call_${index}_${Date.now().toString(36)}`,
      name: call.function?.name || call.name || "",
      arguments: parseArguments(call.function?.arguments ?? call.arguments)
    }))
    .filter((call) => call.name)
}

async function readJsonCompletion(stream, onDelta) {
  const text = await collect(stream, 8 * 1024 * 1024)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON response: ${truncate(text, 200)}`)
  }
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const content = contentText(message.content) || choice.text || ""
  if (content && onDelta) onDelta(content)
  return {
    content,
    toolCalls: normalizeToolCalls(message.tool_calls),
    usage: data?.usage || null,
    finishReason: choice.finish_reason || null
  }
}

async function readSse(stream, onDelta) {
  let buffer = ""
  let content = ""
  const calls = new Map()
  let usage = null
  let finishReason = null
  const decoder = new TextDecoder()
  const consume = (line) => {
    if (!line.startsWith("data:")) return false
    const payload = line.slice(5).trim()
    if (!payload) return false
    if (payload === "[DONE]") return true
    let data
    try {
      data = JSON.parse(payload)
    } catch {
      return false
    }
    if (data.usage) usage = data.usage
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const choice = data.choices?.[0]
    if (!choice) return false
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || choice.message || {}
    const piece = contentText(delta.content)
    if (piece) {
      content += piece
      onDelta?.(piece)
    }
    const fragments = delta.tool_calls || choice.message?.tool_calls
    if (Array.isArray(fragments)) {
      for (const fragment of fragments) {
        const index = Number.isInteger(fragment.index) ? fragment.index : calls.size
        const current = calls.get(index) || { id: "", name: "", arguments: "" }
        if (fragment.id) current.id = fragment.id
        const fn = fragment.function || {}
        if (fn.name && !current.name) current.name = fn.name
        if (fn.arguments) current.arguments += fn.arguments
        calls.set(index, current)
      }
    }
    return false
  }
  let done = false
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (consume(line)) {
        done = true
        break
      }
    }
    if (done) break
  }
  buffer += decoder.decode()
  if (!done && buffer.trim()) consume(buffer.trim())
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], index) => ({
      id: call.id || `call_${index}_${Date.now().toString(36)}`,
      name: call.name,
      arguments: parseArguments(call.arguments)
    }))
    .filter((call) => call.name)
  return { content, toolCalls, usage, finishReason }
}

export async function chatOnce({
  provider,
  entry,
  messages,
  tools = null,
  apiKey = null,
  signal = null,
  timeoutMs = 300000,
  temperature = null,
  onDelta = null
}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1000, timeoutMs))
  const forwardAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new AbortedError()
    }
    signal.addEventListener("abort", forwardAbort, { once: true })
  }
  try {
    const url = `${String(provider.baseUrl).replace(/\/+$/, "")}/chat/completions`
    const payload = { model: entry.model, messages, stream: true }
    if (tools?.length) {
      payload.tools = tools
      payload.tool_choice = "auto"
    }
    if (provider.temperature != null) payload.temperature = provider.temperature
    else if (temperature != null) payload.temperature = temperature
    if (provider.maxTokens != null) payload.max_tokens = provider.maxTokens
    const headers = { "content-type": "application/json", accept: "text/event-stream" }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    Object.assign(headers, provider.headers || {})
    const response = await httpRequest({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (response.status < 200 || response.status >= 300) {
      let detail = ""
      try {
        detail = await collect(response.stream, 262144)
      } catch {
        detail = ""
      }
      throw new HttpError(response.status, detail, response.headers)
    }
    const type = String(response.headers["content-type"] || "")
    const result = type.includes("application/json")
      ? await readJsonCompletion(response.stream, onDelta)
      : await readSse(response.stream, onDelta)
    return { ...result, entry }
  } catch (error) {
    if (signal?.aborted) throw new AbortedError()
    if (timedOut) throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`)
    if (error instanceof AbortedError) throw new AbortedError()
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forwardAbort)
  }
}

export function classifyError(error) {
  if (error instanceof AbortedError) return "abort"
  if (error?.kind === "abort" || error?.name === "AbortError") return "abort"
  if (error?.kind === "context") return "context"
  if (error instanceof HttpError) {
    const body = String(error.body || "")
    const status = error.status
    if (/context length|maximum context|context window|too many tokens|prompt is too long|reduce the length|exceeds? (?:the )?(?:maximum|model|token)/i.test(body)) {
      return "context"
    }
    if (status === 400 && /tool|function/i.test(body) && /not support|unsupported|invalid|no tools|does not support|unknown parameter/i.test(body)) {
      return "tools"
    }
    if (status === 429 || status === 402) return "rate"
    if (/rate.?limit|quota|usage limit|capacity|overloaded|too many requests/i.test(body)) return "rate"
    if (status === 401 || status === 403) return "auth"
    if (status === 404) return "model"
    if (/model[^.]{0,60}(not found|not available|deactivated|unsupported|does not exist|unknown|invalid)/i.test(body)) {
      return "model"
    }
    return "retry"
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed/i.test(error?.message || "")) {
    return "retry"
  }
  return "retry"
}

export function describeError(error) {
  if (error instanceof HttpError) {
    let detail = ""
    try {
      const data = JSON.parse(error.body)
      detail = data?.error?.message || data?.message || data?.error || ""
      if (typeof detail !== "string") detail = JSON.stringify(detail)
    } catch {
      detail = error.body || ""
    }
    detail = truncate(String(detail).replace(/\s+/g, " ").trim(), 140)
    return `HTTP ${error.status}${detail ? `: ${detail}` : ""}`
  }
  return truncate(error?.message || String(error), 160)
}

function cooldownFor(kind) {
  switch (kind) {
    case "model":
      return 6 * 60 * 60 * 1000
    case "auth":
      return 60 * 60 * 1000
    case "rate":
      return 20000
    default:
      return 10000
  }
}

export class ModelPool {
  constructor({ config, catalog }) {
    this.config = config
    this.catalog = Array.isArray(catalog) ? catalog : []
    this.coolingUntil = new Map()
    this.keyIndex = new Map()
    this.toolsBroken = new Set()
    this.lastWinner = null
  }

  reload(catalog) {
    this.catalog = Array.isArray(catalog) ? catalog : []
  }

  providerFor(entry) {
    const base = PROVIDERS[entry.provider]
    const override = this.config.providers?.[entry.provider]
    if (!base && !override?.baseUrl) return null
    return { ...(base || {}), ...(override || {}) }
  }

  keysFor(provider) {
    if (!provider) return []
    const configured = parseKeys(provider.apiKey)
    const fromEnv = provider.keyEnv ? parseKeys(process.env[provider.keyEnv]) : []
    return unique([...configured, ...fromEnv])
  }

  hasCredentials(provider) {
    if (!provider) return false
    if (provider.keyless) return true
    return this.keysFor(provider).length > 0
  }

  cooling(entry) {
    return (this.coolingUntil.get(entry.id) || 0) > Date.now()
  }

  cool(entry, ms) {
    this.coolingUntil.set(entry.id, Date.now() + ms)
  }

  candidates(preferred = null) {
    const wanted = [
      ...(Array.isArray(preferred) ? preferred : preferred ? [preferred] : []),
      ...(Array.isArray(this.config.preferred) ? this.config.preferred : [])
    ].filter((value) => value && value !== "auto")
    const seen = new Set()
    const ready = []
    for (const entry of this.catalog) {
      if (!entry?.provider || !entry?.model) continue
      const provider = this.providerFor(entry)
      if (!provider?.baseUrl || !this.hasCredentials(provider)) continue
      const key = `${entry.provider}:${entry.model}`
      if (seen.has(key)) continue
      seen.add(key)
      ready.push(entry)
    }
    const score = (entry) => {
      let value = 0
      if (entry.tools) value += 20
      if (!this.cooling(entry)) value += 50
      if (this.lastWinner === entry.id) value += 1000
      const byId = wanted.indexOf(entry.id)
      const byModel = wanted.indexOf(entry.model)
      if (byId !== -1) value += 500 - byId * 5
      else if (byModel !== -1) value += 400 - byModel * 5
      return value
    }
    return ready.sort((a, b) => score(b) - score(a))
  }

  async tryEntry(entry, options) {
    const provider = this.providerFor(entry)
    if (!provider) throw new Error(`unknown provider: ${entry.provider}`)
    const keys = this.keysFor(provider)
    const keyAttempts = keys.length ? Math.min(keys.length, 3) : 1
    const start = this.keyIndex.get(entry.provider) || 0
    let lastError = null
    for (let i = 0; i < keyAttempts; i++) {
      if (options.signal?.aborted) throw new AbortedError()
      const key = keys.length ? keys[(start + i) % keys.length] : null
      let allowTools = Boolean(entry.tools) && Boolean(options.tools?.length) && !this.toolsBroken.has(entry.id)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await chatOnce({
            provider,
            entry,
            messages: options.messages,
            tools: allowTools ? options.tools : null,
            apiKey: key,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            temperature: this.config.temperature,
            onDelta: options.onDelta
          })
          if (keys.length) this.keyIndex.set(entry.provider, keys.indexOf(key))
          this.lastWinner = entry.id
          this.coolingUntil.delete(entry.id)
          return result
        } catch (error) {
          lastError = error
          const kind = classifyError(error)
          if (kind === "abort") throw error instanceof AbortedError ? error : new AbortedError()
          if (kind === "context") {
            error.kind = "context"
            throw error
          }
          if (kind === "tools" && allowTools) {
            this.toolsBroken.add(entry.id)
            allowTools = false
            options.onRetry?.({
              entry,
              reason: "tools unsupported, retrying without tools",
              waitMs: 0
            })
            continue
          }
          const tryNextKey = keys.length > 1 && i < keyAttempts - 1 && (kind === "rate" || kind === "auth")
          if (tryNextKey) {
            this.keyIndex.set(entry.provider, (start + i + 1) % keys.length)
            options.onRetry?.({
              entry,
              reason: `${describeError(error)} — rotating API key`,
              waitMs: 0
            })
            break
          }
          const waitMs = cooldownFor(kind)
          this.cool(entry, waitMs)
          options.onRetry?.({ entry, reason: describeError(error), waitMs })
          throw error
        }
      }
    }
    throw lastError || new Error(`model failed: ${entry.id}`)
  }

  async chat(options) {
    const list = this.candidates(options.preferred)
    if (!list.length) throw new Error(this.setupMessage())
    const failures = new Map()
    for (let pass = 0; pass < 2; pass++) {
      if (options.signal?.aborted) throw new AbortedError()
      let attempted = 0
      for (const entry of list) {
        if (options.signal?.aborted) throw new AbortedError()
        if (pass === 0 && this.cooling(entry)) continue
        attempted++
        try {
          return await this.tryEntry(entry, options)
        } catch (error) {
          if (classifyError(error) === "context") throw error
          if (error instanceof AbortedError || options.signal?.aborted) throw new AbortedError()
          if (!failures.has(entry.id)) failures.set(entry.id, error)
        }
      }
      if (pass === 0) await sleep(attempted === 0 ? 250 : 750, options.signal)
    }
    if (failures.size) {
      const [id, first] = failures.entries().next().value
      const more = failures.size > 1 ? ` (+${failures.size - 1} more)` : ""
      const error = new Error(`all ${failures.size} free models failed — ${id}: ${describeError(first)}${more}`)
      error.cause = first
      throw error
    }
    throw new Error("every free model failed")
  }

  setupMessage() {
    const envs = unique(
      this.catalog
        .map((entry) => this.providerFor(entry)?.keyEnv)
        .filter(Boolean)
    )
    const lines = envs.slice(0, 8).map((env) => `  export ${env}=...`)
    return [
      "Koi free model available nahi.",
      "",
      "Kam se kam ek API key set karo:",
      ...lines,
      "",
      "Ya local Ollama chalao (key ki zaroorat nahi):",
      "  ollama serve",
      "  ollama pull qwen2.5-coder:7b",
      "",
      "Phir: freecode doctor"
    ].join("\n")
  }
}
