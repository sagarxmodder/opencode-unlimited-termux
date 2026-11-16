export class ApiError extends Error {
  constructor(message, status = 0, body = null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

export function parseSseFrame(frame) {
  let event = "message"
  const data = []
  for (const line of String(frame ?? "").split("\n")) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
  }
  if (!data.length) return null
  const raw = data.join("\n")
  let parsed = raw
  try {
    parsed = JSON.parse(raw)
  } catch {}
  return { event, data: parsed }
}

export async function* readSse(response, signal, { idleMs = 90_000 } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let timer = null
  const onAbort = () => {
    try {
      reader.cancel()
    } catch {}
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    while (true) {
      if (signal?.aborted) return
      let idle = null
      if (idleMs > 0) {
        idle = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ApiError(`stream stalled — no data for ${Math.round(idleMs / 1000)}s`, 0)), idleMs)
        })
        idle.catch(() => {})
      }
      let chunk
      try {
        chunk = idle ? await Promise.race([reader.read(), idle]) : await reader.read()
      } catch (error) {
        if (signal?.aborted) return
        throw error
      } finally {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
      const { value, done } = chunk
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, "\n")
      let cut
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const parsed = parseSseFrame(frame)
        if (parsed) yield parsed
      }
    }
    const tail = parseSseFrame(buffer)
    if (tail) yield tail
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", onAbort)
    try {
      reader.cancel()
    } catch {}
  }
}

export class ZycronApi {
  constructor({ baseUrl = process.env.ZYCRON_URL || "http://127.0.0.1:8787", token = process.env.ZYCRON_TOKEN || "" } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "")
    this.token = String(token || "")
  }

  url(path) {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
  }

  headers(extra = {}) {
    const headers = { accept: "application/json", ...extra }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    return headers
  }

  async request(path, { method = "GET", body, signal, text = false, timeout = 45000 } = {}) {
    const options = { method, headers: this.headers(), signal }
    if (body !== undefined) {
      options.headers["content-type"] = "application/json"
      options.body = JSON.stringify(body)
    }
    if (!signal && timeout) options.signal = AbortSignal.timeout(timeout)
    let response
    try {
      response = await fetch(this.url(path), options)
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ApiError("request timed out", 0)
      throw new ApiError(error?.message || "network error", 0)
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "")
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {}
      throw new ApiError(parsed?.error || raw.slice(0, 300) || `HTTP ${response.status}`, response.status, parsed)
    }
    if (text) return response.text()
    const raw = await response.text()
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  health() {
    return this.request("/api/health", { timeout: 4000 })
  }

  bootstrap() {
    return this.request("/api/bootstrap")
  }

  settings() {
    return this.request("/api/settings")
  }

  patchSettings(patch) {
    return this.request("/api/settings", { method: "PATCH", body: patch })
  }

  usage() {
    return this.request("/api/usage")
  }

  conversations(query = "", { archived = "all", sort = "updated" } = {}) {
    const params = new URLSearchParams()
    if (query) params.set("q", query)
    if (archived !== "all") params.set("archived", archived)
    if (sort) params.set("sort", sort)
    const suffix = params.toString()
    return this.request(`/api/conversations${suffix ? `?${suffix}` : ""}`)
  }

  createConversation(input = {}) {
    return this.request("/api/conversations", { method: "POST", body: input })
  }

  conversation(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}`)
  }

  patchConversation(id, patch) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: patch })
  }

  deleteConversation(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  duplicateConversation(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: {} })
  }

  clearConversation(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/clear`, { method: "POST", body: {} })
  }

  compactConversation(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/compact`, { method: "POST", body: {} })
  }

  undo(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/undo`, { method: "POST", body: {} })
  }

  redo(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/redo`, { method: "POST", body: {} })
  }

  changes(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/changes`)
  }

  exportMarkdown(id) {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/export`, { text: true, timeout: 30000 })
  }

  editMessage(id, content) {
    return this.request(`/api/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: { content } })
  }

  providers() {
    return this.request("/api/providers")
  }

  saveProvider(input) {
    return this.request("/api/providers", { method: "POST", body: input })
  }

  updateProvider(id, input) {
    return this.request(`/api/providers/${encodeURIComponent(id)}`, { method: "PATCH", body: input })
  }

  deleteProvider(id) {
    return this.request(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  fetchProviderModels(id) {
    return this.request(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST", body: {}, timeout: 90000 })
  }

  models({ q = "", provider = "", free = "" } = {}) {
    const params = new URLSearchParams()
    if (q) params.set("q", q)
    if (provider) params.set("provider", provider)
    if (free) params.set("free", free)
    const suffix = params.toString()
    return this.request(`/api/models${suffix ? `?${suffix}` : ""}`)
  }

  projects() {
    return this.request("/api/projects")
  }

  createProject(name) {
    return this.request("/api/projects", { method: "POST", body: { name } })
  }

  deleteProject(id, deleteFiles = false) {
    return this.request(`/api/projects/${encodeURIComponent(id)}${deleteFiles ? "?deleteFiles=1" : ""}`, { method: "DELETE" })
  }

  projectTree(id, path = ".", depth = 4) {
    const params = new URLSearchParams({ path, depth: String(depth) })
    return this.request(`/api/projects/${encodeURIComponent(id)}/tree?${params}`)
  }

  projectFile(id, path) {
    return this.request(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`)
  }

  writeProjectFile(id, path, content) {
    return this.request(`/api/projects/${encodeURIComponent(id)}/file`, { method: "PUT", body: { path, content } })
  }

  projectInstructions(id) {
    return this.request(`/api/projects/${encodeURIComponent(id)}/instructions`)
  }

  pendingApprovals() {
    return this.request("/api/approvals")
  }

  resolveApproval(id, approve) {
    return this.request(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: { approve: Boolean(approve) } })
  }

  stopChat(requestId) {
    return this.request(`/api/chat/${encodeURIComponent(requestId)}/stop`, { method: "POST", body: {}, timeout: 8000 })
  }

  async *chat(body, { signal, idleMs = 90_000 } = {}) {
    let response
    try {
      response = await fetch(this.url("/api/chat"), {
        method: "POST",
        headers: this.headers({ "content-type": "application/json", accept: "text/event-stream" }),
        body: JSON.stringify(body),
        signal
      })
    } catch (error) {
      if (error?.name === "AbortError") return
      throw new ApiError(error?.message || "network error", 0)
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "")
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {}
      throw new ApiError(parsed?.error || raw.slice(0, 300) || `HTTP ${response.status}`, response.status, parsed)
    }
    yield* readSse(response, signal, { idleMs })
  }
}
