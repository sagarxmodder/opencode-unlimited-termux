import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ALT_OFF, ALT_ON, CURSOR_HIDE, CURSOR_SHOW, PASTE_OFF, PASTE_ON, RESET, WRAP_OFF, WRAP_ON, copyToClipboard } from "./ansi.js"
import { KeyParser } from "./keys.js"
import { resolveDataDir } from "./local.js"
import { modeLabel, renderScreen } from "./render.js"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const MODES = ["build", "plan", "debug", "review"]

export class Tui {
  constructor({ stdin = process.stdin, stdout = process.stdout, ensure, api = null, onExit } = {}) {
    this.stdin = stdin
    this.stdout = stdout
    this.ensure = ensure
    this.api = api
    this.onExit = onExit
    this.closed = false
    this.fatal = false
    this.dirty = true
    this.parser = new KeyParser()
    this.escTimer = null
    this.timer = null
    this.spinnerTimer = null
    this.lastOutput = ""
    this.controller = null
    this.history = []
    this.historyIndex = -1
    this.draft = ""
    this.leaderUntil = 0
    this.state = {
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      boot: { message: "Starting ZYCRON" },
      appInfo: {},
      workspace: "",
      sessions: [],
      projects: [],
      providers: [],
      allModels: [],
      conversation: null,
      messages: [],
      composer: "",
      cursor: 0,
      scroll: 0,
      modal: null,
      toast: null,
      busy: false,
      streaming: false,
      streamingText: "",
      thinking: "",
      taskLabel: "Thinking",
      spinner: SPINNER[0],
      frame: 0,
      step: 0,
      requestId: "",
      model: "auto",
      mode: "build",
      tokens: 0,
      context: 128000,
      usage: null,
      sidebar: true
    }
  }

  async start() {
    this.enter()
    this.attachInput()
    this.loop()
    await this.boot()
  }

  async boot() {
    this.state.boot = { message: "Starting ZYCRON" }
    this.dirty = true
    try {
      if (!this.api) {
        if (!this.ensure) throw new Error("no server connection configured")
        this.api = await this.ensure({
          onLog: (line) => {
            this.state.boot = { message: line }
            this.dirty = true
          }
        })
      }
      await this.load()
      this.state.boot = null
      this.fatal = false
    } catch (error) {
      this.state.boot = { message: "ZYCRON could not start", error: String(error?.message || error) }
      this.fatal = true
    }
    this.dirty = true
  }

  enter() {
    this.stdout.write(ALT_ON + WRAP_OFF + PASTE_ON + CURSOR_HIDE + "\x1b[2J")
    if (this.stdin.setRawMode) this.stdin.setRawMode(true)
    this.stdin.setEncoding("utf8")
    this.stdin.resume()
  }

  leave() {
    try {
      if (this.stdin.setRawMode) this.stdin.setRawMode(false)
    } catch {}
    this.stdout.write(RESET + CURSOR_SHOW + PASTE_OFF + WRAP_ON + ALT_OFF)
  }

  attachInput() {
    this.onData = (chunk) => {
      for (const key of this.parser.feed(chunk)) this.onKey(key)
      this.armEscape()
    }
    this.onResize = () => {
      this.state.cols = Math.max(20, this.stdout.columns || 80)
      this.state.rows = Math.max(8, this.stdout.rows || 24)
      this.dirty = true
    }
    this.stdin.on("data", this.onData)
    this.stdout.on("resize", this.onResize)
  }

  armEscape() {
    if (this.escTimer) clearTimeout(this.escTimer)
    if (this.parser.pending !== "\x1b") return
    this.escTimer = setTimeout(() => {
      this.escTimer = null
      for (const key of this.parser.flush()) this.onKey(key)
    }, 30)
  }

  loop() {
    if (this.closed) return
    if (this.dirty) this.draw()
    this.timer = setTimeout(() => this.loop(), 40)
  }

  draw() {
    this.dirty = false
    const frame = renderScreen(this.state)
    let output = CURSOR_HIDE + "\x1b[H" + frame.text
    if (frame.cursor) output += `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H` + CURSOR_SHOW
    else output += CURSOR_HIDE
    if (output === this.lastOutput) return
    this.lastOutput = output
    this.stdout.write(output)
  }

  shutdown() {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.escTimer) clearTimeout(this.escTimer)
    this.stopSpinner()
    if (this.controller) {
      try {
        this.controller.abort()
      } catch {}
    }
    try {
      this.stdin.off("data", this.onData)
      this.stdout.off("resize", this.onResize)
    } catch {}
    this.leave()
  }

  quit() {
    this.shutdown()
    if (this.onExit) this.onExit()
    else process.exit(0)
  }

  toast(text) {
    this.state.toast = { text: String(text || ""), until: Date.now() + 2800 }
    this.dirty = true
  }

  startSpinner() {
    if (this.spinnerTimer) return
    this.spinnerTimer = setInterval(() => {
      this.state.frame++
      this.state.spinner = SPINNER[this.state.frame % SPINNER.length]
      this.dirty = true
    }, 120)
  }

  stopSpinner() {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
  }

  async load() {
    const data = await this.api.bootstrap()
    this.state.appInfo = data.app || {}
    this.state.workspace = data.app?.workspace || ""
    this.state.sessions = data.conversations || []
    this.state.projects = data.projects || []
    this.state.providers = data.providers || []
    this.state.allModels = data.models || []
    this.state.usage = data.usage || null
    this.state.settings = data.settings || {}
    if (this.state.settings.defaultProvider && this.state.settings.defaultProvider !== "auto") this.state.model = this.state.settings.defaultModel || "auto"
    const latest = this.state.sessions[0]
    if (latest) await this.openConversation(latest.id, { quiet: true })
  }

  async refreshSessions() {
    try {
      const data = await this.api.conversations()
      this.state.sessions = data.conversations || []
      this.dirty = true
    } catch {}
  }

  syncSession(conversation) {
    if (!conversation) return
    const list = this.state.sessions
    const index = list.findIndex((item) => item.id === conversation.id)
    const summary = {
      ...(index >= 0 ? list[index] : {}),
      ...conversation,
      messageCount: conversation.messageCount ?? (index >= 0 ? list[index].messageCount : 0)
    }
    if (index >= 0) list[index] = summary
    else list.unshift(summary)
  }

  updateModelState() {
    const conversation = this.state.conversation
    if (!conversation) return
    const model = conversation.model || "auto"
    this.state.model = model
    const match = this.state.allModels.find(
      (item) => item.model === model && (!conversation.providerId || item.providerId === conversation.providerId)
    )
    this.state.context = Number(match?.context || this.state.context || 128000)
  }

  async openConversation(id, { quiet = false } = {}) {
    try {
      const data = await this.api.conversation(id)
      this.state.conversation = data.conversation
      this.state.messages = data.messages || []
      this.state.mode = data.conversation?.mode || "build"
      this.state.tokens = estimateTokens(this.state.messages)
      this.updateModelState()
      this.state.streamingText = ""
      this.state.thinking = ""
      this.state.scroll = 0
      if (data.project && !this.state.projects.some((item) => item.id === data.project.id)) this.state.projects.push(data.project)
      this.dirty = true
    } catch (error) {
      if (!quiet) this.toast(error.message)
    }
  }

  async createConversation(input = {}) {
    const { conversation } = await this.api.createConversation(input)
    this.state.conversation = conversation
    this.state.messages = []
    this.state.mode = conversation.mode || "build"
    this.state.tokens = 0
    this.state.streamingText = ""
    this.state.thinking = ""
    this.state.scroll = 0
    this.updateModelState()
    this.syncSession(conversation)
    this.dirty = true
    return conversation
  }

  async newConversation() {
    if (this.state.busy) return this.toast("finish the current turn first")
    try {
      await this.createConversation({ mode: this.state.mode })
      this.state.composer = ""
      this.state.cursor = 0
      this.toast("new session")
    } catch (error) {
      this.toast(error.message)
    }
  }

  async patchConversation(patch) {
    if (!this.state.conversation) return null
    try {
      const { conversation } = await this.api.patchConversation(this.state.conversation.id, patch)
      this.state.conversation = conversation
      this.syncSession(conversation)
      this.dirty = true
      return conversation
    } catch (error) {
      this.toast(error.message)
      return null
    }
  }

  async reload() {
    const id = this.state.conversation?.id
    if (!id) return
    try {
      const data = await this.api.conversation(id)
      this.state.conversation = data.conversation
      this.state.messages = data.messages || []
      this.state.tokens = estimateTokens(this.state.messages)
      this.updateModelState()
      this.syncSession(data.conversation)
      if (data.project && !this.state.projects.some((item) => item.id === data.project.id)) this.state.projects.push(data.project)
    } catch {}
    this.dirty = true
  }

  async send(raw) {
    const text = String(raw ?? "")
    if (!text.trim()) return
    if (this.state.busy) return this.toast("wait for the current turn")
    if (text.trim().startsWith("/")) {
      this.state.composer = ""
      this.state.cursor = 0
      await this.runCommand(text.trim().slice(1))
      return
    }
    if (this.history[this.history.length - 1] !== text) this.history.push(text)
    this.historyIndex = -1
    this.draft = ""
    this.state.composer = ""
    this.state.cursor = 0
    if (!this.state.conversation) {
      try {
        await this.createConversation({ mode: this.state.mode })
      } catch (error) {
        return this.toast(error.message)
      }
    }
    const conversationId = this.state.conversation.id
    this.state.messages.push({
      id: `local-${Date.now()}`,
      conversationId,
      role: "user",
      content: text,
      attachments: [],
      toolCalls: [],
      meta: {},
      createdAt: Date.now()
    })
    this.state.busy = true
    this.state.streaming = true
    this.state.taskLabel = "Thinking"
    this.state.streamingText = ""
    this.state.thinking = ""
    this.state.step = 0
    this.state.requestId = ""
    this.state.scroll = 0
    this.startSpinner()
    this.dirty = true

    this.controller = new AbortController()
    try {
      for await (const frame of this.api.chat({ conversationId, message: text }, { signal: this.controller.signal })) {
        await this.onEvent(frame.event, frame.data)
      }
    } catch (error) {
      if (error?.name !== "AbortError" && !this.closed) {
        this.toast(error.message || "request failed")
        if (this.state.requestId) this.api.stopChat(this.state.requestId).catch(() => {})
      }
    } finally {
      this.state.busy = false
      this.state.streaming = false
      this.state.requestId = ""
      this.stopSpinner()
      this.controller = null
      await this.reload()
      this.dirty = true
    }
  }

  async onEvent(event, data) {
    const state = this.state
    switch (event) {
      case "ready":
        state.requestId = data.requestId || state.requestId
        if (data.conversation) {
          state.conversation = data.conversation
          this.syncSession(data.conversation)
        }
        break
      case "conversation":
        if (data.conversation) {
          state.conversation = data.conversation
          if (data.conversation.mode) state.mode = data.conversation.mode
          this.syncSession(data.conversation)
        }
        if (data.titleUpdated && data.conversation) this.syncSession(data.conversation)
        break
      case "meta":
        if (data.providerName) state.providerName = data.providerName
        if (data.model) {
          state.model = data.model
          const match = state.allModels.find((item) => item.model === data.model)
          if (match?.context) state.context = match.context
        }
        state.taskLabel = "Thinking"
        break
      case "delta":
        state.streamingText += String(data.text || "")
        state.taskLabel = "Writing"
        break
      case "thinking":
        state.thinking += String(data.text || "")
        break
      case "notice":
        if (data.message) this.toast(data.message)
        state.taskLabel = data.retry ? "Retrying" : "Thinking"
        break
      case "tool_start":
        state.taskLabel = `${data.name || "tool"}`
        break
      case "tool_end":
        state.taskLabel = "Thinking"
        if (data.status && data.status !== "ok" && data.status !== "done" && data.status !== "success") {
          this.toast(`${data.name || "tool"}: ${String(data.output || data.status).slice(0, 120)}`)
        }
        break
      case "approval":
        this.openApproval(data)
        state.taskLabel = "Waiting for approval"
        break
      case "usage":
        if (data.total) state.tokens = Number(data.total) || state.tokens
        state.usage = { ...(state.usage || {}), last: data }
        break
      case "step":
        state.step = Number(data.step) || state.step
        state.taskLabel = `Step ${state.step}`
        break
      case "file_changed":
        this.toast(`${data.action || "changed"} ${data.path || ""}`)
        break
      case "command_start":
        state.taskLabel = `Running ${String(data.command || "").slice(0, 40)}`
        break
      case "command_end":
        state.taskLabel = "Thinking"
        break
      case "project":
        if (data.project) {
          this.state.conversation = { ...(this.state.conversation || {}), projectId: data.project.id }
          if (!this.state.projects.some((item) => item.id === data.project.id)) this.state.projects.push(data.project)
        }
        break
      case "done":
        if (data.usage?.total) state.tokens = Number(data.usage.total) || state.tokens
        state.taskLabel = "Done"
        break
      case "error":
        this.toast(data.message || `error ${data.status || ""}`)
        state.taskLabel = "Failed"
        break
      case "stopped":
        this.toast("stopped")
        state.taskLabel = "Stopped"
        break
      default:
        break
    }
    this.dirty = true
  }

  onKey(key) {
    if (!key) return
    if (this.fatal) {
      if (key.name === "char" && key.text.toLowerCase() === "r") {
        this.fatal = false
        this.boot()
      } else if (key.name === "char" && key.text.toLowerCase() === "q") {
        this.quit()
      }
      return
    }
    if (key.name === "ctrl" && key.key === "x") {
      this.leaderUntil = Date.now() + 2000
      this.toast("ctrl+x · n new  l sessions  m models  a providers  s status  q quit")
      return
    }
    if (this.leaderUntil && Date.now() < this.leaderUntil && key.name === "char") {
      this.leaderUntil = 0
      const actions = {
        n: () => this.newConversation(),
        l: () => this.openSessions(),
        m: () => this.openModels(),
        q: () => this.quit(),
        p: () => this.openPalette(),
        r: () => this.redoChange(),
        f: () => this.togglePin(),
        e: () => this.exportConversation(),
        x: () => this.exportConversation(),
        t: () => this.openProviders(),
        a: () => this.openProviders(),
        s: () => this.openStatus(),
        c: () => this.compactConversation(),
        u: () => this.undoChange(),
        b: () => this.toggleSidebar()
      }
      const action = actions[key.text]
      if (action) action()
      return
    }
    this.leaderUntil = 0

    if (this.state.modal) {
      this.onModalKey(key)
      return
    }
    if (key.name === "ctrl") {
      this.onCtrl(key.key)
      return
    }
    if (key.name === "escape") {
      if (this.state.busy) this.interrupt()
      else if (this.state.composer) {
        this.state.composer = ""
        this.state.cursor = 0
        this.dirty = true
      }
      return
    }
    if (key.name === "enter") {
      this.send(this.state.composer)
      return
    }
    if (key.name === "newline") {
      this.insertText("\n")
      return
    }
    if (key.name === "tab") {
      this.cycleMode(1)
      return
    }
    if (key.name === "shifttab") {
      this.cycleMode(-1)
      return
    }
    if (key.name === "paste") {
      this.insertText(key.text || "")
      return
    }
    if (key.name === "backspace") {
      if (key.alt) this.deleteWord()
      else this.deleteChar(-1)
      return
    }
    if (key.name === "delete") {
      this.deleteChar(1)
      return
    }
    if (key.name === "left") {
      if (key.ctrl || key.alt) this.moveWord(-1)
      else this.moveCursor(-1)
      return
    }
    if (key.name === "right") {
      if (key.ctrl || key.alt) this.moveWord(1)
      else this.moveCursor(1)
      return
    }
    if (key.name === "home") {
      this.state.cursor = 0
      this.dirty = true
      return
    }
    if (key.name === "end") {
      this.state.cursor = Array.from(this.state.composer).length
      this.dirty = true
      return
    }
    if (key.name === "up") {
      this.historyStep(1)
      return
    }
    if (key.name === "down") {
      this.historyStep(-1)
      return
    }
    if (key.name === "pageup") {
      this.state.scroll += 10
      this.dirty = true
      return
    }
    if (key.name === "pagedown") {
      this.state.scroll = Math.max(0, this.state.scroll - 10)
      this.dirty = true
      return
    }
    if (key.name === "char") {
      if (key.ctrl || key.alt) return
      this.insertText(key.text)
    }
  }

  onCtrl(key) {
    const actions = {
      c: () => {
        if (this.state.busy) return this.interrupt()
        if (this.state.composer) {
          this.state.composer = ""
          this.state.cursor = 0
          this.dirty = true
          return
        }
        this.toast("ctrl+d to quit")
      },
      d: () => this.quit(),
      p: () => this.openPalette(),
      n: () => this.newConversation(),
      k: () => this.openSessions(),
      o: () => this.openSessions(),
      m: () => this.openModels(),
      r: () => this.openRename(),
      f: () => this.togglePin(),
      e: () => this.exportConversation(),
      y: () => this.copyReply(),
      t: () => this.openProviders(),
      a: () => {
        this.state.cursor = 0
        this.dirty = true
      },
      u: () => {
        this.state.scroll += 10
        this.dirty = true
      },
      v: () => {
        this.state.scroll = Math.max(0, this.state.scroll - 10)
        this.dirty = true
      }
    }
    const action = actions[key]
    if (action) action()
  }

  onModalKey(key) {
    const modal = this.state.modal
    if (!modal) return
    if (key.name === "escape") {
      if (modal.type === "approval") this.resolveApproval(false)
      else this.closeModal()
      return
    }
    if (key.name === "ctrl" && key.key === "c") {
      if (modal.type === "approval") this.resolveApproval(false)
      else this.closeModal()
      return
    }
    if (modal.type === "approval") {
      if (key.name === "char" && /^[yn]$/i.test(key.text)) this.resolveApproval(key.text.toLowerCase() === "y")
      return
    }
    if (modal.type === "confirm") {
      if (key.name === "char" && /^y$/i.test(key.text)) {
        const action = modal.onYes
        this.closeModal()
        if (action) action()
      } else if (key.name === "char" && /^n$/i.test(key.text)) {
        this.closeModal()
      }
      return
    }
    if (modal.type === "prompt") {
      if (key.name === "enter") {
        const value = String(modal.value || "").trim()
        const action = modal.onSubmit
        this.closeModal()
        if (action) action(value)
        return
      }
      if (key.name === "backspace") {
        modal.value = Array.from(String(modal.value || "")).slice(0, -1).join("")
        this.dirty = true
        return
      }
      if (key.name === "char") {
        modal.value = `${modal.value || ""}${key.text}`
        this.dirty = true
        return
      }
      if (key.name === "paste") {
        modal.value = `${modal.value || ""}${key.text || ""}`
        this.dirty = true
        return
      }
      return
    }
    if (modal.type === "form") {
      const fields = modal.fields || []
      if (key.name === "enter") {
        this.submitForm(modal)
        return
      }
      if (key.name === "tab" || key.name === "down") {
        modal.index = ((modal.index || 0) + 1) % Math.max(1, fields.length)
        this.dirty = true
        return
      }
      if (key.name === "shifttab" || key.name === "up") {
        modal.index = ((modal.index || 0) - 1 + fields.length) % Math.max(1, fields.length)
        this.dirty = true
        return
      }
      const field = fields[modal.index || 0]
      if (!field) return
      if (key.name === "backspace") {
        field.value = Array.from(String(field.value || "")).slice(0, -1).join("")
      } else if (key.name === "char") {
        field.value = `${field.value || ""}${key.text}`
      } else if (key.name === "paste") {
        field.value = `${field.value || ""}${key.text || ""}`
      }
      this.dirty = true
      return
    }
    if (modal.type === "help" || modal.type === "status" || modal.type === "usage") {
      this.closeModal()
      return
    }

    if (key.name === "up") {
      modal.index = Math.max(0, (modal.index || 0) - 1)
      this.dirty = true
      return
    }
    if (key.name === "down") {
      modal.index = Math.min((modal.items || []).length - 1, (modal.index || 0) + 1)
      this.dirty = true
      return
    }
    if (key.name === "pageup") {
      modal.index = Math.max(0, (modal.index || 0) - 6)
      this.dirty = true
      return
    }
    if (key.name === "pagedown") {
      modal.index = Math.min((modal.items || []).length - 1, (modal.index || 0) + 6)
      this.dirty = true
      return
    }
    if (key.name === "enter") {
      const item = (modal.items || [])[modal.index || 0]
      if (item) this.selectItem(modal, item)
      return
    }
    if (key.name === "backspace") {
      modal.query = Array.from(String(modal.query || "")).slice(0, -1).join("")
      this.filterList(modal)
      return
    }
    if (key.name === "char") {
      modal.query = `${modal.query || ""}${key.text}`
      this.filterList(modal)
    }
  }

  filterList(modal) {
    const query = String(modal.query || "").toLowerCase()
    const source = modal.source || []
    modal.items = query
      ? source.filter((item) => `${item.label} ${item.detail || ""}`.toLowerCase().includes(query))
      : source
    modal.index = 0
    this.dirty = true
  }

  selectItem(modal, item) {
    this.closeModal()
    if (typeof item.action === "function") {
      item.action()
      return
    }
    if (modal.type === "models") this.applyModel(item.value)
    else if (modal.type === "sessions") this.openConversation(item.value)
    else if (modal.type === "projects") this.setProject(item.value === "__new" ? null : item.value, item)
    else if (modal.type === "providers") this.openProviderForm(item.value)
  }

  openModal(modal) {
    this.state.modal = { ...modal, index: modal.index || 0, query: modal.query || "" }
    this.dirty = true
  }

  closeModal() {
    this.state.modal = null
    this.dirty = true
  }

  openList(type, title, source) {
    this.openModal({ type, title, source, items: source })
  }

  openPalette() {
    if (this.state.modal) return
    const items = [
      { label: "New session", detail: "ctrl+n", action: () => this.newConversation() },
      { label: "Sessions", detail: "ctrl+k", action: () => this.openSessions() },
      { label: "Models", detail: "ctrl+m", action: () => this.openModels() },
      { label: "Providers", detail: "ctrl+t", action: () => this.openProviders() },
      { label: "Projects", detail: "workspace", action: () => this.openProjects() },
      { label: "Change mode", detail: "tab", action: () => this.cycleMode(1) },
      { label: "Rename session", detail: "ctrl+r", action: () => this.openRename() },
      { label: "Pin session", detail: "ctrl+f", action: () => this.togglePin() },
      { label: "Clear session", detail: "/clear", action: () => this.clearConversation() },
      { label: "Compact context", detail: "/compact", action: () => this.compactConversation() },
      { label: "Undo last file change", detail: "/undo", action: () => this.undoChange() },
      { label: "Redo file change", detail: "/redo", action: () => this.redoChange() },
      { label: "Toggle sidebar", detail: "ctrl+x b", action: () => this.toggleSidebar() },
      { label: "Export markdown", detail: "ctrl+e", action: () => this.exportConversation() },
      { label: "Copy last reply", detail: "ctrl+y", action: () => this.copyReply() },
      { label: "Copy code block", detail: "/copycode", action: () => this.copyCode() },
      { label: "Usage", detail: "/usage", action: () => this.openUsage() },
      { label: "Status", detail: "/status", action: () => this.openStatus() },
      { label: "Keys", detail: "/help", action: () => this.openHelp() },
      { label: "Quit", detail: "ctrl+d", action: () => this.quit() }
    ]
    this.openList("palette", "Commands", items)
  }

  openSessions() {
    const items = this.state.sessions.map((item) => ({
      label: `${item.pinned ? "★ " : ""}${item.title || "New chat"}`,
      detail: `${timeAgo(item.updatedAt)} · ${item.mode || "build"}`,
      value: item.id
    }))
    this.openList("sessions", "Sessions", items)
  }

  openModels() {
    const models = [...this.state.allModels].sort((a, b) => {
      if (Boolean(a.free) !== Boolean(b.free)) return a.free ? -1 : 1
      return String(a.provider || "").localeCompare(String(b.provider || ""))
    })
    const items = models.map((model) => ({
      label: `${model.free ? "◆ " : "◇ "}${model.model || model.label}`,
      detail: `${model.provider || ""}${model.providerEnabled === false ? " · disabled" : ""}${model.context ? ` · ${Math.round(model.context / 1000)}k` : ""}`,
      value: model
    }))
    this.openList("models", "Models", items)
  }

  openProjects() {
    const items = [
      { label: "＋ New project", detail: "create", value: "__new" },
      ...this.state.projects.map((project) => ({
        label: project.name,
        detail: project.id === this.state.conversation?.projectId ? "attached" : "",
        value: project.id
      }))
    ]
    this.openList("projects", "Projects", items)
  }

  openProviders() {
    const items = [
      { label: "＋ Add provider", detail: "name, base url, key", value: null },
      ...this.state.providers.map((provider) => ({
        label: provider.name,
        detail: `${provider.free ? "free · " : ""}${provider.keyless ? "keyless" : provider.hasKey ? provider.keyHint : "no key"}${provider.enabled ? " · on" : " · off"}`,
        value: provider
      }))
    ]
    this.openList("providers", "Providers", items)
  }

  openProviderForm(provider) {
    this.openModal({
      type: "form",
      title: provider ? `Edit ${provider.name}` : "Add provider",
      index: 0,
      fields: [
        { key: "name", label: "Name", value: provider?.name || "" },
        { key: "baseUrl", label: "Base URL", value: provider?.baseUrl || "" },
        { key: "apiKey", label: "API key", value: "", masked: true, hint: provider?.hasKey ? `saved ${provider.keyHint}` : "paste key" },
        { key: "docs", label: "Docs URL", value: provider?.docs || "" }
      ],
      submit: async (values) => {
        if (!values.name || !values.baseUrl) return this.toast("name and base URL are required")
        try {
          await this.api.saveProvider({
            name: values.name,
            baseUrl: values.baseUrl,
            docs: values.docs,
            apiKey: values.apiKey || undefined
          })
          const data = await this.api.providers()
          this.state.providers = data.providers || []
          this.toast("provider saved")
        } catch (error) {
          this.toast(error.message)
        }
      }
    })
  }

  submitForm(modal) {
    const values = {}
    for (const field of modal.fields || []) values[field.key] = String(field.value || "").trim()
    const action = modal.submit
    this.closeModal()
    if (action) action(values)
  }

  openPrompt(title, value, onSubmit) {
    this.openModal({ type: "prompt", title, value, onSubmit })
  }

  openRename() {
    if (!this.state.conversation) return
    this.openPrompt("Rename session", this.state.conversation.title || "", (value) => {
      if (!value) return
      this.patchConversation({ title: value })
    })
  }

  openHelp() {
    this.openModal({ type: "help" })
  }

  openStatus() {
    this.openModal({ type: "status" })
  }

  async openUsage() {
    try {
      const usage = await this.api.usage()
      this.state.usage = usage
    } catch {}
    this.openModal({ type: "usage" })
  }

  openApproval(data) {
    this.openModal({
      type: "approval",
      id: data.id,
      kind: data.kind,
      payload: data.payload || {},
      conversationId: data.conversationId
    })
  }

  async resolveApproval(approve) {
    const modal = this.state.modal
    if (!modal) return
    this.closeModal()
    try {
      await this.api.resolveApproval(modal.id, approve)
      this.toast(approve ? "approved" : "denied")
    } catch (error) {
      this.toast(error.message)
    }
  }

  cycleMode(delta) {
    const current = MODES.indexOf(this.state.conversation?.mode || this.state.mode)
    const next = MODES[(Math.max(0, current) + delta + MODES.length) % MODES.length]
    this.state.mode = next
    this.toast(modeLabel(next))
    if (this.state.conversation) this.patchConversation({ mode: next })
    else this.dirty = true
  }

  async applyModel(model) {
    if (!model) return
    await this.patchConversation({ providerId: model.providerId, model: model.model })
    this.state.model = model.model
    if (model.context) this.state.context = model.context
    this.toast(`${model.model}`)
  }

  async setProject(id, item) {
    if (item && item.value === "__new") {
      return this.openPrompt("New project name", "", async (name) => {
        if (!name) return
        try {
          const { project } = await this.api.createProject(name)
          this.state.projects.push(project)
          await this.patchConversation({ projectId: project.id })
          this.toast(`project ${project.name}`)
        } catch (error) {
          this.toast(error.message)
        }
      })
    }
    await this.patchConversation({ projectId: id })
    this.toast(id ? "project attached" : "project detached")
  }

  async togglePin() {
    if (!this.state.conversation) return
    const pinned = !this.state.conversation.pinned
    await this.patchConversation({ pinned })
    this.toast(pinned ? "pinned" : "unpinned")
    this.refreshSessions()
  }

  toggleSidebar() {
    this.state.sidebar = !this.state.sidebar
    this.dirty = true
    this.toast(this.state.sidebar ? "sidebar on" : "sidebar off")
  }

  async undoChange() {
    if (!this.state.conversation) return this.toast("no session")
    if (this.state.busy) return this.toast("wait for the current turn")
    try {
      const result = await this.api.undo(this.state.conversation.id)
      await this.reload()
      this.toast(result?.result?.message || "undone")
    } catch (error) {
      this.toast(error.message)
    }
  }

  async redoChange() {
    if (!this.state.conversation) return this.toast("no session")
    if (this.state.busy) return this.toast("wait for the current turn")
    try {
      const result = await this.api.redo(this.state.conversation.id)
      await this.reload()
      this.toast(result?.result?.message || "redone")
    } catch (error) {
      this.toast(error.message)
    }
  }

  async clearConversation() {
    if (!this.state.conversation) return
    const id = this.state.conversation.id
    this.openModal({
      type: "confirm",
      title: "Clear session",
      message: "Delete every message in this session? This cannot be undone.",
      onYes: async () => {
        try {
          await this.api.clearConversation(id)
          this.state.messages = []
          this.state.tokens = 0
          this.toast("session cleared")
        } catch (error) {
          this.toast(error.message)
        }
      }
    })
  }

  async compactConversation() {
    if (!this.state.conversation) return
    try {
      await this.api.compactConversation(this.state.conversation.id)
      this.toast("context compacted")
    } catch (error) {
      this.toast(error.message)
    }
  }

  async exportConversation() {
    if (!this.state.conversation) return
    try {
      const markdown = await this.api.exportMarkdown(this.state.conversation.id)
      const dir = path.join(resolveDataDir(), "exports")
      mkdirSync(dir, { recursive: true })
      const slug = String(this.state.conversation.title || "zycron")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "zycron"
      const file = path.join(dir, `${slug}-${this.state.conversation.id.slice(0, 8)}.md`)
      writeFileSync(file, markdown)
      this.toast(`exported ${file}`)
    } catch (error) {
      this.toast(error.message)
    }
  }

  copyReply() {
    const reply = [...this.state.messages].reverse().find((message) => message.role === "assistant" && message.content)
    if (!reply) return this.toast("nothing to copy")
    if (copyToClipboard(reply.content)) this.toast("copied reply")
    else this.toast("clipboard unavailable")
  }

  copyCode() {
    const text = [...this.state.messages].reverse().find((message) => message.role === "assistant" && message.content)?.content || ""
    const blocks = [...String(text).matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    if (!blocks.length) return this.copyReply()
    if (copyToClipboard(blocks[blocks.length - 1][1])) this.toast("copied code")
    else this.toast("clipboard unavailable")
  }

  async interrupt() {
    if (!this.state.busy) return
    this.state.taskLabel = "Stopping"
    this.dirty = true
    const requestId = this.state.requestId
    if (requestId) {
      try {
        await this.api.stopChat(requestId)
      } catch {}
    }
    try {
      this.controller?.abort()
    } catch {}
  }

  async runCommand(line) {
    const [name, ...rest] = line.split(/\s+/)
    const args = rest.join(" ").trim()
    switch (name) {
      case "new":
        return this.newConversation()
      case "model":
        return this.openModels()
      case "mode":
        if (MODES.includes(args)) {
          this.state.mode = args
          this.toast(modeLabel(args))
          if (this.state.conversation) this.patchConversation({ mode: args })
        } else this.cycleMode(1)
        return
      case "sessions":
        return this.openSessions()
      case "providers":
        return this.openProviders()
      case "connect":
        return this.openProviderForm(null)
      case "workspace":
        return this.toast(this.state.workspace || "no workspace")
      case "project":
        return this.openProjects()
      case "rename":
        return this.openRename()
      case "delete":
        if (!this.state.conversation) return
        return this.openModal({
          type: "confirm",
          title: "Delete session",
          message: "Delete this session and all of its messages?",
          onYes: async () => {
            try {
              await this.api.deleteConversation(this.state.conversation.id)
              this.state.sessions = this.state.sessions.filter((item) => item.id !== this.state.conversation.id)
              this.state.conversation = null
              this.state.messages = []
              const next = this.state.sessions[0]
              if (next) await this.openConversation(next.id)
              this.toast("deleted")
            } catch (error) {
              this.toast(error.message)
            }
          }
        })
      case "pin":
        return this.togglePin()
      case "clear":
        return this.clearConversation()
      case "undo":
        return this.undoChange()
      case "redo":
        return this.redoChange()
      case "exit":
        return this.quit()
      case "compact":
        return this.compactConversation()
      case "export":
        return this.exportConversation()
      case "copy":
        return this.copyReply()
      case "copycode":
        return this.copyCode()
      case "usage":
        return this.openUsage()
      case "status":
        return this.openStatus()
      case "help":
        return this.openHelp()
      case "quit":
        return this.quit()
      default:
        return this.toast(`unknown command /${name}`)
    }
  }

  insertText(text) {
    if (!text) return
    const chars = Array.from(this.state.composer)
    chars.splice(this.state.cursor, 0, ...Array.from(String(text).replace(/\r\n?/g, "\n")))
    this.state.composer = chars.join("").slice(0, 20000)
    this.state.cursor = Math.min(chars.length, this.state.cursor + Array.from(String(text)).length)
    this.state.scroll = 0
    this.dirty = true
  }

  deleteChar(direction) {
    const chars = Array.from(this.state.composer)
    if (direction < 0) {
      if (!this.state.cursor) return
      chars.splice(this.state.cursor - 1, 1)
      this.state.cursor--
    } else {
      if (this.state.cursor >= chars.length) return
      chars.splice(this.state.cursor, 1)
    }
    this.state.composer = chars.join("")
    this.dirty = true
  }

  deleteWord() {
    const chars = Array.from(this.state.composer)
    if (!this.state.cursor) return
    let index = this.state.cursor
    while (index > 0 && /\s/.test(chars[index - 1])) index--
    while (index > 0 && !/\s/.test(chars[index - 1])) index--
    chars.splice(index, this.state.cursor - index)
    this.state.cursor = index
    this.state.composer = chars.join("")
    this.dirty = true
  }

  moveCursor(delta) {
    this.state.cursor = Math.max(0, Math.min(Array.from(this.state.composer).length, this.state.cursor + delta))
    this.dirty = true
  }

  moveWord(direction) {
    const chars = Array.from(this.state.composer)
    let index = this.state.cursor
    if (direction < 0) {
      while (index > 0 && /\s/.test(chars[index - 1])) index--
      while (index > 0 && !/\s/.test(chars[index - 1])) index--
    } else {
      while (index < chars.length && !/\s/.test(chars[index])) index++
      while (index < chars.length && /\s/.test(chars[index])) index++
    }
    this.state.cursor = index
    this.dirty = true
  }

  historyStep(direction) {
    if (!this.history.length) return
    if (this.historyIndex === -1) this.draft = this.state.composer
    let index = this.historyIndex + direction
    if (index < -1) index = -1
    if (index >= this.history.length) index = this.history.length - 1
    this.historyIndex = index
    const value = index === -1 ? this.draft : this.history[this.history.length - 1 - index]
    this.state.composer = value
    this.state.cursor = Array.from(value).length
    this.dirty = true
  }
}

function estimateTokens(messages) {
  let total = 0
  for (const message of messages || []) {
    const usage = message?.meta?.usage
    if (usage && Number(usage.total)) total = Math.max(total, Number(usage.total))
    total += Math.ceil(String(message?.content || "").length / 4)
  }
  return total
}

function timeAgo(timestamp) {
  const diff = Math.max(0, Date.now() - Number(timestamp || 0))
  const minute = 60000
  if (diff < minute) return "now"
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}m`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}h`
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))}d`
  return new Date(Number(timestamp)).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
