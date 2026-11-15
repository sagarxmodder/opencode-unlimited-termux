import { truncate } from "./util.js"

const ESC = "\x1b["
const WIDTH = 58
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function formatArgs(name, args = {}) {
  const key = {
    read: "path",
    write: "path",
    edit: "path",
    glob: "pattern",
    grep: "pattern",
    bash: "command",
    webfetch: "url"
  }[name]
  const value = key && args ? args[key] : ""
  if (!value) return ""
  return `(${truncate(String(value).replace(/\s+/g, " "), 90)})`
}

export class UI {
  constructor({ stdout = process.stdout, stdin = process.stdin, color = null } = {}) {
    this.stdout = stdout
    this.stdin = stdin
    this.interactive = Boolean(stdout.isTTY && stdin.isTTY)
    this.color = color === null
      ? this.interactive && !process.env.NO_COLOR && process.env.TERM !== "dumb"
      : Boolean(color)
    this.spinner = null
    this.spinLabel = ""
    this.spinFrame = 0
    this.streaming = false
    this.assistantOpen = false
    this.assistantModel = ""
    this.rl = null
    this.context = { model: "", session: "" }
  }

  paint(code, text) {
    return this.color ? `${ESC}${code}m${text}${ESC}0m` : text
  }

  dim(text) { return this.paint("2", text) }
  bold(text) { return this.paint("1", text) }
  cyan(text) { return this.paint("36", text) }
  green(text) { return this.paint("32", text) }
  yellow(text) { return this.paint("33", text) }
  red(text) { return this.paint("31", text) }

  write(text) { this.stdout.write(text) }
  line(text = "") { this.write(`${text}\n`) }

  border(left, right, fill = "─") {
    return `${left}${fill.repeat(WIDTH)}${right}`
  }

  banner({ version, cwd, ready, total, configFiles = [], model = "", session = "", messages = 0 }) {
    this.line()
    this.line(this.dim(`  ${this.border("╭", "╮")}`))
    this.line(`    ${this.bold(`freecode ${version}`)} ${this.dim("·  terminal coding agent")}`)
    this.line(`    ${this.dim("free models · automatic failover")}`)
    this.line(this.dim(`  ${this.border("╰", "╯")}`))
    this.line(`    ${this.dim("model")}    ${model || "auto"}`)
    if (session) this.line(`    ${this.dim("session")}  ${session} ${this.dim(`· ${messages} msgs`)}`)
    this.line(`    ${this.dim("cwd")}      ${cwd}`)
    this.line(`    ${this.dim("models")}   ${ready}/${total} ready`)
    if (configFiles.length) this.line(`    ${this.dim("config")}   ${configFiles.join("  ")}`)
    this.line(`    ${this.dim("/help commands · /model switch · /sessions resume · Ctrl+C stops a reply")}`)
    this.line()
  }

  setContext({ model = "", session = "" } = {}) {
    this.context = { model, session }
  }

  inputOpen() {
    const head = "  ╭─ message "
    const fill = Math.max(4, WIDTH + 2 - 12)
    this.line()
    this.line(this.dim(`${head}${"─".repeat(fill)}╮`))
  }

  inputClose() {
    const { model, session } = this.context || {}
    const meta = [
      model ? truncate(model, 24) : "auto",
      session ? `s:${session.slice(-4)}` : ""
    ].filter(Boolean).join(" · ")
    const fill = Math.max(4, WIDTH - 3 - meta.length)
    this.line(this.dim(`  ╰─ ${meta} ${"─".repeat(fill)}╯`))
  }

  startSpinner(label = "thinking") {
    this.stopSpinner(false)
    this.spinLabel = label
    this.spinFrame = 0
    if (!this.interactive) return
    this.spinner = setInterval(() => {
      if (this.streaming) return
      this.spinFrame = (this.spinFrame + 1) % FRAMES.length
      this.write(`\r${ESC}2K${this.dim(`  ${FRAMES[this.spinFrame]} ${this.spinLabel}`)}`)
    }, 90)
    this.spinner.unref?.()
  }

  stopSpinner(clear = true) {
    const had = Boolean(this.spinner)
    if (this.spinner) {
      clearInterval(this.spinner)
      this.spinner = null
    }
    if (clear && this.interactive && had) this.write(`\r${ESC}2K`)
  }

  assistant(model = "assistant") {
    if (this.assistantOpen && this.assistantModel === model) return
    this.endStream()
    this.stopSpinner()
    this.line()
    this.line(`  ${this.cyan("▌")} ${this.dim("assistant")} ${this.dim("·")} ${model}`)
    this.assistantOpen = true
    this.assistantModel = model
  }

  delta(text) {
    this.stopSpinner()
    if (!this.assistantOpen) this.assistant(this.assistantModel || "assistant")
    this.streaming = true
    this.write(text)
  }

  endStream() {
    if (this.streaming) this.write("\n")
    this.streaming = false
    this.assistantOpen = false
    this.assistantModel = ""
    this.stopSpinner()
  }

  retry({ entry, reason, waitMs } = {}) {
    this.endStream()
    const label = entry?.id || "model"
    const cooldown = waitMs > 1000 ? ` (${Math.round(waitMs / 1000)}s cooldown)` : ""
    this.line(`  ${this.yellow("!")} ${this.dim(label)}: ${reason}${this.dim(cooldown)}`)
    if (this.spinLabel) this.startSpinner(this.spinLabel)
  }

  toolCall(name, args = {}) {
    this.endStream()
    this.line(`  ${this.yellow("⚙")} ${name}${this.dim(formatArgs(name, args))}`)
  }

  toolResult(name, ok = true, ms = 0) {
    const mark = ok ? this.green("✓") : this.red("✗")
    const time = ms > 0 ? this.dim(` · ${ms}ms`) : ""
    this.line(`  ${mark} ${this.dim(name)}${time}`)
  }

  done({ model = "", ms = 0, usage = null } = {}) {
    const parts = []
    if (model) parts.push(model)
    if (ms > 0) parts.push(`${(ms / 1000).toFixed(1)}s`)
    if (Number.isFinite(usage?.prompt_tokens)) parts.push(`↑${usage.prompt_tokens}`)
    if (Number.isFinite(usage?.completion_tokens)) parts.push(`↓${usage.completion_tokens}`)
    if (!parts.length) return
    this.line()
    this.line(this.dim(`  ✓ ${parts.join(" · ")}`))
  }

  block(text, paint = (value) => value) {
    for (const line of String(text).split("\n")) this.line(paint(`  ${line}`))
  }

  info(text) {
    this.endStream()
    this.block(text, (value) => this.dim(value))
  }

  error(text) {
    this.endStream()
    this.block(`✗ ${text}`, (value) => this.red(value))
  }

  promptText() {
    return "  │ › "
  }

  close() {
    this.stopSpinner()
    if (this.rl && !this.rl.closed) this.rl.close()
  }
}
