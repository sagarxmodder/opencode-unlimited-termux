import { renderMarkdown, highlightCode, escapeHtml } from "./markdown.js"

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const TOKEN_KEY = "zycron.token"
const HISTORY_KEY = "zycron.input.history"
const MAX_ATTACHMENTS = 6

const MODES = [
  { id: "plan", name: "Plan", copy: "Read-only planning and architecture. No file changes or commands." },
  { id: "build", name: "Build", copy: "Implement the request, edit files and verify changes with approval." },
  { id: "debug", name: "Debug", copy: "Find the root cause and apply the smallest correct fix." },
  { id: "review", name: "Review", copy: "Read-only review for bugs, security issues and missing tests." }
]

const COMMANDS = [
  ["/help", "/help", "Show commands and shortcuts"],
  ["/new", "/new", "Start a new session"],
  ["/clear", "/clear", "Clear the current session messages"],
  ["/model", "/model", "Choose a model"],
  ["/models", "/models", "Browse and filter models"],
  ["/provider", "/provider", "Manage providers and API keys"],
  ["/agent", "/agent", "Choose an agent mode"],
  ["/agents", "/agents", "List agent modes"],
  ["/plan", "/plan", "Switch to plan mode"],
  ["/build", "/build", "Switch to build mode"],
  ["/debug", "/debug", "Switch to debug mode"],
  ["/review", "/review", "Switch to review mode"],
  ["/compact", "/compact", "Compact older context"],
  ["/history", "/history", "Open the session manager"],
  ["/undo", "/undo", "Undo the latest agent file change"],
  ["/redo", "/redo", "Redo the latest undo"],
  ["/settings", "/settings", "Open settings"],
  ["/exit", "/exit", "Close this ZYCRON AI tab"],
  ["/sessions", "/sessions", "Open the session manager"],
  ["/switch", "/switch 2", "Switch to a session by list position"],
  ["/rename", "/rename title", "Rename the current session"],
  ["/delete", "/delete", "Delete the current session"],
  ["/delete-all", "/delete-all", "Delete every session"],
  ["/duplicate", "/duplicate", "Duplicate the current session"],
  ["/export", "/export", "Export the current session as Markdown"],
  ["/search", "/search", "Search sessions"],
  ["/stop", "/stop", "Stop the current response"]
]

const state = {
  token: "",
  app: null,
  settings: {},
  providers: [],
  models: [],
  conversations: [],
  projects: [],
  plugins: [],
  usage: { today: null, month: null, byProvider: [] },
  backup: null,
  current: null,
  messages: [],
  project: null,
  draft: { providerId: "auto", model: "auto", mode: "build", projectId: null, title: "" },
  attachments: [],
  history: [],
  streaming: null,
  search: "",
  sort: "updated",
  archived: "all",
  suggestions: { items: [], index: 0, start: 0, mode: "" },
  modals: [],
  ws: null,
  mentionCache: { projectId: "", files: [] },
  historyIndex: -1,
  historyDraft: ""
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function readStoredHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")
    if (Array.isArray(value)) return value.slice(0, 60)
  } catch {}
  return []
}

function bootToken() {
  const params = new URLSearchParams(location.search)
  const queryToken = params.get("token")
  if (queryToken) {
    localStorage.setItem(TOKEN_KEY, queryToken)
    params.delete("token")
    const next = `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`
    history.replaceState(null, "", next)
  }
  state.token = localStorage.getItem(TOKEN_KEY) || ""
}

function authHeaders(extra = {}) {
  return state.token ? { ...extra, authorization: `Bearer ${state.token}` } : extra
}

async function api(path, { method = "GET", body, signal } = {}) {
  const headers = authHeaders({ accept: "application/json" })
  if (body !== undefined) headers["content-type"] = "application/json"
  let response
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
  } catch (error) {
    if (error.name !== "AbortError") setConnection(false)
    throw error
  }
  if (response.status === 401) {
    setConnection(false)
    showTokenScreen("Enter the access token for this ZYCRON AI instance.")
    throw new ApiError(401, "unauthorized")
  }
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }
  if (!response.ok) throw new ApiError(response.status, data?.error || `HTTP ${response.status}`)
  return data
}

function toast(message, kind = "") {
  const host = $("#toasts")
  if (!host) return
  const node = document.createElement("div")
  node.className = `toast ${kind}`
  node.innerHTML = `<svg class="icon"><use href="#${kind === "err" ? "i-close" : kind === "ok" ? "i-check" : "i-spark"}"></use></svg><span>${escapeHtml(message)}</span>`
  host.append(node)
  setTimeout(() => {
    node.style.opacity = "0"
    setTimeout(() => node.remove(), 180)
  }, kind === "err" ? 5200 : 3200)
}

function setConnection(ok) {
  const text = ok ? "Connected" : "Offline"
  const label = $("#statusConn")
  if (label) label.textContent = text
  const dot = $("#statusDot")
  if (!dot) return
  dot.style.background = ok ? "var(--green)" : "var(--red)"
  dot.style.boxShadow = ok ? "0 0 8px rgba(52, 211, 153, .7)" : "0 0 8px rgba(251, 113, 133, .7)"
}

function showTokenScreen(message = "") {
  $(".token-screen")?.remove()
  const screen = document.createElement("div")
  screen.className = "token-screen"
  screen.innerHTML = `<form class="token-card">
    <div class="brand-mark">✦</div>
    <h2>ZYCRON AI</h2>
    <p>${escapeHtml(message || "This instance is protected. Enter the access token to continue.")}</p>
    <input id="tokenInput" type="password" placeholder="Access token" autocomplete="current-password" autofocus>
    <div class="error-text" id="tokenError"></div>
    <button class="btn primary" type="submit" style="width:100%;margin-top:8px">Unlock</button>
  </form>`
  document.body.append(screen)
  $("form", screen).addEventListener("submit", async (event) => {
    event.preventDefault()
    const value = $("#tokenInput", screen).value.trim()
    if (!value) return
    state.token = value
    localStorage.setItem(TOKEN_KEY, value)
    try {
      await loadBootstrap()
      screen.remove()
      bindUi()
      renderSidebar()
      renderChrome()
      renderMessages()
    } catch (error) {
      $("#tokenError", screen).textContent = error.status === 401 ? "Token was rejected." : error.message
    }
  })
  setTimeout(() => $("#tokenInput", screen)?.focus(), 30)
}

function formatTokens(value) {
  const number = Number(value || 0)
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}m`
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(number)
}

function timeAgo(timestamp) {
  const value = Number(timestamp || 0)
  if (!value) return "now"
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function dayTokens(usage = state.usage?.today) {
  return Number(usage?.tokens_in || 0) + Number(usage?.tokens_out || 0)
}

function defaultProject() {
  return state.projects.find((item) => item.id === "playground") || state.projects[0] || null
}

function activeProjectId() {
  return state.current?.projectId || state.draft.projectId || defaultProject()?.id || null
}

function projectById(id) {
  return state.projects.find((item) => item.id === id) || null
}

function projectName(id) {
  return projectById(id || activeProjectId())?.name || "Playground"
}

function modelById(providerId, model) {
  return state.models.find((item) => item.providerId === providerId && item.model === model)
    || state.models.find((item) => item.id === `${providerId}:${model}`)
    || null
}

function modelName(providerId, model) {
  if (!providerId || providerId === "auto" || !model || model === "auto") return "Auto · free-first"
  return modelById(providerId, model)?.label || model
}

function providerById(id) {
  return state.providers.find((item) => item.id === id) || null
}

function providerReady(provider) {
  return Boolean(provider && provider.enabled && (provider.hasKey || provider.keyless))
}

function activeMode() {
  return state.current?.mode || state.draft.mode || "build"
}

function activeProviderId() {
  return state.current?.providerId || state.draft.providerId || "auto"
}

function activeModel() {
  return state.current?.model || state.draft.model || "auto"
}

function normalizeConversation(row) {
  if (!row) return null
  if ("providerId" in row) return row
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id || "auto",
    model: row.model || "auto",
    systemPrompt: row.system_prompt || "",
    projectId: row.project_id || null,
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

function uploadUrl(name) {
  const base = `/uploads/${encodeURIComponent(name)}`
  return state.token ? `${base}?token=${encodeURIComponent(state.token)}` : base
}

function previewUrl(projectId, path = "index.html") {
  const base = `/preview/${encodeURIComponent(projectId)}/${String(path).split("/").map(encodeURIComponent).join("/")}`
  return state.token ? `${base}?token=${encodeURIComponent(state.token)}` : base
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap")
  state.app = data.app
  state.settings = data.settings || {}
  state.providers = data.providers || []
  state.models = data.models || []
  state.conversations = data.conversations || []
  state.projects = data.projects || []
  state.plugins = data.plugins || []
  state.usage = data.usage || { today: null, month: null, byProvider: [] }
  state.backup = data.backup || null
  if (!state.draft.projectId) state.draft.projectId = defaultProject()?.id || null
  setConnection(true)
  applyTheme()
  return data
}

async function init() {
  bootToken()
  try {
    await loadBootstrap()
    state.history = readStoredHistory()
    bindUi()
    renderSidebar()
    renderChrome()
    renderMessages()
    checkPendingApprovals()
    setTimeout(() => $("#input")?.focus(), 60)
  } catch (error) {
    if (error.status !== 401) {
      setConnection(false)
      showFatal(error)
    }
  }
}

function showFatal(error) {
  const node = document.createElement("div")
  node.className = "token-screen"
  node.innerHTML = `<div class="token-card">
    <div class="brand-mark">✦</div>
    <h2>Could not connect</h2>
    <p>${escapeHtml(error.message || "ZYCRON AI server is not reachable.")}</p>
    <button class="btn primary" style="width:100%" id="retryBoot">Retry</button>
  </div>`
  document.body.append(node)
  $("#retryBoot", node).addEventListener("click", () => {
    node.remove()
    init()
  })
}

function applyTheme() {
  const theme = ["amoled", "midnight"].includes(state.settings.theme) ? state.settings.theme : "amoled"
  const accent = ["violet", "blue", "cyan", "rose"].includes(state.settings.accent) ? state.settings.accent : "violet"
  document.body.dataset.theme = theme
  document.body.dataset.accent = accent
}

function bindUi() {
  if (bindUi.done) return
  bindUi.done = true

  $("#menuBtn").addEventListener("click", () => toggleSidebar(true))
  $("#sidebarClose").addEventListener("click", () => toggleSidebar(false))
  $("#sidebarBackdrop").addEventListener("click", () => toggleSidebar(false))
  $("#newChatBtn").addEventListener("click", () => newChat())
  $("#openSessionsBtn").addEventListener("click", () => openSessionManager())
  $("#openProjectsBtn").addEventListener("click", () => openWorkspace())
  $("#openSettingsBtn").addEventListener("click", () => openSettings())
  $("#sortSessions").addEventListener("click", cycleSort)
  $("#sessionSearch").addEventListener("input", debounce((event) => {
    state.search = event.target.value.trim()
    refreshConversations().catch(() => {})
  }, 220))

  $("#modePill").addEventListener("click", openModePicker)
  $("#composerMode").addEventListener("click", openModePicker)
  $("#modelPill").addEventListener("click", openModelPicker)
  $("#composerModel").addEventListener("click", openModelPicker)
  $("#projectPill").addEventListener("click", openProjectPicker)
  $("#exportBtn").addEventListener("click", () => state.current && exportConversation(state.current.id, "md"))
  $("#moreBtn").addEventListener("click", openSessionActions)

  $("#composer").addEventListener("submit", (event) => {
    event.preventDefault()
    sendMessage().catch((error) => toast(error.message, "err"))
  })
  $("#input").addEventListener("input", onInputChange)
  $("#input").addEventListener("keydown", onInputKeyDown)
  $("#attachBtn").addEventListener("click", () => $("#fileInput").click())
  $("#imageBtn").addEventListener("click", () => $("#imageInput").click())
  $("#fileInput").addEventListener("change", (event) => handleFiles(event.target.files, "text"))
  $("#imageInput").addEventListener("change", (event) => handleFiles(event.target.files, "image"))
  $("#stopBtn").addEventListener("click", stopStreaming)
  $("#scrollBottom").addEventListener("click", () => scrollToBottom(true))
  $("#chatScroll").addEventListener("scroll", onScroll)
  $("#suggestionsGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt]")
    if (!button) return
    $("#input").value = button.dataset.prompt
    resizeInput()
    sendMessage().catch((error) => toast(error.message, "err"))
  })
  $("#chatTitle").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.target.blur()
    }
  })
  $("#chatTitle").addEventListener("blur", saveTitle)
  $("#suggestions").addEventListener("mousedown", (event) => {
    const item = event.target.closest("[data-suggest]")
    if (!item) return
    event.preventDefault()
    chooseSuggestion(Number(item.dataset.suggest))
  })

  document.addEventListener("click", onDocumentClick)
  document.addEventListener("keydown", onGlobalKeyDown)
  window.addEventListener("online", () => setConnection(true))
  window.addEventListener("offline", () => setConnection(false))
  setInterval(() => {
    if (!document.hidden && !state.streaming) fetch("/api/health").then((res) => setConnection(res.ok)).catch(() => setConnection(false))
  }, 45000)
  setInterval(() => {
    if (!document.hidden) checkPendingApprovals()
  }, 12000)
}

function toggleSidebar(open) {
  const sidebar = $("#sidebar")
  const backdrop = $("#sidebarBackdrop")
  const shouldOpen = open === undefined ? !sidebar.classList.contains("open") : open
  sidebar.classList.toggle("open", shouldOpen)
  backdrop.classList.toggle("show", shouldOpen)
}

function debounce(fn, delay) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

function cycleSort() {
  const order = ["updated", "created", "title"]
  state.sort = order[(order.indexOf(state.sort) + 1) % order.length]
  $("#sortSessions").textContent = state.sort
  refreshConversations().catch(() => {})
}

async function refreshConversations() {
  const query = state.search ? `q=${encodeURIComponent(state.search)}&` : ""
  const data = await api(`/api/conversations?${query}sort=${encodeURIComponent(state.sort)}&archived=all`)
  state.conversations = data.conversations || []
  renderSidebar()
}

function renderSidebar() {
  const list = $("#conversationList")
  if (!list) return
  const items = state.conversations.filter((conversation) => !conversation.archived)
  if (!items.length) {
    list.innerHTML = `<div class="sidebar-empty">${state.search ? "No sessions match your search." : "No sessions yet.<br>Start a new session to begin."}</div>`
    return
  }
  list.innerHTML = items.map((conversation) => {
    const active = state.current?.id === conversation.id
    return `<div class="conversation-item ${active ? "active" : ""}" data-id="${escapeHtml(conversation.id)}">
      <button class="conv-main" type="button" data-act="open-conv" data-id="${escapeHtml(conversation.id)}">
        <span class="conv-title">${conversation.pinned ? '<span class="conv-pin"><svg class="icon"><use href="#i-pin"></use></svg></span> ' : ""}${escapeHtml(conversation.title || "New chat")}</span>
        <span class="conv-sub">${escapeHtml(modelName(conversation.providerId, conversation.model))} · ${timeAgo(conversation.updatedAt)}</span>
      </button>
      <div class="conv-actions">
        <button type="button" data-act="pin-conv" data-id="${escapeHtml(conversation.id)}" title="${conversation.pinned ? "Unpin" : "Pin"}"><svg class="icon"><use href="#i-pin"></use></svg></button>
        <button type="button" data-act="archive-conv" data-id="${escapeHtml(conversation.id)}" title="Archive"><svg class="icon"><use href="#i-archive"></use></svg></button>
        <button type="button" data-act="rename-conv" data-id="${escapeHtml(conversation.id)}" title="Rename"><svg class="icon"><use href="#i-edit"></use></svg></button>
        <button type="button" data-act="delete-conv" data-id="${escapeHtml(conversation.id)}" title="Delete"><svg class="icon"><use href="#i-trash"></use></svg></button>
      </div>
    </div>`
  }).join("")
}

function renderChrome() {
  const title = state.current?.title || state.draft.title || "New chat"
  const titleInput = $("#chatTitle")
  if (document.activeElement !== titleInput) titleInput.value = title
  $("#topbarSub").textContent = `${projectName(activeProjectId())} · local workspace`
  $("#modePill").textContent = activeMode()
  $("#heroMode").textContent = activeMode()
  $("#heroModeFoot").textContent = activeMode().replace(/^\w/, (char) => char.toUpperCase())
  $("#composerMode").textContent = activeMode()
  $("#statusMode").textContent = activeMode().replace(/^\w/, (char) => char.toUpperCase())
  const model = modelName(activeProviderId(), activeModel())
  $("#modelPillText").textContent = model
  $("#heroModel").textContent = model
  $("#heroModelFoot").textContent = model
  $("#composerModelText").textContent = model
  $("#statusModel").textContent = model
  $("#projectPillText").textContent = projectName(activeProjectId())
  $("#heroProject").textContent = projectName(activeProjectId())
  $("#draftState").textContent = `${model} · ${activeMode()}`
  $("#statusUsage").textContent = `${formatTokens(dayTokens())} tokens today`
  $("#heroBadge").textContent = state.streaming ? "● WORKING" : "● READY"
  $("#statusbar")?.classList?.toggle("busy", Boolean(state.streaming))
  $("#sendBtn").hidden = Boolean(state.streaming)
  $("#stopBtn").hidden = !state.streaming
  document.title = state.current?.title ? `${state.current.title} · ZYCRON AI` : "ZYCRON AI · AI Coding Agent"
}

function renderMessages() {
  const host = $("#messages")
  if (!host) return
  host.innerHTML = ""
  const toolResults = new Map()
  for (const message of state.messages) {
    if (message.role === "tool" && message.toolCallId) toolResults.set(message.toolCallId, message)
  }
  for (const message of state.messages) {
    if (message.role === "tool") continue
    host.append(messageNode(message, toolResults))
  }
  $("#welcome").classList.toggle("hidden", state.messages.length > 0)
  $("#statusbar")?.classList?.toggle("busy", Boolean(state.streaming))
  renderChrome()
}

function messageNode(message, toolResults) {
  const node = document.createElement("article")
  node.className = `message ${message.role}`
  const isUser = message.role === "user"
  const meta = message.meta || {}
  const toolCalls = message.toolCalls || []
  node.innerHTML = `
    <div class="msg-main">
      <div class="msg-head">
        <strong>${isUser ? "You · Message" : "✦ ZYCRON AI"}</strong>
        ${isUser ? "" : `<span class="model-tag">${escapeHtml(meta.providerName || meta.provider || "")}${meta.model ? ` · ${escapeHtml(meta.model)}` : ""}</span>`}
        <span>${timeAgo(message.createdAt)}</span>
      </div>
      ${meta.thinking ? `<details class="msg-thinking"><summary>thinking</summary>${escapeHtml(meta.thinking)}</details>` : ""}
      <div class="msg-bubble">${isUser ? `<div class="md">${escapeHtml(message.content || "")}</div>` : `<div class="md">${renderMarkdown(message.content || "")}</div>`}</div>
      ${attachmentsHtml(message.attachments)}
      ${!isUser && toolCalls.length ? `<div class="tool-group">${toolCalls.map((call) => toolCardHtml(call, toolResults.get(call.id))).join("")}</div>` : ""}
      ${meta.error ? `<div class="msg-notice msg-error">${escapeHtml(meta.error)}</div>` : ""}
      <div class="msg-actions">
        <button type="button" data-act="copy-message" data-id="${escapeHtml(message.id || "")}"><svg class="icon"><use href="#i-copy"></use></svg>copy</button>
        ${isUser ? `<button type="button" data-act="edit-message" data-id="${escapeHtml(message.id || "")}"><svg class="icon"><use href="#i-edit"></use></svg>edit</button>` : ""}
        ${!isUser && message.id ? `<button type="button" data-act="regenerate"><svg class="icon"><use href="#i-refresh"></use></svg>retry</button>` : ""}
      </div>
      ${meta.usage ? `<div class="msg-usage">${formatTokens(Number(meta.usage.input || 0) + Number(meta.usage.output || 0))} tokens</div>` : ""}
    </div>`
  return node
}

function attachmentsHtml(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return ""
  return `<div class="attachment-grid">${attachments.map((file) => {
    if (file.kind === "image" && file.upload) {
      return `<div class="attachment-thumb"><img src="${uploadUrl(file.upload)}" alt="${escapeHtml(file.name)}" loading="lazy"></div>`
    }
    return `<div class="attachment-file"><svg class="icon"><use href="#i-file"></use></svg><span>${escapeHtml(file.name)}</span></div>`
  }).join("")}</div>`
}

function toolCardHtml(call, result) {
  const name = call.name || call.function?.name || "tool"
  let args = call.args || {}
  if (!call.args && call.function?.arguments) {
    try {
      args = JSON.parse(call.function.arguments)
    } catch {
      args = {}
    }
  }
  const status = result?.meta?.status || "done"
  const output = result?.content || JSON.stringify(args, null, 2)
  const summary = args.path || args.command || args.name || args.from || name
  const icon = name === "run_command" ? "i-terminal" : name === "search_files" ? "i-search" : "i-file"
  return `<details class="tool-card" data-status="${escapeHtml(status)}" data-tool-id="${escapeHtml(call.id || "")}">
    <summary><svg class="icon"><use href="#${icon}"></use></svg><span>${escapeHtml(summary)}</span><span class="tool-status">${escapeHtml(status)}</span></summary>
    <pre>${escapeHtml(String(output))}</pre>
  </details>`
}

function addStreamToolCard(id, name, args) {
  const group = state.streaming?.toolGroup
  if (!group) return
  group.hidden = false
  const card = document.createElement("details")
  card.className = "tool-card"
  card.dataset.status = "running"
  card.dataset.toolId = id
  const summary = args?.path || args?.command || args?.name || args?.query || name
  card.innerHTML = `<summary><svg class="icon"><use href="#${name === "run_command" ? "i-terminal" : "i-file"}"></use></svg><span>${escapeHtml(summary)}</span><span class="tool-status">running</span></summary><pre>${escapeHtml(JSON.stringify(args || {}, null, 2))}</pre></details>`
  group.append(card)
  state.streaming.tools.set(id, card)
  maybeScroll()
}

function finishStreamToolCard(id, status, output) {
  const card = state.streaming?.tools?.get(id)
  if (!card) return
  card.dataset.status = status || "done"
  const statusNode = $(".tool-status", card)
  if (statusNode) statusNode.textContent = status || "done"
  const pre = $("pre", card)
  if (pre) pre.textContent = String(output || "")
  maybeScroll()
}

function onScroll() {
  const host = $("#chatScroll")
  if (!host) return
  $("#scrollBottom").hidden = host.scrollHeight - host.scrollTop - host.clientHeight < 120
}

function maybeScroll(force = false) {
  const host = $("#chatScroll")
  if (!host) return
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 180
  if (force || nearBottom) host.scrollTop = host.scrollHeight
}

function scrollToBottom(smooth = false) {
  const host = $("#chatScroll")
  if (!host) return
  host.scrollTo({ top: host.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  $("#scrollBottom").hidden = true
}

async function newChat() {
  if (state.streaming) await stopStreaming()
  const previous = state.current
  state.current = null
  state.messages = []
  state.attachments = []
  state.draft = {
    providerId: previous?.providerId || state.draft.providerId || "auto",
    model: previous?.model || state.draft.model || "auto",
    mode: previous?.mode || state.draft.mode || "build",
    projectId: previous?.projectId || state.draft.projectId || defaultProject()?.id || null,
    title: ""
  }
  state.project = projectById(state.draft.projectId) || defaultProject()
  $("#chatTitle").value = "New chat"
  $("#input").value = ""
  renderAttachmentBar()
  renderSidebar()
  renderMessages()
  renderChrome()
  resizeInput()
  toggleSidebar(false)
  scrollToBottom(true)
  $("#input").focus()
}

async function loadConversation(id, { silent = false } = {}) {
  if (!id) return
  if (state.streaming && !silent) await stopStreaming()
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`)
    state.current = normalizeConversation(data.conversation)
    state.messages = data.messages || []
    state.project = data.project || null
    state.draft.providerId = state.current.providerId
    state.draft.model = state.current.model
    state.draft.mode = state.current.mode
    state.draft.projectId = state.current.projectId || state.project?.id || defaultProject()?.id || null
    state.attachments = []
    renderAttachmentBar()
    renderMessages()
    if (document.activeElement !== $("#chatTitle")) $("#chatTitle").value = state.current.title
    renderSidebar()
    renderChrome()
    if (!silent) {
      $("#input").value = ""
      resizeInput()
      toggleSidebar(false)
      scrollToBottom()
      $("#input").focus()
    }
    maybeScroll()
  } catch (error) {
    if (error.status === 404) {
      toast("Session no longer exists.", "err")
      state.conversations = state.conversations.filter((item) => item.id !== id)
      renderSidebar()
      if (state.current?.id === id) await newChat()
    } else {
      toast(error.message, "err")
    }
  }
}

async function saveTitle() {
  const input = $("#chatTitle")
  const title = input.value.trim() || "New chat"
  input.value = title
  if (state.current) {
    if (title === state.current.title) return
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(state.current.id)}`, { method: "PATCH", body: { title } })
      state.current = normalizeConversation(data.conversation)
      renderSidebar()
      renderChrome()
    } catch (error) {
      toast(error.message, "err")
      input.value = state.current.title
    }
  } else {
    state.draft.title = title === "New chat" ? "" : title
  }
}

async function setMode(mode) {
  if (!MODES.some((item) => item.id === mode)) return
  if (state.current) {
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(state.current.id)}`, { method: "PATCH", body: { mode } })
      state.current = normalizeConversation(data.conversation)
    } catch (error) {
      toast(error.message, "err")
      return
    }
  }
  state.draft.mode = mode
  renderChrome()
  renderMessages()
  toast(`Mode: ${mode}`, "ok")
}

async function setModel(providerId, model) {
  if (state.current) {
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(state.current.id)}`, { method: "PATCH", body: { providerId, model } })
      state.current = normalizeConversation(data.conversation)
    } catch (error) {
      toast(error.message, "err")
      return
    }
  }
  state.draft.providerId = providerId
  state.draft.model = model
  renderChrome()
  toast(`Model: ${modelName(providerId, model)}`, "ok")
}

async function setProject(projectId) {
  if (state.current) {
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(state.current.id)}`, { method: "PATCH", body: { projectId } })
      state.current = normalizeConversation(data.conversation)
      state.project = projectById(projectId)
    } catch (error) {
      toast(error.message, "err")
      return
    }
  }
  state.draft.projectId = projectId
  state.mentionCache = { projectId: "", files: [] }
  renderChrome()
  toast(`Project: ${projectName(projectId)}`, "ok")
}

async function refreshProjects() {
  const data = await api("/api/projects")
  state.projects = data.projects || []
  renderChrome()
}

function onInputChange() {
  resizeInput()
  detectSuggestions()
}

function resizeInput() {
  const input = $("#input")
  if (!input) return
  input.style.height = "auto"
  input.style.height = `${Math.min(220, Math.max(24, input.scrollHeight))}px`
}

function onInputKeyDown(event) {
  const input = event.target
  if (event.isComposing) return
  if (state.suggestions.items.length) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      state.suggestions.index = (state.suggestions.index + 1) % state.suggestions.items.length
      renderSuggestions()
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      state.suggestions.index = (state.suggestions.index - 1 + state.suggestions.items.length) % state.suggestions.items.length
      renderSuggestions()
      return
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault()
      chooseSuggestion(state.suggestions.index)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      hideSuggestions()
      return
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    sendMessage().catch((error) => toast(error.message, "err"))
    return
  }
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !input.value.includes("\n")) {
    if (event.key === "ArrowUp" && input.selectionStart === 0) {
      event.preventDefault()
      historyMove(-1)
    } else if (event.key === "ArrowDown" && input.selectionStart === input.value.length) {
      event.preventDefault()
      historyMove(1)
    }
  }
}

function historyMove(direction) {
  const input = $("#input")
  if (!state.history.length) return
  if (state.historyIndex === -1) {
    state.historyDraft = input.value
    state.historyIndex = direction < 0 ? state.history.length - 1 : -1
  } else {
    state.historyIndex += direction
  }
  if (state.historyIndex < -1) state.historyIndex = -1
  if (state.historyIndex >= state.history.length) state.historyIndex = -1
  input.value = state.historyIndex === -1 ? state.historyDraft : state.history[state.historyIndex]
  resizeInput()
  input.setSelectionRange(input.value.length, input.value.length)
}

function detectSuggestions() {
  const input = $("#input")
  const cursor = input.selectionStart
  const before = input.value.slice(0, cursor)
  if (/^\/[^\s\n]*$/.test(before)) {
    const query = before.slice(1).toLowerCase()
    const items = COMMANDS.filter(([name, usage, description]) => {
      const hay = `${name} ${usage} ${description}`.toLowerCase()
      return !query || hay.includes(query)
    }).slice(0, 12).map(([label, hint, description]) => ({ label, hint, description, insert: `${label} `, group: "COMMANDS", icon: "i-terminal" }))
    state.suggestions = { items, index: 0, start: 0, mode: "command" }
    renderSuggestions()
    return
  }
  const match = /(^|\s)([@#])([^\s\n]*)$/.exec(before)
  if (!match) {
    hideSuggestions()
    return
  }
  const trigger = match[2]
  const query = match[3].toLowerCase()
  const start = cursor - match[3].length - 1
  if (trigger === "#") {
    const items = MODES.filter((mode) => !query || mode.id.includes(query) || mode.name.toLowerCase().includes(query))
      .map((mode) => ({ label: `#${mode.id}`, hint: mode.name, description: mode.copy, insert: `#${mode.id} `, group: "AGENTS", icon: "i-spark" }))
    state.suggestions = { items, index: 0, start, mode: "agent" }
    renderSuggestions()
    return
  }
  const projectId = activeProjectId()
  if (!projectId) {
    hideSuggestions()
    return
  }
  loadMentionFiles(projectId).then((files) => {
    const currentBefore = $("#input").value.slice(0, $("#input").selectionStart)
    if (!currentBefore.endsWith(before.slice(before.lastIndexOf("@")))) return
    const items = files.filter((file) => !query || file.path.toLowerCase().includes(query)).slice(0, 30)
      .map((file) => ({ label: `@${file.path}`, hint: file.language || "file", description: file.path, insert: `@${file.path} `, group: "FILES", icon: "i-file" }))
    state.suggestions = { items, index: 0, start, mode: "file" }
    renderSuggestions()
  }).catch(() => hideSuggestions())
}

async function loadMentionFiles(projectId) {
  if (state.mentionCache.projectId === projectId && state.mentionCache.files.length) return state.mentionCache.files
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}/tree?depth=6`)
  const files = []
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === "file") files.push(node)
      else if (node.children) walk(node.children)
      if (files.length >= 900) return
    }
  }
  walk(data.tree)
  state.mentionCache = { projectId, files }
  return files
}

function renderSuggestions() {
  const menu = $("#suggestions")
  const { items, index } = state.suggestions
  if (!items.length) {
    menu.hidden = true
    return
  }
  menu.hidden = false
  const groups = new Map()
  items.forEach((item, itemIndex) => {
    if (!groups.has(item.group)) groups.set(item.group, [])
    groups.get(item.group).push({ item, itemIndex })
  })
  menu.innerHTML = [...groups.entries()].map(([group, entries]) => `
    <div class="suggestion-group-title">${escapeHtml(group)}</div>
    ${entries.map(({ item, itemIndex }) => `<button type="button" class="suggestion-item ${itemIndex === index ? "active" : ""}" data-suggest="${itemIndex}">
      <svg class="icon"><use href="#${item.icon}"></use></svg>
      <strong>${escapeHtml(item.label)}</strong>
      <small>${escapeHtml(item.hint || item.description || "")}</small>
    </button>`).join("")}
  `).join("")
}

function hideSuggestions() {
  state.suggestions = { items: [], index: 0, start: 0, mode: "" }
  const menu = $("#suggestions")
  if (menu) menu.hidden = true
}

function chooseSuggestion(index) {
  const item = state.suggestions.items[index]
  if (!item) return
  const input = $("#input")
  const cursor = input.selectionStart
  const before = input.value.slice(0, state.suggestions.start)
  const after = input.value.slice(cursor)
  input.value = `${before}${item.insert}${after}`
  const position = before.length + item.insert.length
  input.setSelectionRange(position, position)
  hideSuggestions()
  resizeInput()
  input.focus()
}

async function sendMessage() {
  if (state.streaming) {
    toast("Wait for the current response or press stop.", "err")
    return
  }
  const input = $("#input")
  const text = input.value.trim()
  if (!text && !state.attachments.length) return
  if (!state.attachments.length && text.startsWith("/")) {
    const handled = await handleCommand(text)
    if (handled) {
      input.value = ""
      resizeInput()
      hideSuggestions()
      return
    }
  }
  const attachments = state.attachments.slice()
  const payload = { message: text, attachments: attachments.map(({ url, ...file }) => file) }
  if (state.current) {
    payload.conversationId = state.current.id
    payload.providerId = state.current.providerId
    payload.model = state.current.model
  } else {
    payload.providerId = state.draft.providerId || "auto"
    payload.model = state.draft.model || "auto"
    payload.mode = state.draft.mode || "build"
    payload.projectId = state.draft.projectId || defaultProject()?.id || null
    if (state.draft.title) payload.title = state.draft.title
  }
  state.history = [text, ...state.history.filter((entry) => entry !== text)].slice(0, 60)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history))
  state.historyIndex = -1
  state.historyDraft = ""
  input.value = ""
  resizeInput()
  hideSuggestions()
  state.attachments = []
  renderAttachmentBar()
  const optimistic = { id: "", conversationId: state.current?.id || "", role: "user", content: text, attachments, createdAt: Date.now(), meta: {} }
  state.messages.push(optimistic)
  const host = $("#messages")
  $("#welcome").classList.add("hidden")
  host.append(messageNode(optimistic, new Map()))
  scrollToBottom(true)
  await streamChat(payload)
}

function startAssistantBubble() {
  const host = $("#messages")
  const node = document.createElement("article")
  node.className = "message assistant streaming"
  node.innerHTML = `<div class="msg-main">
      <div class="msg-head"><strong>✦ ZYCRON AI</strong><span class="model-tag" data-live-model></span><span>now</span></div>
      <div class="msg-bubble">
        <div class="thinking-placeholder" data-placeholder>Connecting to a model<span class="dots">...</span></div>
        <details class="msg-thinking" data-live-thinking hidden><summary>thinking</summary><div data-thinking-text></div></details>
        <div class="md" data-live-md></div><span class="stream-caret"></span>
        <div class="msg-notice" data-live-notice hidden></div>
      </div>
      <div class="tool-group" data-live-tools hidden></div>
      <div class="msg-actions"><button type="button" data-act="copy-live"><svg class="icon"><use href="#i-copy"></use></svg>copy</button></div>
    </div>`
  host.append(node)
  return {
    node,
    md: $("[data-live-md]", node),
    placeholder: $("[data-placeholder]", node),
    thinking: $("[data-live-thinking]", node),
    thinkingText: $("[data-thinking-text]", node),
    notice: $("[data-live-notice]", node),
    model: $("[data-live-model]", node),
    toolGroup: $("[data-live-tools]", node)
  }
}

function buildStreamingState(bubble, controller) {
  return {
    controller,
    requestId: "",
    node: bubble.node,
    md: bubble.md,
    placeholder: bubble.placeholder,
    thinking: bubble.thinking,
    thinkingText: bubble.thinkingText,
    notice: bubble.notice,
    model: bubble.model,
    toolGroup: bubble.toolGroup,
    tools: new Map(),
    content: "",
    thinkingContent: "",
    finalized: false,
    provider: "",
    modelName: "",
    usage: null
  }
}

async function readChatStream(response, streamingState) {
  if (!response.body) {
    finalizeStream({ error: "Streaming is not supported by this browser." })
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let boundary
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        handleSseBlock(block)
        if (streamingState.finalized) return
      }
      if (streamingState.finalized) return
    }
    if (!streamingState.finalized) finalizeStream({ error: "Connection closed before the response finished." })
  } catch (error) {
    if (!streamingState.finalized) {
      if (error.name === "AbortError" || streamingState.stopping) finalizeStream({ stopped: true })
      else finalizeStream({ error: error.message })
    }
  }
}

async function streamChat(payload) {
  const bubble = startAssistantBubble()
  const controller = new AbortController()
  const streamingState = buildStreamingState(bubble, controller)
  state.streaming = streamingState
  renderChrome()
  scrollToBottom(true)
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const data = await response.json()
        message = data.error || message
      } catch {}
      finalizeStream({ error: message })
      return
    }
    await readChatStream(response, streamingState)
  } catch (error) {
    if (!streamingState.finalized) finalizeStream({ error: error.name === "AbortError" ? "" : error.message })
  }
}

async function regenerate() {
  if (!state.current || state.streaming) return
  const bubble = startAssistantBubble()
  const controller = new AbortController()
  const streamingState = buildStreamingState(bubble, controller)
  state.streaming = streamingState
  renderChrome()
  scrollToBottom(true)
  try {
    const response = await fetch("/api/chat/regenerate", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({ conversationId: state.current.id }),
      signal: controller.signal
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const data = await response.json()
        message = data.error || message
      } catch {}
      finalizeStream({ error: message })
      return
    }
    await readChatStream(response, streamingState)
  } catch (error) {
    if (!streamingState.finalized) finalizeStream({ error: error.name === "AbortError" ? "" : error.message })
  }
}

function handleSseBlock(block) {
  const streamingState = state.streaming
  if (!streamingState || streamingState.finalized) return
  let event = "message"
  const dataLines = []
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return
  let data
  try {
    data = JSON.parse(dataLines.join("\n"))
  } catch {
    return
  }
  if (event === "ready") {
    streamingState.requestId = data.requestId
    const conversation = normalizeConversation(data.conversation)
    state.current = conversation
    if (conversation?.projectId) state.project = projectById(conversation.projectId)
    $("#chatTitle").value = conversation?.title || "New chat"
    state.draft.providerId = conversation?.providerId || "auto"
    state.draft.model = conversation?.model || "auto"
    state.draft.mode = conversation?.mode || "build"
    state.draft.projectId = conversation?.projectId || state.draft.projectId
    refreshConversations().catch(() => {})
    renderChrome()
    return
  }
  if (event === "conversation") {
    const conversation = normalizeConversation(data.conversation)
    if (conversation) {
      state.current = { ...(state.current || {}), ...conversation }
      if (document.activeElement !== $("#chatTitle")) $("#chatTitle").value = conversation.title || "New chat"
      renderChrome()
    }
    return
  }
  if (event === "meta") {
    streamingState.provider = data.providerName || ""
    streamingState.modelName = data.model || ""
    streamingState.model.textContent = [data.providerName, data.model].filter(Boolean).join(" · ")
    $("#statusModel").textContent = data.model || $("#statusModel").textContent
    return
  }
  if (event === "delta") {
    if (streamingState.placeholder) {
      streamingState.placeholder.remove()
      streamingState.placeholder = null
    }
    streamingState.content += data.text || ""
    scheduleStreamRender()
    maybeScroll()
    return
  }
  if (event === "thinking") {
    streamingState.thinkingContent += data.text || ""
    if (streamingState.thinking) {
      streamingState.thinking.hidden = false
      streamingState.thinkingText.textContent = streamingState.thinkingContent.slice(-6000)
    }
    return
  }
  if (event === "notice") {
    streamingState.notice.hidden = false
    streamingState.notice.textContent = data.message || "Provider failed; trying another model."
    return
  }
  if (event === "tool_start") {
    addStreamToolCard(data.id, data.name, data.args)
    return
  }
  if (event === "tool_end") {
    finishStreamToolCard(data.id, data.status, data.output)
    return
  }
  if (event === "approval") {
    openApproval(data)
    return
  }
  if (event === "usage") {
    streamingState.usage = data
    const today = state.usage.today || { tokens_in: 0, tokens_out: 0, requests: 0 }
    today.tokens_in = Number(today.tokens_in || 0) + Number(data.input || 0)
    today.tokens_out = Number(today.tokens_out || 0) + Number(data.output || 0)
    today.requests = Number(today.requests || 0) + 1
    state.usage.today = today
    $("#statusUsage").textContent = `${formatTokens(dayTokens())} tokens today`
    return
  }
  if (event === "step") {
    $("#composerHint").textContent = `Step ${data.step} · ${data.tools} tool${data.tools === 1 ? "" : "s"} · working`
    return
  }
  if (event === "file_changed") {
    if (state.ws && state.ws.projectId === data.projectId) refreshWorkspaceTree().catch(() => {})
    return
  }
  if (event === "project") {
    refreshProjects().catch(() => {})
    return
  }
  if (event === "error") {
    finalizeStream({ error: data.message || "Chat failed." })
    return
  }
  if (event === "stopped") {
    finalizeStream({ stopped: true })
    return
  }
  if (event === "done") {
    $("#composerHint").textContent = "Enter to send · Shift+Enter newline · ↑ history"
    finalizeStream({ done: true })
  }
}

function scheduleStreamRender() {
  const streamingState = state.streaming
  if (!streamingState || streamingState.finalized) return
  if (streamingState.rendering) {
    streamingState.pending = true
    return
  }
  streamingState.rendering = true
  requestAnimationFrame(() => {
    const current = state.streaming
    if (!current || current.finalized) return
    current.rendering = false
    current.pending = false
    current.md.innerHTML = renderMarkdown(current.content)
  })
}

function finalizeStream({ error = "", done = false, stopped = false } = {}) {
  const streamingState = state.streaming
  if (!streamingState || streamingState.finalized) return
  streamingState.finalized = true
  state.streaming = null
  if (streamingState.placeholder) streamingState.placeholder.remove()
  streamingState.node.classList.remove("streaming")
  $(".stream-caret", streamingState.node)?.remove()
  if (error) {
    streamingState.notice.hidden = false
    streamingState.notice.classList.add("msg-error")
    streamingState.notice.textContent = error
  } else if (stopped) {
    streamingState.notice.hidden = false
    streamingState.notice.textContent = "Stopped."
  }
  if (streamingState.content) streamingState.md.innerHTML = renderMarkdown(streamingState.content)
  $("#sendBtn").hidden = false
  $("#stopBtn").hidden = true
  $("#statusbar")?.classList?.remove("busy")
  $("#heroBadge").textContent = "● READY"
  $("#composerHint").textContent = "Enter to send · Shift+Enter newline · ↑ history"
  renderChrome()
  refreshConversations().catch(() => {})
  if (done && state.current?.id) {
    setTimeout(() => {
      if (!state.streaming && state.current?.id) loadConversation(state.current.id, { silent: true })
    }, 120)
  } else if (error) {
    toast(error, "err")
  }
  $("#input")?.focus()
}

async function stopStreaming() {
  const streamingState = state.streaming
  if (!streamingState) return
  streamingState.stopping = true
  try {
    if (streamingState.requestId) await api(`/api/chat/${encodeURIComponent(streamingState.requestId)}/stop`, { method: "POST", body: {} })
  } catch {}
  try {
    streamingState.controller.abort()
  } catch {}
  finalizeStream({ stopped: true })
}

async function handleCommand(raw) {
  const trimmed = raw.trim()
  const [command, ...rest] = trimmed.split(/\s+/)
  const arg = rest.join(" ").trim()
  const known = COMMANDS.some(([name]) => name === command.toLowerCase())
  if (!known) {
    toast(`Unknown command: ${command}. Type /help.`, "err")
    return true
  }
  const name = command.toLowerCase()
  if (name === "/help") openHelp()
  else if (name === "/new") await newChat()
  else if (name === "/clear") await clearCurrent()
  else if (name === "/model" || name === "/models") openModelPicker()
  else if (name === "/provider") openSettings("providers")
  else if (name === "/agent" || name === "/agents") openModePicker()
  else if (["/plan", "/build", "/debug", "/review"].includes(name)) await setMode(name.slice(1))
  else if (name === "/compact") await compactCurrent()
  else if (name === "/history" || name === "/sessions") openSessionManager()
  else if (name === "/undo") await undoRedo("undo")
  else if (name === "/redo") await undoRedo("redo")
  else if (name === "/settings") openSettings()
  else if (name === "/exit") toast("Close this browser tab to exit ZYCRON AI.")
  else if (name === "/switch") await switchSession(arg)
  else if (name === "/rename") await renameCurrent(arg)
  else if (name === "/delete") await deleteCurrent()
  else if (name === "/delete-all") await deleteAllSessions()
  else if (name === "/duplicate") await duplicateCurrent()
  else if (name === "/export") await exportCurrent()
  else if (name === "/search") {
    toggleSidebar(true)
    $("#sessionSearch").focus()
  } else if (name === "/stop") await stopStreaming()
  return true
}

async function clearCurrent() {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  const ok = await confirmDialog({ title: "Clear session", message: "Delete all messages in this session? This cannot be undone.", confirmText: "Clear" })
  if (!ok) return
  try {
    await api(`/api/conversations/${encodeURIComponent(state.current.id)}/clear`, { method: "POST", body: {} })
    await loadConversation(state.current.id)
    toast("Session cleared.", "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

async function compactCurrent() {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  try {
    await api(`/api/conversations/${encodeURIComponent(state.current.id)}/compact`, { method: "POST", body: {} })
    toast("Older context will be skipped.", "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

async function undoRedo(action) {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(state.current.id)}/${action}`, { method: "POST", body: {} })
    const result = data.result || {}
    toast(result.path ? `${action}: ${result.path}` : `Nothing to ${action}.`, result.path ? "ok" : "err")
    if (state.ws) refreshWorkspaceTree().catch(() => {})
  } catch (error) {
    toast(error.message, "err")
  }
}

async function switchSession(arg) {
  const visible = state.conversations.filter((item) => !item.archived)
  if (!visible.length) {
    toast("No sessions to switch to.", "err")
    return
  }
  let target = null
  if (arg && /^\d+$/.test(arg)) target = visible[Number(arg) - 1]
  else if (arg) target = visible.find((item) => item.id === arg) || visible.find((item) => item.title.toLowerCase().includes(arg.toLowerCase()))
  if (!target) {
    toast(arg ? `No session matching "${arg}".` : "Usage: /switch 2", "err")
    return
  }
  await loadConversation(target.id)
}

async function renameCurrent(arg) {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  if (arg) {
    await renameConversation(state.current.id, arg)
    return
  }
  const value = await textPrompt({ title: "Rename session", label: "Session title", value: state.current.title || "New chat" })
  if (value) await renameConversation(state.current.id, value)
}

async function deleteCurrent() {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  const ok = await confirmDialog({ title: "Delete session", message: `Delete "${state.current.title}" and all of its messages?`, confirmText: "Delete", danger: true })
  if (!ok) return
  try {
    await api(`/api/conversations/${encodeURIComponent(state.current.id)}`, { method: "DELETE" })
    state.conversations = state.conversations.filter((item) => item.id !== state.current.id)
    await newChat()
    toast("Session deleted.", "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

async function deleteAllSessions() {
  const ok = await confirmDialog({ title: "Delete all sessions", message: "This deletes every session and message, including pinned sessions. Project files are not touched.", confirmText: "Delete all", danger: true })
  if (!ok) return
  try {
    const data = await api("/api/conversations", { method: "DELETE" })
    state.conversations = []
    await newChat()
    toast(`Deleted ${data.deleted || 0} sessions.`, "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

async function duplicateCurrent() {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(state.current.id)}/duplicate`, { method: "POST", body: {} })
    await refreshConversations()
    await loadConversation(data.conversation.id)
    toast("Session duplicated.", "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

async function exportCurrent() {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  await exportConversation(state.current.id, "md")
}

async function exportConversation(id, format = "md") {
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`, { headers: authHeaders() })
    if (response.status === 401) {
      showTokenScreen()
      return
    }
    if (!response.ok) throw new Error(`Export failed (${response.status})`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    const title = (state.current?.title || "session").replace(/[^\w.-]+/g, "-").slice(0, 60)
    anchor.href = url
    anchor.download = `zycron-${title}.${format}`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch (error) {
    toast(error.message, "err")
  }
}

async function renameConversation(id, title) {
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: { title } })
    if (state.current?.id === id) {
      state.current = normalizeConversation(data.conversation)
      renderChrome()
    }
    await refreshConversations()
    toast("Session renamed.", "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

async function handleFiles(fileList, kindHint) {
  const files = [...(fileList || [])]
  if (!files.length) return
  if (state.attachments.length + files.length > MAX_ATTACHMENTS) {
    toast(`Attach up to ${MAX_ATTACHMENTS} files.`, "err")
    return
  }
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      toast(`${file.name} is larger than 15 MB.`, "err")
      continue
    }
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const isImage = kindHint === "image" || file.type.startsWith("image/")
      let text = ""
      if (!isImage && (file.type.startsWith("text/") || /\.(txt|md|json|js|ts|py|html|css|csv|sql|yml|yaml|toml|sh|xml|ini)$/i.test(file.name))) {
        text = (await file.text()).slice(0, 20000)
      }
      const data = await api("/api/uploads", {
        method: "POST",
        body: { name: file.name, type: file.type || "application/octet-stream", dataUrl }
      })
      state.attachments.push({
        name: data.upload?.name || file.name,
        type: data.upload?.type || file.type || "application/octet-stream",
        size: data.upload?.size || file.size,
        upload: data.upload?.upload || "",
        kind: isImage ? "image" : "text",
        text,
        url: data.upload?.url || ""
      })
      renderAttachmentBar()
    } catch (error) {
      toast(`${file.name}: ${error.message}`, "err")
    }
  }
  $("#fileInput").value = ""
  $("#imageInput").value = ""
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ""))
    reader.onerror = () => reject(reader.error || new Error("Could not read file"))
    reader.readAsDataURL(file)
  })
}

function renderAttachmentBar() {
  const bar = $("#attachmentBar")
  if (!state.attachments.length) {
    bar.hidden = true
    bar.innerHTML = ""
    return
  }
  bar.hidden = false
  bar.innerHTML = state.attachments.map((file, index) => `<span class="attachment-chip">
    ${file.kind === "image" && file.upload ? `<img src="${uploadUrl(file.upload)}" alt="">` : `<svg class="icon"><use href="#i-file"></use></svg>`}
    <span>${escapeHtml(file.name)}</span>
    <button type="button" data-act="remove-attachment" data-index="${index}" title="Remove"><svg class="icon"><use href="#i-close"></use></svg></button>
  </span>`).join("")
}

async function editMessage(id) {
  const message = state.messages.find((item) => item.id === id)
  if (!message || message.role !== "user") return
  const value = await textPrompt({ title: "Edit message", label: "Message", value: message.content, multiline: true })
  if (value === null || value === message.content) return
  try {
    await api(`/api/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: { content: value } })
    await loadConversation(message.conversationId, { silent: true })
    await regenerate()
  } catch (error) {
    toast(error.message, "err")
  }
}

function onDocumentClick(event) {
  const actionNode = event.target.closest("[data-act]")
  if (actionNode) {
    const act = actionNode.dataset.act
    const id = actionNode.dataset.id
    if (act === "open-conv") loadConversation(id)
    else if (act === "pin-conv") toggleConversation(id, "pinned")
    else if (act === "archive-conv") toggleConversation(id, "archived")
    else if (act === "rename-conv") {
      const conversation = state.conversations.find((item) => item.id === id)
      if (conversation) openRenameDialog(conversation)
    } else if (act === "delete-conv") {
      const conversation = state.conversations.find((item) => item.id === id)
      if (conversation) deleteConversation(id, conversation.title)
    } else if (act === "copy-message") {
      const message = state.messages.find((item) => item.id === id)
      if (message) copyText(message.content)
    } else if (act === "copy-live") {
      if (state.streaming) copyText(state.streaming.content)
    } else if (act === "edit-message") editMessage(id)
    else if (act === "regenerate") regenerate()
    else if (act === "remove-attachment") {
      state.attachments.splice(Number(actionNode.dataset.index), 1)
      renderAttachmentBar()
    }
    return
  }
  const copyCode = event.target.closest(".copy-code")
  if (copyCode) copyText(copyCode.closest(".code-block")?.querySelector("code")?.textContent || "")
}

async function toggleConversation(id, field) {
  const conversation = state.conversations.find((item) => item.id === id)
  if (!conversation) return
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: { [field]: !conversation[field] } })
    const updated = normalizeConversation(data.conversation)
    state.conversations = state.conversations.map((item) => item.id === id ? { ...item, ...updated } : item)
    if (state.current?.id === id) state.current = updated
    renderSidebar()
    renderChrome()
    toast(field === "pinned" ? (updated.pinned ? "Pinned." : "Unpinned.") : (updated.archived ? "Archived." : "Unarchived."), "ok")
  } catch (error) {
    toast(error.message, "err")
  }
}

function deleteConversation(id, title) {
  confirmDialog({ title: "Delete session", message: `Delete "${title}" and all of its messages?`, confirmText: "Delete", danger: true }).then(async (ok) => {
    if (!ok) return
    try {
      await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
      state.conversations = state.conversations.filter((item) => item.id !== id)
      if (state.current?.id === id) await newChat()
      else renderSidebar()
      toast("Session deleted.", "ok")
    } catch (error) {
      toast(error.message, "err")
    }
  })
}

function copyText(text) {
  if (!text) return
  navigator.clipboard?.writeText(text).then(() => toast("Copied.", "ok")).catch(() => toast("Clipboard is unavailable.", "err"))
}

function onGlobalKeyDown(event) {
  if (event.key === "Escape") {
    if (state.modals.length) closeTopModal()
    else if ($("#suggestions").hidden === false) hideSuggestions()
    else toggleSidebar(false)
    return
  }
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault()
    openModelPicker()
    return
  }
  if (mod && event.key.toLowerCase() === "s" && state.ws?.activePath) {
    event.preventDefault()
    saveWorkspaceFile()
    return
  }
  const tag = event.target.tagName
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || event.target.isContentEditable || mod || event.altKey) return
  if (event.key === "n") {
    event.preventDefault()
    newChat()
  } else if (event.key === "s") {
    event.preventDefault()
    openSessionManager()
  } else if (event.key === "p") {
    event.preventDefault()
    openWorkspace()
  } else if (event.key === ",") {
    event.preventDefault()
    openSettings()
  } else if (event.key === "?") {
    event.preventDefault()
    openHelp()
  }
}

function openModal({ title, subtitle = "", body = "", foot = "", size = "", dismissible = true, onClose = null }) {
  const overlay = document.createElement("div")
  overlay.className = "modal-overlay"
  overlay.innerHTML = `<section class="modal ${size}" role="dialog" aria-modal="true">
    <header class="modal-head"><h3>${escapeHtml(title)}</h3>${subtitle ? `<span class="modal-sub">${escapeHtml(subtitle)}</span>` : ""}<button class="icon-btn" type="button" data-modal-close title="Close"><svg class="icon"><use href="#i-close"></use></svg></button></header>
    <div class="modal-body">${body}</div>
    ${foot ? `<footer class="modal-foot">${foot}</footer>` : ""}
  </section>`
  $("#modalRoot").append(overlay)
  const close = () => {
    if (!overlay.isConnected) return
    overlay.remove()
    state.modals = state.modals.filter((item) => item.overlay !== overlay)
    onClose?.()
  }
  state.modals.push({ overlay, close })
  $("[data-modal-close]", overlay).addEventListener("click", close)
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && dismissible) close()
  })
  return { overlay, modal: $(".modal", overlay), body: $(".modal-body", overlay), foot: $(".modal-foot", overlay), close }
}

function closeTopModal() {
  state.modals[state.modals.length - 1]?.close()
}

function closeAllModals() {
  while (state.modals.length) closeTopModal()
}

function confirmDialog({ title, message, confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const dialog = openModal({
      title,
      size: "narrow",
      body: `<p style="margin:0;color:var(--muted);font-size:12px;line-height:1.7">${escapeHtml(message)}</p>`,
      foot: `<button class="btn" type="button" data-cancel>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" type="button" data-confirm>${escapeHtml(confirmText)}</button>`,
      onClose: () => finish(false)
    })
    $("[data-cancel]", dialog.overlay).addEventListener("click", () => {
      dialog.close()
      finish(false)
    })
    $("[data-confirm]", dialog.overlay).addEventListener("click", () => {
      dialog.close()
      finish(true)
    })
  })
}

function textPrompt({ title, label, value = "", multiline = false }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const field = multiline
      ? `<div class="field"><label>${escapeHtml(label)}</label><textarea data-prompt-input>${escapeHtml(value)}</textarea></div>`
      : `<div class="field"><label>${escapeHtml(label)}</label><input data-prompt-input value="${escapeHtml(value)}"></div>`
    const dialog = openModal({
      title,
      body: field,
      foot: `<button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-save>Save</button>`,
      onClose: () => finish(null)
    })
    const input = $("[data-prompt-input]", dialog.overlay)
    const submit = () => {
      const result = input.value
      dialog.close()
      finish(result)
    }
    $("[data-cancel]", dialog.overlay).addEventListener("click", () => {
      dialog.close()
      finish(null)
    })
    $("[data-save]", dialog.overlay).addEventListener("click", submit)
    input.addEventListener("keydown", (event) => {
      if (!multiline && event.key === "Enter") submit()
      if (event.key === "Escape") dialog.close()
    })
    setTimeout(() => {
      input.focus()
      input.select?.()
    }, 40)
  })
}

function openModePicker() {
  const body = `<div class="model-list">${MODES.map((mode) => `<button type="button" class="model-option ${activeMode() === mode.id ? "selected" : ""}" data-mode="${mode.id}">
    <span class="radio-dot"></span><span class="model-main"><strong>${mode.name}</strong><small>${escapeHtml(mode.copy)}</small></span>
  </button>`).join("")}</div>`
  const dialog = openModal({ title: "Agent mode", subtitle: activeMode(), body })
  $$("[data-mode]", dialog.overlay).forEach((button) => button.addEventListener("click", () => {
    dialog.close()
    setMode(button.dataset.mode)
  }))
}

function openModelPicker() {
  const dialog = openModal({
    title: "Select model",
    subtitle: `${state.models.filter((model) => model.free).length} free models`,
    size: "wide",
    body: `<label class="search-box model-picker-search"><svg class="icon"><use href="#i-search"></use></svg><input id="modelSearch" type="search" placeholder="Search models or providers" autocomplete="off"></label><div id="modelOptions"></div>`,
    foot: `<button class="btn" type="button" data-open-providers><svg class="icon"><use href="#i-settings"></use></svg>Providers</button><span class="spacer"></span><button class="btn" type="button" data-auto-model>Auto · free-first</button>`
  })
  const render = () => {
    const query = $("#modelSearch", dialog.overlay).value.trim().toLowerCase()
    const filtered = state.models.filter((model) => !query || `${model.label} ${model.model} ${model.provider}`.toLowerCase().includes(query))
    const groups = [
      ["FREE MODELS", filtered.filter((model) => model.free)],
      ["PAID MODELS", filtered.filter((model) => !model.free)]
    ]
    const auto = `<div class="model-group"><div class="model-group-title">ROUTING</div>
      <button type="button" class="model-option ${activeModel() === "auto" ? "selected" : ""}" data-auto>
        <span class="radio-dot"></span><span class="model-main"><strong>Auto · free-first</strong><small>Try free models first, fall back automatically</small></span>
      </button></div>`
    $("#modelOptions", dialog.overlay).innerHTML = auto + groups.map(([title, models]) => !models.length ? "" : `<div class="model-group"><div class="model-group-title">${title}</div>${models.map((model) => {
      const provider = providerById(model.providerId)
      const ready = providerReady(provider)
      const selected = activeProviderId() === model.providerId && activeModel() === model.model
      return `<button type="button" class="model-option ${selected ? "selected" : ""}" data-provider="${escapeHtml(model.providerId)}" data-model="${escapeHtml(model.model)}" data-ready="${ready ? "1" : "0"}">
        <span class="radio-dot"></span><span class="model-main"><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.provider)}${model.vision ? " · vision" : ""}${model.tools ? " · tools" : ""}${model.context ? ` · ${formatTokens(model.context)} ctx` : ""}${ready ? "" : " · add key"}</small></span>
        <span class="model-flags">${model.free ? '<span class="badge free">FREE</span>' : '<span class="badge paid">PAID</span>'}${ready ? "" : '<span class="badge key">KEY</span>'}</span>
      </button>`
    }).join("")}</div>`).join("")
    $$("[data-provider][data-model]", dialog.overlay).forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.ready !== "1") {
        toast(`${providerById(button.dataset.provider)?.name || "Provider"} needs an API key.`, "err")
        dialog.close()
        openSettings("providers")
        return
      }
      dialog.close()
      setModel(button.dataset.provider, button.dataset.model)
    }))
    $$("[data-auto]", dialog.overlay).forEach((button) => button.addEventListener("click", () => {
      dialog.close()
      setModel("auto", "auto")
    }))
  }
  $("#modelSearch", dialog.overlay).addEventListener("input", render)
  $("[data-auto-model]", dialog.overlay).addEventListener("click", () => {
    dialog.close()
    setModel("auto", "auto")
  })
  $("[data-open-providers]", dialog.overlay).addEventListener("click", () => {
    dialog.close()
    openSettings("providers")
  })
  render()
  setTimeout(() => $("#modelSearch", dialog.overlay)?.focus(), 40)
}

function openProjectPicker() {
  const body = `<div class="model-list">
    ${state.projects.map((project) => `<button type="button" class="model-option ${activeProjectId() === project.id ? "selected" : ""}" data-project="${escapeHtml(project.id)}">
      <span class="radio-dot"></span><span class="model-main"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.path)}</small></span>
    </button>`).join("")}
  </div>`
  const dialog = openModal({
    title: "Project context",
    body,
    foot: `<button class="btn" type="button" data-new-project><svg class="icon"><use href="#i-plus"></use></svg>New project</button><span class="spacer"></span><button class="btn" type="button" data-open-workspace><svg class="icon"><use href="#i-code"></use></svg>Workspace</button>`
  })
  $$("[data-project]", dialog.overlay).forEach((button) => button.addEventListener("click", () => {
    dialog.close()
    setProject(button.dataset.project)
  }))
  $("[data-new-project]", dialog.overlay).addEventListener("click", async () => {
    const name = await textPrompt({ title: "New project", label: "Project name" })
    if (!name) return
    try {
      const data = await api("/api/projects", { method: "POST", body: { name } })
      await refreshProjects()
      await setProject(data.project.id)
      dialog.close()
    } catch (error) {
      toast(error.message, "err")
    }
  })
  $("[data-open-workspace]", dialog.overlay).addEventListener("click", () => {
    dialog.close()
    openWorkspace()
  })
}

function openHelp() {
  const body = `<div class="help-grid">${COMMANDS.map(([name, usage, description]) => `<div class="help-command"><code>${escapeHtml(usage)}</code><span>${escapeHtml(description)}</span></div>`).join("")}</div>
    <div class="settings-section" style="margin-top:16px"><div class="settings-section-head"><h5>SHORTCUTS</h5></div>
      <div class="help-grid">
        <div class="help-command"><code>Enter</code><span>Send message</span></div>
        <div class="help-command"><code>Shift+Enter</code><span>New line</span></div>
        <div class="help-command"><code>↑ / ↓</code><span>Input history</span></div>
        <div class="help-command"><code>@</code><span>Mention a project file</span></div>
        <div class="help-command"><code>#</code><span>Mention an agent mode</span></div>
        <div class="help-command"><code>Ctrl+K</code><span>Model picker</span></div>
        <div class="help-command"><code>N / S / P / ,</code><span>New, sessions, projects, settings</span></div>
        <div class="help-command"><code>Ctrl+S</code><span>Save file in workspace</span></div>
      </div>
    </div>`
  openModal({ title: "Help", subtitle: "commands & shortcuts", size: "wide", body })
}

function openSessionManager() {
  const dialog = openModal({
    title: "Sessions",
    subtitle: `${state.conversations.length} total`,
    size: "wide",
    body: `<div class="session-manager">
      <div class="session-toolbar"><label class="search-box"><svg class="icon"><use href="#i-search"></use></svg><input id="sessionManagerSearch" type="search" placeholder="Search sessions" autocomplete="off"></label>
        <select id="sessionManagerSort"><option value="updated">updated</option><option value="created">created</option><option value="title">title</option></select>
        <select id="sessionManagerArchive"><option value="all">all</option><option value="0">active</option><option value="1">archived</option></select>
      </div>
      <div class="session-list" id="sessionManagerList"></div>
      <div class="session-footer"><span class="selected-count" id="sessionSelected">0 selected</span>
        <button class="btn small" type="button" id="sessionBulkArchive">Archive</button>
        <button class="btn small danger" type="button" id="sessionBulkDelete">Delete</button>
        <button class="btn small" type="button" id="sessionDeleteAll">Delete all</button>
        <span class="spacer"></span>
        <button class="btn primary small" type="button" id="sessionNew"><svg class="icon"><use href="#i-plus"></use></svg>New session</button>
      </div>
    </div>`
  })
  const selected = new Set()
  let query = ""
  let sort = "updated"
  let archived = "all"
  const list = $("#sessionManagerList", dialog.overlay)
  const updateSelected = () => {
    $("#sessionSelected", dialog.overlay).textContent = `${selected.size} selected`
  }
  const render = () => {
    const items = state.conversations.filter((conversation) => {
      if (archived === "0" && conversation.archived) return false
      if (archived === "1" && !conversation.archived) return false
      if (query && !`${conversation.title} ${conversation.preview}`.toLowerCase().includes(query)) return false
      return true
    }).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (sort === "title") return a.title.localeCompare(b.title)
      if (sort === "created") return b.createdAt - a.createdAt
      return b.updatedAt - a.updatedAt
    })
    if (!items.length) {
      list.innerHTML = `<div class="empty-state"><strong>No sessions</strong>Start a new session or clear your filters.</div>`
      updateSelected()
      return
    }
    list.innerHTML = items.map((conversation) => `<div class="session-row ${state.current?.id === conversation.id ? "active" : ""}">
      <input class="session-select" type="checkbox" data-select="${escapeHtml(conversation.id)}" ${selected.has(conversation.id) ? "checked" : ""}>
      <div class="session-main" data-session-open="${escapeHtml(conversation.id)}">
        <strong>${conversation.pinned ? "📌 " : ""}${escapeHtml(conversation.title || "New chat")}</strong>
        <small>${escapeHtml(modelName(conversation.providerId, conversation.model))} · ${timeAgo(conversation.updatedAt)} · ${conversation.messageCount} messages${conversation.archived ? " · archived" : ""}</small>
      </div>
      <div class="session-actions">
        <button type="button" data-session-act="rename" data-id="${escapeHtml(conversation.id)}" title="Rename"><svg class="icon"><use href="#i-edit"></use></svg></button>
        <button type="button" data-session-act="pin" data-id="${escapeHtml(conversation.id)}" title="Pin"><svg class="icon"><use href="#i-pin"></use></svg></button>
        <button type="button" data-session-act="duplicate" data-id="${escapeHtml(conversation.id)}" title="Duplicate"><svg class="icon"><use href="#i-copy"></use></svg></button>
        <button type="button" data-session-act="export" data-id="${escapeHtml(conversation.id)}" title="Export"><svg class="icon"><use href="#i-download"></use></svg></button>
        <button type="button" data-session-act="archive" data-id="${escapeHtml(conversation.id)}" title="Archive"><svg class="icon"><use href="#i-archive"></use></svg></button>
        <button type="button" data-session-act="delete" data-id="${escapeHtml(conversation.id)}" title="Delete"><svg class="icon"><use href="#i-trash"></use></svg></button>
      </div>
    </div>`).join("")
    updateSelected()
  }
  list.addEventListener("change", (event) => {
    const id = event.target.dataset.select
    if (!id) return
    if (event.target.checked) selected.add(id)
    else selected.delete(id)
    updateSelected()
  })
  list.addEventListener("click", async (event) => {
    const open = event.target.closest("[data-session-open]")
    if (open) {
      dialog.close()
      await loadConversation(open.dataset.sessionOpen)
      return
    }
    const action = event.target.closest("[data-session-act]")
    if (!action) return
    const { id } = action.dataset
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation) return
    const act = action.dataset.sessionAct
    if (act === "rename") openRenameDialog(conversation, () => refreshConversations().then(render))
    else if (act === "pin") await toggleConversation(id, "pinned").then(render)
    else if (act === "archive") await toggleConversation(id, "archived").then(render)
    else if (act === "duplicate") {
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: {} })
        await refreshConversations()
        render()
      } catch (error) {
        toast(error.message, "err")
      }
    } else if (act === "export") await exportConversation(id, "md")
    else if (act === "delete") {
      const ok = await confirmDialog({ title: "Delete session", message: `Delete "${conversation.title}"?`, confirmText: "Delete", danger: true })
      if (!ok) return
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
        await refreshConversations()
        if (state.current?.id === id) await newChat()
        render()
      } catch (error) {
        toast(error.message, "err")
      }
    }
  })
  $("#sessionManagerSearch", dialog.overlay).addEventListener("input", (event) => {
    query = event.target.value.trim().toLowerCase()
    render()
  })
  $("#sessionManagerSort", dialog.overlay).addEventListener("change", (event) => {
    sort = event.target.value
    render()
  })
  $("#sessionManagerArchive", dialog.overlay).addEventListener("change", (event) => {
    archived = event.target.value
    render()
  })
  $("#sessionBulkArchive", dialog.overlay).addEventListener("click", async () => {
    if (!selected.size) return toast("Select sessions first.", "err")
    for (const id of selected) {
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: { archived: true } })
      } catch {}
    }
    selected.clear()
    await refreshConversations()
    render()
  })
  $("#sessionBulkDelete", dialog.overlay).addEventListener("click", async () => {
    if (!selected.size) return toast("Select sessions first.", "err")
    const ok = await confirmDialog({ title: "Delete selected", message: `Delete ${selected.size} selected session(s)?`, confirmText: "Delete", danger: true })
    if (!ok) return
    for (const id of selected) {
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
      } catch {}
    }
    if (selected.has(state.current?.id)) await newChat()
    selected.clear()
    await refreshConversations()
    render()
  })
  $("#sessionDeleteAll", dialog.overlay).addEventListener("click", async () => {
    dialog.close()
    await deleteAllSessions()
  })
  $("#sessionNew", dialog.overlay).addEventListener("click", () => {
    dialog.close()
    newChat()
  })
  render()
}

function openRenameDialog(conversation, after = null) {
  textPrompt({ title: "Rename session", label: "Session title", value: conversation.title || "New chat" }).then(async (value) => {
    if (!value) return
    await renameConversation(conversation.id, value)
    after?.()
  })
}

function openSessionActions() {
  if (!state.current) {
    toast("No active session.", "err")
    return
  }
  const conversation = state.current
  const actions = [
    ["Rename", "rename"], ["Duplicate", "duplicate"], [conversation.pinned ? "Unpin" : "Pin", "pin"],
    [conversation.archived ? "Unarchive" : "Archive", "archive"], ["Compact context", "compact"],
    ["Undo file change", "undo"], ["Redo file change", "redo"], ["Export Markdown", "export-md"],
    ["Export JSON", "export-json"], ["Clear messages", "clear"], ["Delete session", "delete"]
  ]
  const body = `<div class="model-list">${actions.map(([label, act]) => `<button type="button" class="model-option" data-session-action="${act}"><span class="model-main"><strong>${label}</strong></span></button>`).join("")}</div>`
  const dialog = openModal({ title: "Session actions", subtitle: conversation.title, size: "narrow", body })
  $$("[data-session-action]", dialog.overlay).forEach((button) => button.addEventListener("click", async () => {
    const act = button.dataset.sessionAction
    if (act === "rename") { dialog.close(); openRenameDialog(conversation); return }
    if (act === "delete") { dialog.close(); await deleteCurrent(); return }
    if (act === "clear") { dialog.close(); await clearCurrent(); return }
    if (act === "export-md" || act === "export-json") {
      dialog.close()
      await exportConversation(conversation.id, act === "export-md" ? "md" : "json")
      return
    }
    dialog.close()
    if (act === "duplicate") await duplicateCurrent()
    else if (act === "pin") await toggleConversation(conversation.id, "pinned")
    else if (act === "archive") await toggleConversation(conversation.id, "archived")
    else if (act === "compact") await compactCurrent()
    else if (act === "undo" || act === "redo") await undoRedo(act)
  }))
}

let settingsRefresh = null

async function openSettings(tab = "general") {
  const tabs = [
    ["general", "General", "i-settings"],
    ["providers", "Providers", "i-folder"],
    ["models", "Models", "i-spark"],
    ["usage", "Usage", "i-play"],
    ["plugins", "Plugins", "i-code"],
    ["data", "Data", "i-archive"]
  ]
  let active = tabs.some(([id]) => id === tab) ? tab : "general"
  const dialog = openModal({
    title: "Settings",
    subtitle: `ZYCRON AI ${state.app?.version || ""}`,
    size: "full",
    body: `<div class="settings-layout">
      <nav class="settings-tabs">${tabs.map(([id, label, icon]) => `<button type="button" class="settings-tab ${id === active ? "active" : ""}" data-settings-tab="${id}"><svg class="icon"><use href="#${icon}"></use></svg>${label}</button>`).join("")}</nav>
      <div class="settings-content" id="settingsContent"></div>
    </div>`
  })
  $(".modal-body", dialog.overlay).classList.add("flush")
  const content = $("#settingsContent", dialog.overlay)

  const renderTab = async () => {
    $$("[data-settings-tab]", dialog.overlay).forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === active))
    content.innerHTML = settingsTabHtml(active)
    bindSettingsTab(content, active, renderTab)
    if (active === "general") renderAgentsStatus(content)
    if (active === "models") bindModelFilter(content)
  }
  settingsRefresh = renderTab
  $$("[data-settings-tab]", dialog.overlay).forEach((button) => button.addEventListener("click", () => {
    active = button.dataset.settingsTab
    renderTab()
  }))
  dialog.overlay.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view-agents]")
    if (view) {
      dialog.close()
      openWorkspace(activeProjectId(), { path: "AGENTS.md" })
      return
    }
    const create = event.target.closest("[data-create-agents]")
    if (create) createAgentsFile(activeProjectId(), renderTab)
  })
  await renderTab()
  dialog.overlay.addEventListener("DOMNodeRemoved", () => {
    if (settingsRefresh === renderTab) settingsRefresh = null
  })
  return dialog
}

function settingsTabHtml(tab) {
  if (tab === "general") {
    const settings = state.settings
    return `<h4>General</h4><p class="section-copy">Defaults for new sessions, routing, context, and appearance. Project instructions are loaded from AGENTS.md automatically.</p>
      <div class="settings-section">
        <div class="settings-section-head"><h5>MODEL ROUTING</h5></div>
        <div class="field-row">
          <div class="field"><label for="setRouting">Routing strategy</label><select id="setRouting"><option value="free-first" ${settings.routing === "free-first" ? "selected" : ""}>Free models first</option><option value="paid-first" ${settings.routing === "paid-first" ? "selected" : ""}>Paid models first</option><option value="manual" ${settings.routing === "manual" ? "selected" : ""}>Manual only</option></select><span class="hint">Auto mode tries free models before paid models.</span></div>
          <div class="field"><label for="setTemperature">Temperature</label><input id="setTemperature" type="number" min="0" max="2" step="0.1" value="${Number(settings.temperature ?? 0.7)}"><span class="hint">0 is focused, 2 is creative.</span></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="setSteps">Max agent steps</label><input id="setSteps" type="number" min="1" max="30" value="${Number(settings.maxAgentSteps || 12)}"></div>
          <div class="field"><label for="setContext">Context characters</label><input id="setContext" type="number" min="4000" max="400000" step="1000" value="${Number(settings.contextChars || 60000)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="setDaily">Daily token limit</label><input id="setDaily" type="number" min="0" value="${Number(settings.dailyTokenLimit || 0)}"><span class="hint">0 means unlimited.</span></div>
          <div class="field"><label for="setMonthly">Monthly token limit</label><input id="setMonthly" type="number" min="0" value="${Number(settings.monthlyTokenLimit || 0)}"><span class="hint">0 means unlimited.</span></div>
        </div>
        <label class="check-row"><input id="setAutoTitle" type="checkbox" ${settings.autoTitle ? "checked" : ""}> Generate a session title from the first message</label>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h5>SYSTEM PROMPT</h5></div>
        <div class="field"><textarea id="setSystemPrompt" rows="5">${escapeHtml(settings.systemPrompt || "")}</textarea><span class="hint">Applied to every session unless the session has its own prompt.</span></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h5>APPEARANCE</h5></div>
        <div class="field-row">
          <div class="field"><label for="setTheme">Theme</label><select id="setTheme"><option value="amoled" ${settings.theme === "amoled" ? "selected" : ""}>AMOLED black</option><option value="midnight" ${settings.theme === "midnight" ? "selected" : ""}>Midnight</option></select></div>
          <div class="field"><label for="setAccent">Accent</label><select id="setAccent"><option value="violet" ${settings.accent === "violet" ? "selected" : ""}>Violet</option><option value="blue" ${settings.accent === "blue" ? "selected" : ""}>Blue</option><option value="cyan" ${settings.accent === "cyan" ? "selected" : ""}>Cyan</option><option value="rose" ${settings.accent === "rose" ? "selected" : ""}>Rose</option></select></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h5>PROJECT INSTRUCTIONS</h5></div>
        <div class="provider-card" style="align-items:center"><div class="provider-logo">A</div><div class="provider-info" id="agentsStatus"><strong>AGENTS.md</strong><div class="provider-meta">Checking ${escapeHtml(projectName(activeProjectId()))}…</div></div></div>
      </div>
      <button class="btn primary" type="button" id="saveGeneral">Save settings</button>`
  }
  if (tab === "providers") {
    const ready = state.providers.filter(providerReady).length
    return `<h4>Providers</h4><p class="section-copy">${ready} of ${state.providers.length} providers are ready. Keys are encrypted on the server and never returned to this page.</p>
      <div class="settings-section">
        <div class="settings-section-head"><h5>PROVIDERS</h5><button class="btn small" type="button" id="addProvider"><svg class="icon"><use href="#i-plus"></use></svg>Add provider</button></div>
        ${state.providers.map(providerCardHtml).join("") || `<div class="empty-state">No providers configured.</div>`}
      </div>`
  }
  if (tab === "models") {
    const free = state.models.filter((model) => model.free).length
    return `<h4>Models</h4><p class="section-copy">${state.models.length} models from ${state.providers.length} providers · ${free} free.</p>
      <div class="search-box model-picker-search"><svg class="icon"><use href="#i-search"></use></svg><input id="modelSettingsSearch" type="search" placeholder="Filter models" autocomplete="off"></div>
      <div class="model-list" id="modelSettingsList">${modelRowsHtml(state.models)}</div>`
  }
  if (tab === "usage") {
    const today = state.usage.today || {}
    const month = state.usage.month || {}
    const rows = state.usage.byProvider || []
    return `<h4>Usage</h4><p class="section-copy">Token accounting is local to this device.</p>
      <div class="usage-grid">
        <div class="usage-card"><span>Today</span><strong>${formatTokens(Number(today.tokens_in || 0) + Number(today.tokens_out || 0))}</strong><small>${Number(today.requests || 0)} requests</small></div>
        <div class="usage-card"><span>This month</span><strong>${formatTokens(Number(month.tokens_in || 0) + Number(month.tokens_out || 0))}</strong><small>${Number(month.requests || 0)} requests</small></div>
      </div>
      <div class="settings-section"><div class="settings-section-head"><h5>BY PROVIDER</h5></div>
        ${rows.length ? `<table class="usage-table"><thead><tr><th>Provider</th><th>Requests</th><th>Input</th><th>Output</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.provider_name || row.provider || row.provider_id || "unknown")}</td><td>${Number(row.requests || 0)}</td><td>${formatTokens(row.tokens_in)}</td><td>${formatTokens(row.tokens_out)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty-state">No usage recorded yet.</div>`}
      </div>
      <button class="btn" type="button" id="refreshUsage">Refresh usage</button>`
  }
  if (tab === "plugins") {
    return `<h4>Plugins</h4><p class="section-copy">Local plugins can inspect chat context and react to responses. Files live in the ZYCRON data directory.</p>
      <div class="settings-section">${state.plugins.length ? state.plugins.map((plugin) => `<div class="plugin-row"><div class="plugin-info"><strong>${escapeHtml(plugin.name || plugin.id)}</strong><p>${escapeHtml(plugin.description || (plugin.hooks || []).join(", ") || "No description")}${plugin.error ? " · failed to load" : ""}</p></div><label class="switch"><input type="checkbox" data-plugin="${escapeHtml(plugin.id)}" ${plugin.enabled ? "checked" : ""} ${plugin.error ? "disabled" : ""}><span></span></label></div>`).join("") : `<div class="empty-state">No plugins installed.</div>`}</div>`
  }
  if (tab === "data") {
    const backup = state.backup
    return `<h4>Data</h4><p class="section-copy">Sessions, settings, provider keys, and backups stay in the local data directory.</p>
      <div class="settings-section">
        <div class="settings-section-head"><h5>WORKSPACE</h5></div>
        <div class="field"><label>Data directory</label><input value="${escapeHtml(state.app?.workspace || "")}" readonly></div>
        <div class="field"><label>Version</label><input value="${escapeHtml(state.app?.version || "")}" readonly></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h5>BACKUP</h5></div>
        <p class="section-copy">${backup ? `Last backup: ${escapeHtml(pathName(backup.file))} · ${formatBytes(backup.size)} · ${timeAgo(backup.modified)}` : "No backup has been created yet."}</p>
        <button class="btn" type="button" id="createBackup"><svg class="icon"><use href="#i-save"></use></svg>Create backup now</button>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h5>DANGER ZONE</h5></div>
        <button class="btn danger" type="button" id="deleteAllSettings">Delete all sessions</button>
      </div>`
  }
  return ""
}

function providerCardHtml(provider) {
  const ready = providerReady(provider)
  return `<div class="provider-card ${provider.enabled ? "" : "disabled"}">
    <div class="provider-logo">${escapeHtml((provider.name || "?").slice(0, 2).toUpperCase())}</div>
    <div class="provider-info">
      <strong>${escapeHtml(provider.name)}</strong>
      <div class="provider-meta"><span>${escapeHtml(provider.baseUrl)}</span><span>·</span><span>${provider.modelCount} models</span><span class="badge ${provider.free ? "free" : "paid"}">${provider.free ? "FREE" : "PAID"}</span><span class="badge ${ready ? "free" : "key"}">${provider.keyless ? "KEYLESS" : provider.hasKey ? "KEY SET" : "NO KEY"}</span></div>
    </div>
    <div class="provider-actions">
      <button class="icon-btn" type="button" data-provider-edit="${escapeHtml(provider.id)}" title="Edit"><svg class="icon"><use href="#i-edit"></use></svg></button>
      <button class="icon-btn" type="button" data-provider-models="${escapeHtml(provider.id)}" title="Fetch models"><svg class="icon"><use href="#i-refresh"></use></svg></button>
      <button class="icon-btn" type="button" data-provider-toggle="${escapeHtml(provider.id)}" title="${provider.enabled ? "Disable" : "Enable"}"><svg class="icon"><use href="#i-${provider.enabled ? "check" : "play"}"></use></svg></button>
      <button class="icon-btn" type="button" data-provider-delete="${escapeHtml(provider.id)}" title="Delete"><svg class="icon"><use href="#i-trash"></use></svg></button>
    </div>
  </div>`
}

function modelRowsHtml(models) {
  if (!models.length) return `<div class="empty-state">No models match.</div>`
  return models.map((model) => `<div class="model-row">
    <span class="model-name">${escapeHtml(model.label)}<span class="model-provider"> · ${escapeHtml(model.provider)}</span></span>
    <span class="model-badges">${model.free ? '<span class="badge free">FREE</span>' : '<span class="badge paid">PAID</span>'}<span class="badge">${formatTokens(model.context)} ctx</span>${model.tools ? '<span class="badge">tools</span>' : ""}${model.vision ? '<span class="badge">vision</span>' : ""}</span>
    <button class="use-model" type="button" data-use-model="${escapeHtml(model.id)}">use</button>
  </div>`).join("")
}

function bindModelFilter(root) {
  const input = $("#modelSettingsSearch", root)
  if (!input) return
  const update = () => {
    const query = input.value.trim().toLowerCase()
    const filtered = state.models.filter((model) => !query || `${model.label} ${model.model} ${model.provider}`.toLowerCase().includes(query))
    const list = $("#modelSettingsList", root)
    if (list) list.innerHTML = modelRowsHtml(filtered)
  }
  input.addEventListener("input", update)
}

function bindSettingsTab(root, tab, renderTab) {
  if (tab === "general") {
    $("#saveGeneral", root)?.addEventListener("click", async (event) => {
      const button = event.currentTarget
      button.disabled = true
      try {
        const patch = {
          routing: $("#setRouting", root).value,
          temperature: Number($("#setTemperature", root).value),
          maxAgentSteps: Number($("#setSteps", root).value),
          contextChars: Number($("#setContext", root).value),
          dailyTokenLimit: Number($("#setDaily", root).value),
          monthlyTokenLimit: Number($("#setMonthly", root).value),
          autoTitle: $("#setAutoTitle", root).checked,
          systemPrompt: $("#setSystemPrompt", root).value,
          theme: $("#setTheme", root).value,
          accent: $("#setAccent", root).value
        }
        const data = await api("/api/settings", { method: "PATCH", body: patch })
        state.settings = data.settings
        applyTheme()
        toast("Settings saved.", "ok")
        renderChrome()
      } catch (error) {
        toast(error.message, "err")
      } finally {
        button.disabled = false
      }
    })
  }
  if (tab === "providers") {
    $("#addProvider", root)?.addEventListener("click", () => openProviderEditor(null, renderTab))
    root.addEventListener("click", async (event) => {
      const edit = event.target.closest("[data-provider-edit]")
      if (edit) return openProviderEditor(providerById(edit.dataset.providerEdit), renderTab)
      const toggle = event.target.closest("[data-provider-toggle]")
      if (toggle) {
        const provider = providerById(toggle.dataset.providerToggle)
        if (!provider) return
        try {
          await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", body: { enabled: !provider.enabled } })
          await refreshProviders()
          toast(`${provider.name} ${provider.enabled ? "disabled" : "enabled"}.`, "ok")
          renderTab()
        } catch (error) {
          toast(error.message, "err")
        }
        return
      }
      const models = event.target.closest("[data-provider-models]")
      if (models) {
        const id = models.dataset.providerModels
        models.disabled = true
        try {
          const data = await api(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST", body: {} })
          await refreshProviders()
          await refreshModelList()
          toast(`Loaded ${data.models?.length || 0} models.`, "ok")
          renderTab()
        } catch (error) {
          toast(error.message, "err")
        } finally {
          models.disabled = false
        }
        return
      }
      const remove = event.target.closest("[data-provider-delete]")
      if (remove) {
        const id = remove.dataset.providerDelete
        const provider = providerById(id)
        if (!provider) return
        const ok = await confirmDialog({ title: "Delete provider", message: `Delete ${provider.name} and its ${provider.modelCount} models? Existing sessions fall back to auto.`, confirmText: "Delete", danger: true })
        if (!ok) return
        try {
          await api(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" })
          await refreshProviders()
          await refreshModelList()
          toast("Provider deleted.", "ok")
          renderTab()
        } catch (error) {
          toast(error.message, "err")
        }
      }
    })
  }
  if (tab === "models") {
    root.addEventListener("click", (event) => {
      const use = event.target.closest("[data-use-model]")
      if (!use) return
      const model = state.models.find((item) => item.id === use.dataset.useModel)
      if (!model) return
      setModel(model.providerId, model.model)
    })
  }
  if (tab === "usage") {
    $("#refreshUsage", root)?.addEventListener("click", async () => {
      try {
        const data = await api("/api/usage")
        state.usage = data
        renderTab()
      } catch (error) {
        toast(error.message, "err")
      }
    })
  }
  if (tab === "plugins") {
    root.addEventListener("change", async (event) => {
      const input = event.target.closest("[data-plugin]")
      if (!input) return
      try {
        await api(`/api/plugins/${encodeURIComponent(input.dataset.plugin)}`, { method: "PATCH", body: { enabled: input.checked } })
        const plugin = state.plugins.find((item) => item.id === input.dataset.plugin)
        if (plugin) plugin.enabled = input.checked
        toast(`Plugin ${input.checked ? "enabled" : "disabled"}.`, "ok")
      } catch (error) {
        input.checked = !input.checked
        toast(error.message, "err")
      }
    })
  }
  if (tab === "data") {
    $("#createBackup", root)?.addEventListener("click", async (event) => {
      const button = event.currentTarget
      button.disabled = true
      try {
        const data = await api("/api/backup", { method: "POST", body: {} })
        state.backup = { file: data.backup.file, size: data.backup.size, modified: data.backup.createdAt }
        toast("Backup created.", "ok")
        renderTab()
      } catch (error) {
        toast(error.message, "err")
      } finally {
        button.disabled = false
      }
    })
    $("#deleteAllSettings", root)?.addEventListener("click", () => deleteAllSessions())
  }
}

async function renderAgentsStatus(root) {
  const host = $("#agentsStatus", root)
  if (!host) return
  const projectId = activeProjectId()
  if (!projectId) {
    host.innerHTML = `<strong>No project selected</strong><div class="provider-meta">Open a project to use AGENTS.md.</div>`
    return
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/instructions`)
    if (!host.isConnected) return
    if (data.instructions) {
      host.innerHTML = `<strong>AGENTS.md loaded</strong><div class="provider-meta">${escapeHtml(projectName(projectId))} · ${data.instructions.chars} characters${data.instructions.truncated ? " · truncated" : ""}<br>This file is added to the system prompt for every model step.</div><div style="margin-top:6px"><button class="btn small" type="button" data-view-agents>View file</button></div>`
    } else {
      host.innerHTML = `<strong>No AGENTS.md yet</strong><div class="provider-meta">${escapeHtml(projectName(projectId))} · Add project instructions that the agent will follow automatically.</div><div style="margin-top:6px"><button class="btn small primary" type="button" data-create-agents>Create AGENTS.md</button></div>`
    }
  } catch (error) {
    host.innerHTML = `<strong>AGENTS.md</strong><div class="provider-meta">${escapeHtml(error.message)}</div>`
  }
}

async function createAgentsFile(projectId, after = null) {
  if (!projectId) {
    toast("Select a project first.", "err")
    return
  }
  const content = `# Project Instructions\n\nThese instructions are loaded into ZYCRON AI's system prompt for this project.\n\n## Conventions\n\n- Keep changes focused and review existing files before editing.\n- Run the project's tests before reporting work complete.\n\n## Notes\n\n- Add project-specific commands, architecture, and constraints here.\n`
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/file`, { method: "PUT", body: { path: "AGENTS.md", content } })
    toast("AGENTS.md created.", "ok")
    after?.()
    openWorkspace(projectId, { path: "AGENTS.md" })
  } catch (error) {
    toast(error.message, "err")
  }
}

function openProviderEditor(provider, after = null) {
  const editing = Boolean(provider)
  const body = `<div class="field"><label for="providerName">Name</label><input id="providerName" value="${escapeHtml(provider?.name || "")}" placeholder="My provider"></div>
    <div class="field-row">
      <div class="field"><label for="providerKind">API type</label><select id="providerKind"><option value="openai" ${!provider || provider.kind === "openai" ? "selected" : ""}>OpenAI compatible</option><option value="anthropic" ${provider?.kind === "anthropic" ? "selected" : ""}>Anthropic</option><option value="ollama" ${provider?.kind === "ollama" ? "selected" : ""}>Ollama</option></select></div>
      <div class="field"><label for="providerBase">Base URL</label><input id="providerBase" value="${escapeHtml(provider?.baseUrl || "")}" placeholder="https://api.example.com/v1"></div>
    </div>
    <div class="field"><label for="providerKey">API key ${provider?.hasKey ? `<span style="color:var(--green)">· ${escapeHtml(provider.keyHint || "set")}</span>` : ""}</label><input id="providerKey" type="password" placeholder="${provider?.hasKey ? "Leave blank to keep the current key" : "sk-..."}" autocomplete="new-password"><span class="hint">Keys are encrypted on the server and never sent back to the browser.</span></div>
    ${provider?.hasKey ? `<label class="check-row"><input id="providerClearKey" type="checkbox"> Remove the saved API key</label>` : ""}
    <label class="check-row"><input id="providerFree" type="checkbox" ${!provider || provider.free ? "checked" : ""}> Provider serves free models</label>
    <label class="check-row"><input id="providerEnabled" type="checkbox" ${!provider || provider.enabled ? "checked" : ""}> Enable this provider</label>
    <div class="field" style="margin-top:12px"><label for="providerDocs">Docs URL</label><input id="providerDocs" value="${escapeHtml(provider?.docs || "")}" placeholder="https://..."></div>`
  const dialog = openModal({
    title: editing ? "Edit provider" : "Add provider",
    body,
    foot: `<button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-save>${editing ? "Save changes" : "Add provider"}</button>`
  })
  $("[data-cancel]", dialog.overlay).addEventListener("click", dialog.close)
  $("[data-save]", dialog.overlay).addEventListener("click", async (event) => {
    const button = event.currentTarget
    const payload = {
      name: $("#providerName", dialog.overlay).value.trim(),
      kind: $("#providerKind", dialog.overlay).value,
      baseUrl: $("#providerBase", dialog.overlay).value.trim(),
      free: $("#providerFree", dialog.overlay).checked,
      enabled: $("#providerEnabled", dialog.overlay).checked,
      docs: $("#providerDocs", dialog.overlay).value.trim()
    }
    const key = $("#providerKey", dialog.overlay).value.trim()
    if (key) payload.apiKey = key
    if ($("#providerClearKey", dialog.overlay)?.checked) payload.clearKey = true
    if (!payload.name || !payload.baseUrl) {
      toast("Name and base URL are required.", "err")
      return
    }
    button.disabled = true
    try {
      if (editing) await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", body: payload })
      else await api("/api/providers", { method: "POST", body: payload })
      await refreshProviders()
      await refreshModelList()
      dialog.close()
      toast(editing ? "Provider updated." : "Provider added.", "ok")
      after?.()
    } catch (error) {
      toast(error.message, "err")
    } finally {
      button.disabled = false
    }
  })
}

async function refreshProviders() {
  const data = await api("/api/providers")
  state.providers = data.providers || []
}

async function refreshModelList() {
  const data = await api("/api/models")
  state.models = data.models || []
  renderChrome()
}

function pathName(file) {
  return String(file || "").split(/[\\/]/).pop() || ""
}

function formatBytes(value) {
  const number = Number(value || 0)
  if (number >= 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)} MB`
  if (number >= 1024) return `${(number / 1024).toFixed(1)} KB`
  return `${number} B`
}

function workspaceTab() {
  const ws = state.ws
  if (!ws) return null
  return ws.tabs.find((tab) => tab.path === ws.activePath) || null
}

function renderWorkspaceProjects() {
  const ws = state.ws
  if (!ws?.dom?.projects) return
  ws.dom.projects.innerHTML = state.projects.length
    ? state.projects.map((project) => `<button type="button" class="project-item ${project.id === ws.projectId ? "active" : ""}" data-ws-project="${escapeHtml(project.id)}" title="${escapeHtml(project.path)}"><svg class="icon"><use href="#i-folder"></use></svg><span>${escapeHtml(project.name)}</span></button>`).join("")
    : `<div class="empty-state"><strong>No projects</strong>Create one to start editing files.</div>`
  ws.dom.title.textContent = ws.project?.name || "Workspace"
}

function workspaceTreeHtml(nodes, active, expanded) {
  return nodes.map((node) => {
    const isDir = node.type === "dir"
    const open = isDir && expanded.has(node.path)
    const icon = isDir ? (open ? "i-chevron-down" : "i-chevron-right") : "i-file"
    return `<div class="tree-node"><button type="button" class="tree-item ${isDir ? "dir" : ""} ${active === node.path ? "active" : ""}" data-ws-path="${escapeHtml(node.path)}" data-ws-dir="${isDir ? "1" : "0"}" title="${escapeHtml(node.path)}"><svg class="icon"><use href="#${icon}"></use></svg><span>${escapeHtml(node.name)}</span></button>${isDir && open && node.children?.length ? `<div class="tree-children">${workspaceTreeHtml(node.children, active, expanded)}</div>` : ""}</div>`
  }).join("")
}

function renderWorkspaceTree() {
  const ws = state.ws
  if (!ws?.dom?.tree) return
  ws.dom.tree.innerHTML = ws.tree.length
    ? workspaceTreeHtml(ws.tree, ws.activePath, ws.expanded)
    : `<div class="empty-state"><strong>Empty project</strong>Create a file to get started.</div>`
}

function renderWorkspaceTabs() {
  const ws = state.ws
  if (!ws?.dom?.tabs) return
  ws.dom.tabs.innerHTML = ws.tabs.map((tab) => `<button type="button" class="tab ${tab.path === ws.activePath ? "active" : ""}" data-ws-tab="${escapeHtml(tab.path)}"><span>${escapeHtml(tab.name)}</span>${tab.dirty ? '<span class="dirty"></span>' : ""}<svg class="icon" data-ws-tab-close="${escapeHtml(tab.path)}"><use href="#i-close"></use></svg></button>`).join("")
}

function workspaceEditorView() {
  const ws = state.ws
  const tab = workspaceTab()
  const dom = ws?.dom
  if (!dom?.editor) return
  if (!tab) {
    dom.toolbar.classList.add("hidden")
    dom.wrap.classList.add("hidden")
    dom.empty.classList.remove("hidden")
    dom.gutter.textContent = "1"
    dom.highlight.innerHTML = ""
    dom.editor.value = ""
    return
  }
  dom.empty.classList.add("hidden")
  dom.toolbar.classList.remove("hidden")
  dom.wrap.classList.remove("hidden")
  const lines = tab.content.split("\n").length
  dom.gutter.textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n")
  dom.highlight.innerHTML = highlightCode(tab.content, tab.language)
  dom.toolbar.innerHTML = `<span>${escapeHtml(tab.path)}</span><span class="spacer"></span><span>${escapeHtml(tab.language || "text")}</span><span>${formatBytes(tab.content.length)}${tab.dirty ? " · unsaved" : ""}</span><button class="mini-btn" type="button" data-ws-act="save" ${tab.dirty ? "" : "disabled"}>Save</button>`
  if (dom.editor.value !== tab.content) dom.editor.value = tab.content
  dom.editor.style.height = `${Math.max(dom.editor.scrollHeight, dom.wrap.clientHeight || 0)}px`
  dom.gutter.scrollTop = dom.code.scrollTop
}

function renderWorkspaceSearch(results) {
  const ws = state.ws
  const host = ws?.dom?.results
  if (!host) return
  if (!results) {
    host.classList.add("hidden")
    host.innerHTML = ""
    return
  }
  host.classList.remove("hidden")
  host.innerHTML = results.length
    ? results.map((item) => `<button type="button" class="search-result" data-ws-result="${escapeHtml(item.path)}" data-ws-line="${item.line}"><code>${escapeHtml(item.path)}:${item.line}</code><span>${escapeHtml(item.text)}</span></button>`).join("")
    : `<div class="empty-state">No matches.</div>`
}

async function refreshWorkspaceTree() {
  const ws = state.ws
  if (!ws?.dialog?.overlay?.isConnected) return
  try {
    const data = await api(`/api/projects/${encodeURIComponent(ws.projectId)}/tree`)
    ws.tree = data.tree || []
    ws.project = data.project || ws.project
    renderWorkspaceProjects()
    renderWorkspaceTree()
  } catch (error) {
    toast(error.message, "err")
  }
}

async function loadWorkspaceFile(path) {
  const ws = state.ws
  if (!ws || !path) return
  let tab = ws.tabs.find((item) => item.path === path)
  if (!tab) {
    try {
      const data = await api(`/api/projects/${encodeURIComponent(ws.projectId)}/file?path=${encodeURIComponent(path)}`)
      const file = data.file
      if (file.binary) {
        toast("Binary files cannot be edited.", "err")
        return
      }
      tab = { path: file.path, name: file.name, language: file.language, size: file.size, content: file.content, saved: file.content, dirty: false }
      ws.tabs.push(tab)
    } catch (error) {
      toast(error.message, "err")
      return
    }
  }
  ws.activePath = tab.path
  renderWorkspaceTabs()
  renderWorkspaceTree()
  workspaceEditorView()
  renderWorkspaceSearch(null)
  ws.dom.editor.focus()
}

async function saveWorkspaceFile() {
  const ws = state.ws
  const tab = workspaceTab()
  if (!ws || !tab) return
  if (!tab.dirty || tab.saving) return
  tab.saving = true
  try {
    await api(`/api/projects/${encodeURIComponent(ws.projectId)}/file`, { method: "PUT", body: { path: tab.path, content: tab.content } })
    tab.saved = tab.content
    tab.dirty = false
    renderWorkspaceTabs()
    workspaceEditorView()
    toast(`Saved ${tab.name}`, "ok")
  } catch (error) {
    toast(error.message, "err")
  } finally {
    tab.saving = false
  }
}

async function closeWorkspaceTab(path) {
  const ws = state.ws
  if (!ws) return
  const index = ws.tabs.findIndex((tab) => tab.path === path)
  if (index < 0) return
  const tab = ws.tabs[index]
  if (tab.dirty) {
    const approved = await confirmDialog({ title: "Discard changes?", message: `${tab.name} has unsaved changes.`, confirmText: "Discard", danger: true })
    if (!approved) return
  }
  ws.tabs.splice(index, 1)
  if (ws.activePath === path) {
    const next = ws.tabs[index] || ws.tabs[index - 1] || null
    ws.activePath = next?.path || ""
  }
  renderWorkspaceTabs()
  renderWorkspaceTree()
  workspaceEditorView()
}

async function runWorkspaceCommand(command) {
  const ws = state.ws
  if (!ws || !command.trim()) return
  const term = ws.dom.terminal
  ws.terminal += `\n$ ${command}\n`
  term.textContent = ws.terminal
  term.scrollTop = term.scrollHeight
  try {
    const data = await api(`/api/projects/${encodeURIComponent(ws.projectId)}/run`, { method: "POST", body: { command } })
    const result = data.result || {}
    ws.terminal += `${result.stdout || ""}${result.stderr || ""}${result.timedOut ? "\n[timed out]\n" : ""}\n[exit ${result.code ?? "?"}]\n`
  } catch (error) {
    ws.terminal += `[error] ${error.message}\n`
  }
  term.textContent = ws.terminal
  term.scrollTop = term.scrollHeight
}

async function searchWorkspace(query) {
  const ws = state.ws
  if (!ws) return
  if (!query.trim()) {
    renderWorkspaceSearch(null)
    return
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(ws.projectId)}/search?q=${encodeURIComponent(query)}`)
    renderWorkspaceSearch(data.results || [])
  } catch (error) {
    toast(error.message, "err")
  }
}

async function newWorkspaceFile() {
  const ws = state.ws
  if (!ws) return
  const path = await textPrompt({ title: "New file", label: "Relative path (for example src/index.js)", value: "" })
  if (!path) return
  const clean = path.trim().replace(/^\/+/, "")
  if (!clean) return
  try {
    await api(`/api/projects/${encodeURIComponent(ws.projectId)}/file`, { method: "PUT", body: { path: clean, content: "" } })
    await refreshWorkspaceTree()
    await loadWorkspaceFile(clean)
  } catch (error) {
    toast(error.message, "err")
  }
}

async function openWorkspace(projectId = activeProjectId(), { path = "" } = {}) {
  try {
    await refreshProjects()
  } catch {}
  const project = projectById(projectId) || state.projects[0]
  if (!project) {
    toast("Create a project first.", "err")
    return
  }
  if (state.ws?.dialog?.overlay?.isConnected && state.ws.projectId === project.id) {
    if (path) await loadWorkspaceFile(path)
    return
  }
  state.ws = {
    projectId: project.id,
    project,
    tree: [],
    expanded: new Set(),
    tabs: [],
    activePath: "",
    terminal: "",
    dialog: null,
    dom: {}
  }
  const ws = state.ws
  const body = `<div class="workspace">
    <aside class="workspace-side">
      <div class="workspace-side-head"><span>PROJECTS</span><button class="icon-btn" type="button" data-ws-new-project title="New project"><svg class="icon"><use href="#i-plus"></use></svg></button></div>
      <div class="project-list" data-ws-projects></div>
    </aside>
    <div class="workspace-main">
      <div class="workspace-top">
        <span class="workspace-title"><svg class="icon"><use href="#i-folder-open"></use></svg><span data-ws-title>${escapeHtml(project.name)}</span></span>
        <button class="mini-btn" type="button" data-ws-act="new-file">+ File</button>
        <button class="mini-btn" type="button" data-ws-act="search">Search</button>
        <button class="mini-btn" type="button" data-ws-act="refresh">Refresh</button>
        <button class="mini-btn" type="button" data-ws-act="terminal">Terminal</button>
      </div>
      <div class="workspace-body">
        <div class="explorer" data-ws-tree></div>
        <div class="editor-area">
          <div class="search-panel hidden" data-ws-search-panel><input type="search" placeholder="Search in project..." data-ws-search><button class="icon-btn" type="button" data-ws-search-close title="Close"><svg class="icon"><use href="#i-close"></use></svg></button></div>
          <div class="tabs" data-ws-tabs></div>
          <div class="editor-host">
            <div class="editor-empty" data-ws-empty><div><svg class="icon"><use href="#i-code"></use></svg><div>Select a file from the explorer<br>or create a new one.</div></div></div>
            <div class="editor-toolbar" data-ws-toolbar></div>
            <div class="editor-wrap" data-ws-wrap>
              <div class="editor-gutter" data-ws-gutter>1</div>
              <div class="editor-code" data-ws-code>
                <pre data-ws-highlight></pre>
                <textarea data-ws-editor spellcheck="false" wrap="off" aria-label="File editor"></textarea>
              </div>
            </div>
            <div class="search-results hidden" data-ws-results></div>
            <div class="terminal-panel hidden" data-ws-terminal>
              <div class="terminal-head"><svg class="icon"><use href="#i-terminal"></use></svg><span>TERMINAL</span><button class="icon-btn" type="button" data-ws-term-close title="Close terminal"><svg class="icon"><use href="#i-close"></use></svg></button></div>
              <div class="terminal-output" data-ws-term-out></div>
              <form class="search-panel" data-ws-term-form><input type="text" placeholder="Run a command in the project..." data-ws-term-input autocomplete="off"><button class="mini-btn" type="submit">Run</button></form>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`
  const dialog = openModal({ title: "Workspace", subtitle: project.name, size: "full", body })
  ws.dialog = dialog
  dialog.body.classList.add("flush")
  dialog.body.style.cssText = "padding:0;overflow:hidden;display:flex;flex:1;min-height:0"
  const root = dialog.overlay
  ws.dom = {
    projects: $("[data-ws-projects]", root),
    title: $("[data-ws-title]", root),
    tree: $("[data-ws-tree]", root),
    tabs: $("[data-ws-tabs]", root),
    toolbar: $("[data-ws-toolbar]", root),
    wrap: $("[data-ws-wrap]", root),
    empty: $("[data-ws-empty]", root),
    editor: $("[data-ws-editor]", root),
    gutter: $("[data-ws-gutter]", root),
    code: $("[data-ws-code]", root),
    highlight: $("[data-ws-highlight]", root),
    results: $("[data-ws-results]", root),
    searchPanel: $("[data-ws-search-panel]", root),
    search: $("[data-ws-search]", root),
    terminal: $("[data-ws-terminal]", root),
    terminalOut: $("[data-ws-term-out]", root),
    terminalForm: $("[data-ws-term-form]", root)
  }
  ws.dom.terminalOut.textContent = ws.terminal
  renderWorkspaceProjects()
  ws.dom.projects.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-ws-project]")
    if (!button || button.dataset.wsProject === ws.projectId) return
    const id = button.dataset.wsProject
    dialog.close()
    await setProject(id).catch(() => {})
    openWorkspace(id)
  })
  $("[data-ws-new-project]", root).addEventListener("click", async () => {
    const name = await textPrompt({ title: "New project", label: "Project name", value: "" })
    if (!name) return
    try {
      const data = await api("/api/projects", { method: "POST", body: { name } })
      await refreshProjects()
      dialog.close()
      openWorkspace(data.project.id)
    } catch (error) {
      toast(error.message, "err")
    }
  })
  ws.dom.tree.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ws-path]")
    if (!button) return
    const path = button.dataset.wsPath
    if (button.dataset.wsDir === "1") {
      if (ws.expanded.has(path)) ws.expanded.delete(path)
      else ws.expanded.add(path)
      renderWorkspaceTree()
      return
    }
    loadWorkspaceFile(path)
  })
  ws.dom.tabs.addEventListener("click", (event) => {
    const close = event.target.closest("[data-ws-tab-close]")
    if (close) {
      closeWorkspaceTab(close.dataset.wsTabClose)
      return
    }
    const tab = event.target.closest("[data-ws-tab]")
    if (tab) loadWorkspaceFile(tab.dataset.wsTab)
  })
  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-ws-act]")?.dataset.wsAct
    if (act === "save") return saveWorkspaceFile()
    if (act === "new-file") return newWorkspaceFile()
    if (act === "refresh") return refreshWorkspaceTree()
    if (act === "terminal") {
      ws.dom.terminal.classList.toggle("hidden")
      if (!ws.dom.terminal.classList.contains("hidden")) $("[data-ws-term-input]", root)?.focus()
      return
    }
    if (act === "search") {
      ws.dom.searchPanel.classList.toggle("hidden")
      if (!ws.dom.searchPanel.classList.contains("hidden")) ws.dom.search.focus()
      return
    }
    const result = event.target.closest("[data-ws-result]")
    if (result) {
      loadWorkspaceFile(result.dataset.wsResult).then(() => {
        const line = Number(result.dataset.wsLine || 0)
        if (line > 0) {
          const textarea = ws.dom.editor
          const offset = ws.dom.editor.value.split("\n").slice(0, line - 1).join("\n").length
          textarea.focus()
          textarea.setSelectionRange(offset, offset)
          textarea.scrollTop = Math.max(0, (line - 4) * 18)
        }
      })
    }
  })
  $("[data-ws-search-close]", root).addEventListener("click", () => {
    ws.dom.searchPanel.classList.add("hidden")
    renderWorkspaceSearch(null)
  })
  ws.dom.search.addEventListener("input", debounce((event) => searchWorkspace(event.target.value), 260))
  $("[data-ws-term-close]", root).addEventListener("click", () => ws.dom.terminal.classList.add("hidden"))
  ws.dom.terminalForm.addEventListener("submit", (event) => {
    event.preventDefault()
    const input = $("[data-ws-term-input]", root)
    const command = input.value
    input.value = ""
    runWorkspaceCommand(command)
  })
  ws.dom.editor.addEventListener("input", () => {
    const tab = workspaceTab()
    if (!tab) return
    tab.content = ws.dom.editor.value
    tab.dirty = tab.content !== tab.saved
    renderWorkspaceTabs()
    workspaceEditorView()
  })
  ws.dom.editor.addEventListener("scroll", () => {
    ws.dom.gutter.scrollTop = ws.dom.code.scrollTop
  })
  ws.dom.code.addEventListener("scroll", () => {
    ws.dom.gutter.scrollTop = ws.dom.code.scrollTop
  })
  ws.dom.editor.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault()
      const start = ws.dom.editor.selectionStart
      ws.dom.editor.setRangeText("  ", start, ws.dom.editor.selectionEnd, "end")
      ws.dom.editor.dispatchEvent(new Event("input"))
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      saveWorkspaceFile()
    }
  })
  renderWorkspaceTabs()
  workspaceEditorView()
  await refreshWorkspaceTree()
  if (path) await loadWorkspaceFile(path)
}

function approvalInfo(kind, payload) {
  if (kind === "run_command") {
    return { icon: "i-terminal", title: "Run command", sub: "Shell command inside the project", preview: `$ ${payload.command || ""}`, warning: "Commands run with your Termux user permissions." }
  }
  if (kind === "write_file") {
    return { icon: "i-edit", title: "Write file", sub: `${payload.path || ""} · ${formatBytes(payload.bytes || 0)}`, preview: payload.preview || "", warning: "This overwrites the current file content." }
  }
  if (kind === "edit_file") {
    return { icon: "i-edit", title: "Edit file", sub: payload.path || "", preview: `--- current\n${payload.oldString || ""}\n\n+++ replacement\n${payload.newString || ""}`, warning: "Only the first unique match is replaced." }
  }
  if (kind === "delete_file") {
    return { icon: "i-trash", title: "Delete path", sub: payload.path || "", preview: payload.path || "", warning: "This removes the file or folder from disk." }
  }
  if (kind === "rename_file") {
    return { icon: "i-refresh", title: "Rename path", sub: `${payload.from || ""} → ${payload.to || ""}`, preview: `${payload.from || ""}\n→ ${payload.to || ""}`, warning: "" }
  }
  if (kind === "create_project") {
    return { icon: "i-folder", title: "Create project", sub: payload.name || "", preview: payload.name || "", warning: "" }
  }
  return { icon: "i-lock", title: kind || "Approval", sub: "", preview: JSON.stringify(payload, null, 2), warning: "" }
}

function openApproval(data) {
  if (!data?.id) return
  if (state.modals.some((item) => item.overlay.dataset.approvalId === data.id)) return
  const info = approvalInfo(data.kind, data.payload || {})
  let settled = false
  const dialog = openModal({
    title: "Approval required",
    subtitle: "agent paused",
    size: "narrow",
    body: `<div class="approval-kind"><div class="approval-icon"><svg class="icon"><use href="#${info.icon}"></use></svg></div><div><strong>${escapeHtml(info.title)}</strong><span>${escapeHtml(info.sub)}</span></div></div><pre class="approval-preview">${escapeHtml(info.preview)}</pre>${info.warning ? `<div class="approval-warning">${escapeHtml(info.warning)} ZYCRON AI stays paused until you decide.</div>` : ""}<div class="approval-actions"><button class="btn danger" type="button" data-approve="0">Deny</button><button class="btn primary" type="button" data-approve="1">Approve</button></div>`,
    onClose: () => {
      if (!settled) resolveApproval(data.id, false).catch(() => {})
    }
  })
  dialog.overlay.dataset.approvalId = data.id
  const finish = async (approve) => {
    if (settled) return
    settled = true
    $$("[data-approve]", dialog.overlay).forEach((button) => { button.disabled = true })
    try {
      await resolveApproval(data.id, approve)
      toast(approve ? "Approved." : "Denied.", approve ? "ok" : "")
    } catch (error) {
      toast(error.message, "err")
    } finally {
      dialog.close()
    }
  }
  $$("[data-approve]", dialog.overlay).forEach((button) => {
    button.addEventListener("click", () => finish(button.dataset.approve === "1"))
  })
  setTimeout(() => $("[data-approve='1']", dialog.overlay)?.focus(), 50)
}

async function resolveApproval(id, approve) {
  return api(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: { approve } })
}

async function checkPendingApprovals() {
  try {
    const data = await api("/api/approvals")
    for (const item of (data.approvals || []).slice().reverse()) openApproval(item)
  } catch {}
}

init()



