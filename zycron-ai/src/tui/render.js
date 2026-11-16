import {
  color,
  Grid,
  span,
  textWidth,
  truncate,
  wrapSpans,
  spansWidth,
  formatTokens,
  timeAgo
} from "./ansi.js"
import { renderMarkdown, formatArgs, toolSummary } from "./markdown.js"

const MODE_COLORS = {
  plan: color.blue,
  build: color.violet,
  debug: color.yellow,
  review: color.cyan
}

const MODE_LABELS = {
  plan: "Plan",
  build: "Build",
  debug: "Debug",
  review: "Review"
}

export function modeLabel(mode) {
  return MODE_LABELS[mode] || "Build"
}

export function renderScreen(state) {
  const cols = Math.max(20, Math.floor(state.cols || 80))
  const rows = Math.max(8, Math.floor(state.rows || 24))
  const grid = new Grid(cols, rows)
  grid.clear("")

  if (state.boot) return finish(grid, drawBoot(grid, state, cols, rows))
  return finish(grid, drawMain(grid, state, cols, rows))
}

function finish(grid, cursor) {
  const lines = grid.toLines()
  const text = lines.join("\r\n")
  return { lines, text, cursor: cursor || null }
}

function clip(spans, width) {
  let used = 0
  const out = []
  for (const entry of spans) {
    const text = String(entry.t ?? "")
    let chunk = ""
    for (const ch of text) {
      const w = textWidth(ch)
      if (used + w > width) {
        if (chunk) out.push({ t: chunk, s: entry.s || "" })
        return out
      }
      chunk += ch
      used += w
    }
    if (chunk) out.push({ t: chunk, s: entry.s || "" })
  }
  return out
}

function drawBoot(grid, state, cols, rows) {
  const lines = []
  const logo = [
    "┏━┓╻ ╻┏━╸┏━┓┏━┓┏┓╻",
    "┣━┛┗┳┛┃  ┃ ┃┃ ┃┃┗┫",
    "╹   ╹ ┗━╸┗━┛┗━┛╹ ╹"
  ]
  lines.push([span("ZYCRON AI", color.violetBold)])
  lines.push([])
  for (const line of logo) lines.push([span(line, color.purple)])
  lines.push([])
  const message = state.boot.message || "starting"
  const dots = ".".repeat((Math.floor(Date.now() / 400) % 4))
  lines.push([span(`${message}${dots}`, color.muted)])
  if (state.boot.error) {
    lines.push([])
    for (const part of wrapSpans([span(state.boot.error, color.red)], Math.min(cols - 6, 68))) lines.push(part)
    lines.push([])
    lines.push([span("r", color.bright), span(" retry    ", color.faint), span("q", color.bright), span(" quit", color.faint)])
  }
  const height = lines.length
  const top = Math.max(0, Math.floor((rows - height) / 2))
  for (let i = 0; i < lines.length; i++) {
    const width = spansWidth(lines[i])
    const x = Math.max(0, Math.floor((cols - width) / 2))
    grid.putSpans(x, top + i, lines[i], cols - x)
  }
  return null
}

function drawMain(grid, state, cols, rows) {
  const sidebarW = state.sidebar === false ? 0 : cols >= 96 ? 30 : cols >= 76 ? 26 : 0
  const mainX = sidebarW ? sidebarW + 1 : 0
  const mainW = cols - mainX

  drawHeader(grid, state, 0, mainX, mainW)
  if (sidebarW) drawSidebar(grid, state, sidebarW, rows)

  const composer = composerBox(state, mainW)
  const composerH = composer.height
  const composerY = rows - 1 - composerH
  const taskH = state.busy ? 3 : 0
  const chatY = 1
  const taskY = composerY - taskH - (taskH ? 1 : 0)
  const chatH = Math.max(1, taskY - chatY)

  const bodyWidth = Math.max(8, mainW - 2)
  const lines = chatLines(state, bodyWidth)
  drawChat(grid, lines, mainX, chatY, bodyWidth, chatH, state)

  if (state.busy) drawTask(grid, state, mainX, taskY + 1, mainW)
  const cursor = drawComposer(grid, state, composer, mainX, composerY, mainW)
  drawStatus(grid, state, rows - 1, mainX, mainW)

  if (state.modal) {
    const modalCursor = drawModal(grid, state, cols, rows)
    return modalCursor || cursor
  }
  return cursor
}

function drawHeader(grid, state, y, x, width) {
  const title = state.conversation?.title || "New chat"
  const left = [span(" ✦ ", color.violetBold), span("ZYCRON", color.bright)]
  const mode = state.conversation?.mode || state.mode || "build"
  const right = [
    span(modeLabel(mode), MODE_COLORS[mode] || color.violet),
    span("  ", ""),
    span(truncate(state.model || "auto", Math.max(8, Math.floor(width / 4))), color.muted)
  ]
  const gap = Math.max(2, width - spansWidth(left) - spansWidth(right) - textWidth(title) - 4)
  const center = [span(truncate(title, Math.max(4, gap)), color.faint)]
  grid.putSpans(x, y, [...left, span("  ", ""), ...center], width)
  grid.putSpans(x + width - spansWidth(right), y, right, width)
}

function drawSidebar(grid, state, width, rows) {
  const x = 0
  const inner = width - 2
  grid.put(width, 0, "│", color.border)
  for (let y = 1; y < rows; y++) grid.put(width, y, "│", color.border)

  let y = 1
  const line = (spans, style = "") => {
    if (y >= rows - 1) return
    grid.putSpans(x + 1, y, spans, inner)
    y++
  }
  const heading = (text) => {
    line([span(text.toUpperCase(), color.ghost)])
  }

  heading("sessions")
  const sessions = state.sessions || []
  if (!sessions.length) line([span("  no sessions yet", color.ghost)])
  for (const item of sessions.slice(0, Math.max(4, Math.floor((rows - 10) / 2)))) {
    const active = item.id === state.conversation?.id
    line([
      span(active ? "▸ " : "  ", active ? color.violet : color.border),
      span(truncate(item.title || "New chat", inner - 3), active ? color.bright : color.muted)
    ])
  }

  y = Math.max(y + 1, Math.floor(rows * 0.58))
  heading("projects")
  const projects = state.projects || []
  if (!projects.length) line([span("  none yet", color.ghost)])
  for (const item of projects.slice(0, Math.max(3, Math.floor((rows - y) - 2)))) {
    const active = item.id === state.conversation?.projectId
    line([
      span(active ? "◆ " : "◇ ", active ? color.violet : color.border),
      span(truncate(item.name, inner - 3), active ? color.bright : color.muted)
    ])
  }
}

function chatLines(state, width) {
  const lines = []
  const messages = state.messages || []
  if (!messages.length && !state.streamingText) {
    return welcome(width)
  }
  for (const message of messages) {
    const block = messageLines(message, width, state)
    if (!block.length) continue
    if (lines.length) lines.push([])
    lines.push(...block)
  }
  if (state.streamingText || state.thinking) {
    if (lines.length) lines.push([])
    lines.push(...streamBlock(state, width))
  }
  return lines
}

function welcome(width) {
  const lines = []
  lines.push([])
  lines.push([span("✦ ZYCRON AI", color.violetBold)])
  lines.push([])
  for (const part of wrapSpans([span("Ask anything, or describe what to build. The agent can read, edit, and run code inside a project.", color.muted)], Math.min(width - 2, 72))) {
    lines.push([span("  ", ""), ...part])
  }
  lines.push([])
  const hints = [
    ["/", "commands"],
    ["ctrl+p", "palette"],
    ["ctrl+n", "new session"],
    ["ctrl+m", "model"],
    ["tab", "mode"]
  ]
  for (const [key, label] of hints) {
    lines.push([span("  ", ""), span(key, color.bright), span(`  ${label}`, color.faint)])
  }
  lines.push([])
  if (state.workspace) lines.push([span(`  ${state.workspace}`, color.ghost)])
  return lines
}

function messageLines(message, width, state) {
  const role = message.role
  const content = String(message.content ?? "")
  if (role === "tool") {
    const name = message.name || "tool"
    const head = [span("  ⟡ ", color.faint), span(name, color.cyan), span(`  ${truncate(preview(content), Math.max(4, width - 16))}`, color.ghost)]
    return [head]
  }

  const user = role === "user"
  const gutter = user ? color.userGutter : color.assistantGutter
  const label = user ? "  YOU" : "  ✦ ZYCRON AI"
  const out = [[span("┃ ", gutter), span(label, user ? color.blueBold : color.violetBold)]]

  const inner = Math.max(6, width - 4)
  if (user) {
    const body = wrapSpans([span(content, color.text)], inner)
    for (const part of body.length ? body : [[]]) out.push([span("┃ ", gutter), span("  ", ""), ...part])
  } else {
    const rendered = renderMarkdown(content, inner, { base: color.text })
    for (const part of rendered.lines) out.push([span("┃ ", gutter), span("  ", ""), ...part])
    if (message.streaming && !content) {
      out.push([span("┃ ", gutter), span("  ", ""), span(state.spinner || "▍", color.violet)])
    }
  }

  const tools = Array.isArray(message.toolCalls) ? message.toolCalls : []
  for (const call of tools) {
    const fn = call?.function || call || {}
    const name = fn.name || "tool"
    const summary = toolSummary(name, safeArgs(fn.arguments))
    out.push([span("┃ ", gutter), span("  ⟡ ", color.faint), span(name, color.cyan), span(summary ? `  ${truncate(summary, Math.max(4, inner - 4))}` : "", color.ghost)])
  }
  return out
}

function streamBlock(state, width) {
  const gutter = color.assistantGutter
  const out = [[span("┃ ", gutter), span("  ✦ ZYCRON AI", color.violetBold)]]
  const inner = Math.max(6, width - 4)
  if (state.streamingText) {
    const rendered = renderMarkdown(state.streamingText, inner, { base: color.text })
    for (const part of rendered.lines) out.push([span("┃ ", gutter), span("  ", ""), ...part])
  }
  if (state.thinking) {
    const thought = wrapSpans([span(state.thinking, color.faint)], inner)
    for (const part of thought) out.push([span("┃ ", gutter), span("  ", ""), ...part.map((entry) => ({ ...entry, s: color.faint }))])
  }
  out.push([span("┃ ", gutter), span(`  ${state.spinner || "▍"}`, color.violet)])
  return out
}

function safeArgs(value) {
  if (value && typeof value === "object") return value
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function preview(text) {
  return String(text ?? "").split("\n").find((line) => line.trim()) || ""
}

function drawChat(grid, lines, x, y, width, height, state) {
  const total = lines.length
  const maxScroll = Math.max(0, total - height)
  const scroll = Math.max(0, Math.min(maxScroll, state.scroll || 0))
  const start = Math.max(0, total - height - scroll)
  for (let i = 0; i < height; i++) {
    const line = lines[start + i]
    if (!line) continue
    grid.putSpans(x, y + i, line, width)
  }
  if (start > 0) {
    const hint = span(`↑ ${start} more`, color.ghost)
    grid.putSpans(x + width - spansWidth([hint]), y, [hint], width)
  }
}

function drawTask(grid, state, x, y, width) {
  const mode = state.conversation?.mode || state.mode || "build"
  const label = state.taskLabel || "Thinking"
  grid.putSpans(x, y, [span("┃ ", color.assistantGutter), span(label, color.muted)], width)
  const meta = [span(modeLabel(mode), MODE_COLORS[mode] || color.violet), span(" · ", color.border), span(state.model || "auto", color.faint)]
  grid.putSpans(x, y + 1, [span("┃ ", color.assistantGutter), ...meta], width)

  const cells = Math.max(6, Math.floor(width * 0.5))
  const phase = state.frame || 0
  const head = phase % (cells + 4)
  const bars = []
  for (let i = 0; i < cells; i++) {
    const on = i <= Math.min(cells - 1, head)
    bars.push(span(on ? "▀" : "▁", on ? color.violet : color.ghost))
  }
  grid.putSpans(x, y + 2, [span("╹", color.assistantGutter), span(" ", ""), ...bars], width)
}

function composerBox(state, width) {
  const boxWidth = Math.max(12, width)
  const text = state.composer || ""
  const inner = Math.max(4, boxWidth - 4)
  const wrapped = wrapComposer(text, inner, state.cursor ?? text.length)
  const maxLines = 6
  const visible = Math.min(maxLines, Math.max(1, wrapped.lines.length))
  return {
    width: boxWidth,
    text,
    inner,
    wrapped,
    maxLines,
    visible,
    height: visible + 2
  }
}

function wrapComposer(text, width, cursor) {
  const lines = [""]
  const positions = [{ row: 0, col: 0 }]
  let used = 0
  let row = 0
  let col = 0
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (i === cursor) positions[0] = { row, col }
    if (ch === "\n") {
      row++
      col = 0
      used = 0
      lines.push("")
      continue
    }
    const w = textWidth(ch)
    if (used + w > width && used > 0) {
      row++
      col = 0
      used = 0
      lines.push("")
    }
    lines[row] += ch
    col += w
    used += w
  }
  if (cursor >= chars.length) positions[0] = { row, col }
  const clamped = Math.min(lines.length - 1, positions[0].row)
  return { lines, cursorRow: clamped, cursorCol: positions[0].row > clamped ? 0 : positions[0].col }
}

function drawComposer(grid, state, box, x, y, width) {
  const top = y
  const left = x
  const right = Math.min(x + width - 1, grid.w - 1)
  grid.put(left, top, "┌", color.border)
  grid.put(right, top, "┐", color.border)
  for (let col = left + 1; col < right; col++) grid.put(col, top, "─", color.border)

  const bottom = top + box.height - 1
  grid.put(left, bottom, "└", color.border)
  grid.put(right, bottom, "┘", color.border)
  for (let col = left + 1; col < right; col++) grid.put(col, bottom, "─", color.border)
  for (let row = top + 1; row < bottom; row++) {
    grid.put(left, row, "│", color.border)
    grid.put(right, row, "│", color.border)
  }

  const innerX = left + 2
  grid.put(innerX, top + 1, "❯", state.streaming ? color.ghost : color.violet)

  const offset = Math.max(0, box.wrapped.cursorRow - box.visible + 1)
  const lines = box.wrapped.lines.slice(offset, offset + box.visible)
  for (let i = 0; i < box.visible; i++) {
    const text = lines[i] ?? ""
    grid.putSpans(innerX + 2, top + 1 + i, [span(text, state.composer ? color.text : color.ghost)], box.inner)
  }
  if (!state.composer) {
    grid.putSpans(innerX + 2, top + 1, [span("Ask, / for commands, @ for files", color.ghost)], box.inner)
  }

  const promptWidth = 2
  const cursorRow = top + 1 + Math.max(0, box.wrapped.cursorRow - offset)
  const cursorCol = innerX + promptWidth + Math.min(box.inner, box.wrapped.cursorCol)
  return { x: Math.min(cursorCol, right - 1), y: Math.min(cursorRow, bottom - 1) }
}

function drawStatus(grid, state, y, x, width) {
  const used = Math.max(0, Number(state.tokens) || 0)
  const context = Math.max(1, Number(state.context) || 128000)
  const pct = Math.min(100, Math.round((used / context) * 100))
  const dots = []
  const filled = Math.max(0, Math.min(8, Math.round((pct / 100) * 8)))
  for (let i = 0; i < 8; i++) dots.push(span("⬝", i < filled ? color.violet : color.ghost))
  const hint = state.busy ? "esc interrupt" : "enter send"
  const right = [span(`${formatTokens(used)} (${pct}%)`, color.faint), span("   ctrl+p commands", color.ghost)]
  const left = [span(" ", ""), ...dots, span(`  ${hint}`, color.faint)]

  if (state.toast && Date.now() < (state.toast.until || 0)) {
    const toast = span(truncate(state.toast.text, Math.max(8, width - 12)), color.yellow)
    grid.putSpans(x, y, left, width)
    const px = x + Math.max(spansWidth(left) + 2, Math.floor((width - spansWidth([toast])) / 2))
    if (px + spansWidth([toast]) < x + width - spansWidth(right)) grid.putSpans(px, y, [toast], x + width - px)
    grid.putSpans(x + width - spansWidth(right), y, right, width)
    return
  }

  grid.putSpans(x, y, left, width)
  grid.putSpans(x + width - spansWidth(right), y, right, width)
}

function modalFrame(state, cols, rows, { width = 64, height = 14, title = "" } = {}) {
  const w = Math.max(24, Math.min(width, cols - 4))
  const h = Math.max(6, Math.min(height, rows - 4))
  const x = Math.floor((cols - w) / 2)
  const y = Math.floor((rows - h) / 2)
  return { x, y, w, h, title }
}

function drawModal(grid, state, cols, rows) {
  const modal = state.modal
  if (!modal) return null
  switch (modal.type) {
    case "palette":
      return drawList(grid, state, cols, rows, {
        title: "Commands",
        items: (modal.items || []).map((item) => ({ label: item.label, detail: item.detail || "" })),
        index: modal.index || 0,
        query: modal.query || "",
        empty: "No matching commands"
      })
    case "models":
      return drawList(grid, state, cols, rows, {
        title: modal.title || "Models",
        items: (modal.items || []).map((item) => ({ label: item.label, detail: item.detail || "" })),
        index: modal.index || 0,
        query: modal.query || "",
        empty: "No models"
      })
    case "sessions":
      return drawList(grid, state, cols, rows, {
        title: "Sessions",
        items: (modal.items || []).map((item) => ({ label: item.label, detail: item.detail || "" })),
        index: modal.index || 0,
        query: modal.query || "",
        empty: "No sessions"
      })
    case "projects":
      return drawList(grid, state, cols, rows, {
        title: "Projects",
        items: (modal.items || []).map((item) => ({ label: item.label, detail: item.detail || "" })),
        index: modal.index || 0,
        query: modal.query || "",
        empty: "No projects"
      })
    case "providers":
      return drawList(grid, state, cols, rows, {
        title: "Providers",
        items: (modal.items || []).map((item) => ({ label: item.label, detail: item.detail || "" })),
        index: modal.index || 0,
        query: "",
        empty: "No providers"
      })
    case "help":
      return drawHelp(grid, state, cols, rows)
    case "approval":
      return drawApproval(grid, state, cols, rows)
    case "confirm":
      return drawConfirm(grid, state, cols, rows)
    case "prompt":
      return drawPrompt(grid, state, cols, rows)
    case "form":
      return drawForm(grid, state, cols, rows)
    case "status":
      return drawStatusModal(grid, state, cols, rows)
    case "usage":
      return drawUsageModal(grid, state, cols, rows)
    default:
      return null
  }
}

function drawList(grid, state, cols, rows, { title, items, index, query, empty }) {
  const height = Math.min(rows - 4, Math.max(8, items.length + 5))
  const frame = modalFrame(state, cols, rows, { width: 68, height, title })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title, hint: "esc", border: color.border, titleStyle: color.bright, hintStyle: color.ghost })

  let y = frame.y + 1
  if (query !== undefined) {
    grid.putSpans(frame.x + 2, y, [span("› ", color.violet), span(query || "", color.text)], frame.w - 4)
    y++
  }

  const visible = frame.h - (query !== undefined ? 5 : 4)
  const selected = Math.max(0, Math.min(items.length - 1, index))
  const start = Math.max(0, Math.min(Math.max(0, items.length - visible), selected - Math.floor(visible / 2)))
  const slice = items.slice(start, start + visible)
  if (!slice.length) {
    grid.putSpans(frame.x + 3, y + 1, [span(empty, color.ghost)], frame.w - 6)
  }
  for (let i = 0; i < slice.length; i++) {
    const item = slice[i]
    const active = start + i === selected
    const label = truncate(item.label, Math.max(8, frame.w - 16))
    const spans = [span(active ? "❯ " : "  ", active ? color.violet : color.border), span(label, active ? color.bright : color.muted)]
    if (item.detail) spans.push(span(`  ${truncate(item.detail, Math.max(4, frame.w - textWidth(label) - 12))}`, color.ghost))
    if (active) grid.fill(frame.x + 1, y, frame.w - 2, 1, color.purpleBg)
    grid.putSpans(frame.x + 2, y, spans, frame.w - 4)
    y++
  }

  grid.putSpans(frame.x + 2, frame.y + frame.h - 2, [span("↑↓", color.bright), span(" select   ", color.ghost), span("enter", color.bright), span(" open   ", color.ghost), span("esc", color.bright), span(" close", color.ghost)], frame.w - 4)
  return null
}

function drawHelp(grid, state, cols, rows) {
  const bindings = [
    ["ctrl+p", "command palette"],
    ["ctrl+n", "new session"],
    ["ctrl+k", "sessions"],
    ["ctrl+m", "models"],
    ["ctrl+r", "rename session"],
    ["ctrl+f", "pin session"],
    ["ctrl+e", "export markdown"],
    ["ctrl+y", "copy last reply"],
    ["ctrl+t", "providers / connect"],
    ["ctrl+x", "leader prefix"],
    ["  n / l / m", "new · sessions · models"],
    ["  a / s / c", "providers · status · compact"],
    ["  u / r / b", "undo · redo · sidebar"],
    ["tab", "next mode"],
    ["shift+tab", "previous mode"],
    ["pgup/pgdn", "scroll chat"],
    ["esc", "interrupt / close"],
    ["ctrl+d", "quit"]
  ]
  const height = bindings.length + 6
  const frame = modalFrame(state, cols, rows, { width: 60, height })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title: "Keys", hint: "esc", border: color.border, titleStyle: color.bright, hintStyle: color.ghost })
  let y = frame.y + 2
  for (const [key, label] of bindings) {
    if (y >= frame.y + frame.h - 1) break
    grid.putSpans(frame.x + 3, y, [span(key.padEnd(13), color.bright), span(label, color.muted)], frame.w - 6)
    y++
  }
  return null
}

function drawApproval(grid, state, cols, rows) {
  const modal = state.modal
  const kind = String(modal.kind || "action")
  const payload = modal.payload || {}
  const lines = []
  const title = "Approval required"
  lines.push([span(kind.replaceAll("_", " "), color.yellow)])
  lines.push([])
  const target = payload.path || payload.command || payload.name || payload.from
  if (target) {
    for (const part of wrapSpans([span(String(target), color.text)], 56)) lines.push(part)
  }
  if (payload.to) lines.push([span(`→ ${payload.to}`, color.muted)])
  if (payload.contentPreview) {
    lines.push([])
    for (const part of wrapSpans([span(String(payload.contentPreview).slice(0, 400), color.faint)], 56).slice(0, 4)) lines.push(part)
  }
  if (payload.arguments && !target) {
    for (const part of wrapSpans([span(formatArgs(payload.arguments).slice(0, 400), color.faint)], 56).slice(0, 4)) lines.push(part)
  }
  const height = Math.min(rows - 4, lines.length + 7)
  const frame = modalFrame(state, cols, rows, { width: 64, height })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title, border: color.yellow, titleStyle: color.yellow, hint: "esc deny", hintStyle: color.ghost })
  let y = frame.y + 2
  for (const line of lines) {
    grid.putSpans(frame.x + 3, y, clip(line, frame.w - 6), frame.w - 6)
    y++
  }
  grid.putSpans(frame.x + 3, frame.y + frame.h - 2, [span("y", color.green), span(" allow    ", color.ghost), span("n", color.red), span(" deny    ", color.ghost), span("esc", color.bright), span(" deny", color.ghost)], frame.w - 6)
  return null
}

function drawConfirm(grid, state, cols, rows) {
  const modal = state.modal
  const frame = modalFrame(state, cols, rows, { width: 56, height: 8 })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title: modal.title || "Confirm", border: color.border, titleStyle: color.bright, hint: "esc cancel", hintStyle: color.ghost })
  const text = wrapSpans([span(modal.message || "", color.text)], frame.w - 6)
  for (let i = 0; i < text.length && i < 3; i++) grid.putSpans(frame.x + 3, frame.y + 2 + i, text[i], frame.w - 6)
  grid.putSpans(frame.x + 3, frame.y + frame.h - 2, [span("y", color.green), span(" yes    ", color.ghost), span("n", color.red), span(" no", color.ghost)], frame.w - 6)
  return null
}

function drawPrompt(grid, state, cols, rows) {
  const modal = state.modal
  const frame = modalFrame(state, cols, rows, { width: 60, height: 8 })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title: modal.title || "Input", border: color.border, titleStyle: color.bright, hint: "enter save", hintStyle: color.ghost })
  const value = String(modal.value ?? "")
  const width = frame.w - 6
  const cursor = Math.min(value.length, width - 1)
  const shown = truncate(value, width - 10)
  grid.putSpans(frame.x + 3, frame.y + 2, [span("› ", color.violet), span(shown, color.text)], width)
  grid.putSpans(frame.x + 3, frame.y + 4, [span(modal.hint || "", color.ghost)], width)
  return { x: frame.x + 5 + cursor, y: frame.y + 2 }
}

function drawForm(grid, state, cols, rows) {
  const modal = state.modal
  const fields = modal.fields || []
  const height = Math.min(rows - 4, fields.length * 2 + 6)
  const frame = modalFrame(state, cols, rows, { width: 66, height })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title: modal.title || "Provider", border: color.border, titleStyle: color.bright, hint: "tab next", hintStyle: color.ghost })
  let y = frame.y + 2
  const valueWidth = frame.w - 12
  let cursor = null
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const active = i === (modal.index || 0)
    grid.putSpans(frame.x + 3, y, [span(field.label, active ? color.bright : color.faint)], frame.w - 6)
    const value = String(field.value ?? "")
    const shown = field.masked && value ? "•".repeat(Math.min(value.length, valueWidth)) : value
    if (active) grid.fill(frame.x + 3, y + 1, frame.w - 6, 1, color.purpleBg)
    grid.putSpans(frame.x + 4, y + 1, [span(truncate(shown, valueWidth), value ? color.text : color.ghost)], valueWidth)
    if (field.masked && !value) grid.putSpans(frame.x + 4, y + 1, [span(field.hint || "not set", color.ghost)], valueWidth)
    if (active) cursor = { x: frame.x + 4 + Math.min(String(value).length, valueWidth - 1), y: y + 1 }
    y += 2
  }
  grid.putSpans(frame.x + 3, frame.y + frame.h - 2, [span("enter", color.bright), span(" save   ", color.ghost), span("esc", color.bright), span(" cancel", color.ghost)], frame.w - 6)
  return cursor
}

function drawStatusModal(grid, state, cols, rows) {
  const info = state.appInfo || {}
  const conversation = state.conversation || {}
  const lines = [
    ["version", info.version || ""],
    ["workspace", info.workspace || ""],
    ["session", conversation.title || "New chat"],
    ["mode", modeLabel(conversation.mode || state.mode)],
    ["model", state.model || "auto"],
    ["project", conversation.projectId || "none"],
    ["messages", String((state.messages || []).length)],
    ["tokens", `${formatTokens(state.tokens || 0)} / ${formatTokens(state.context || 0)}`]
  ]
  const frame = modalFrame(state, cols, rows, { width: 62, height: lines.length + 6 })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title: "Status", border: color.border, titleStyle: color.bright, hint: "esc", hintStyle: color.ghost })
  let y = frame.y + 2
  for (const [label, value] of lines) {
    grid.putSpans(frame.x + 3, y, [span(label.padEnd(11), color.faint), span(truncate(String(value), frame.w - 18), color.text)], frame.w - 6)
    y++
  }
  return null
}

function drawUsageModal(grid, state, cols, rows) {
  const usage = state.usage || {}
  const today = usage.today || {}
  const month = usage.month || {}
  const lines = [
    ["today", `${formatTokens((today.tokens_in || 0) + (today.tokens_out || 0))} tokens · ${today.requests || 0} requests`],
    ["month", `${formatTokens((month.tokens_in || 0) + (month.tokens_out || 0))} tokens · ${month.requests || 0} requests`],
    ["this chat", `${formatTokens(state.tokens || 0)} tokens`],
    ["context", `${formatTokens(state.context || 0)} window`]
  ]
  const frame = modalFrame(state, cols, rows, { width: 64, height: lines.length + 6 })
  grid.fill(frame.x, frame.y, frame.w, frame.h, "")
  grid.box(frame.x, frame.y, frame.w, frame.h, { title: "Usage", border: color.border, titleStyle: color.bright, hint: "esc", hintStyle: color.ghost })
  let y = frame.y + 2
  for (const [label, value] of lines) {
    grid.putSpans(frame.x + 3, y, [span(label.padEnd(11), color.faint), span(value, color.text)], frame.w - 6)
    y++
  }
  return null
}

