import { truncate } from "./util.js"

const ESC = "\x1b["

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

  banner({ version, cwd, ready, total, configFiles = [], model = "", session = "", messages = 0 }) {
    this.line(`${this.bold(`freecode ${version}`)} ${this.dim("· free models with automatic failover")}`)
    this.line(this.dim(`cwd     ${cwd}`))
    this.line(this.dim(`models  ${ready}/${total} ready`))
    if (model) this.line(this.dim(`model   ${model}`))
    if (session) this.line(this.dim(`session ${session} · ${messages} msgs`))
    if (configFiles.length) this.line(this.dim(`config  ${configFiles.join("  ")}`))
    this.line(this.dim("type /help · /model · /sessions · Ctrl+C stops a reply"))
    this.line()
  }

  setContext({ model = "", session = "" } = {}) {
    this.context = { model, session }
  }

  startSpinner(label = "thinking") {
    this.stopSpinner(false)
    this.spinLabel = label
    this.streaming = false
    if (!this.interactive) return
    this.spinFrame = 0
    this.spinner = setInterval(() => {
      if (this.streaming) return
      this.spinFrame = (this.spinFrame + 1) % 4
      const frame = ["-", "\\", "|", "/"][this.spinFrame]
      this.write(`\r${ESC}2K${this.dim(`${frame} ${this.spinLabel}`)}`)
    }, 120)
    this.spinner.unref?.()
  }

  stopSpinner(clear = true) {
    if (this.spinner) {
      clearInterval(this.spinner)
      this.spinner = null
    }
    if (clear && this.interactive) this.write(`\r${ESC}2K`)
  }

  delta(text) {
    this.stopSpinner()
    if (!this.streaming) {
      this.streaming = true
      this.write("\n")
    }
    this.write(text)
  }

  endStream() {
    if (this.streaming) {
      this.write("\n")
      this.streaming = false
      return
    }
    this.stopSpinner()
  }

  retry({ entry, reason, waitMs } = {}) {
    this.endStream()
    const label = entry?.id || "model"
    const cooldown = waitMs > 1000 ? ` (${Math.round(waitMs / 1000)}s cooldown)` : ""
    this.line(this.yellow(`! ${label}: ${reason}${cooldown}`))
    if (this.spinLabel) this.startSpinner(this.spinLabel)
  }

  toolCall(name, args = {}) {
    this.endStream()
    this.line(this.dim(`> ${name}${formatArgs(name, args)}`))
  }

  info(text) {
    this.endStream()
    this.line(this.dim(text))
  }

  error(text) {
    this.endStream()
    this.line(this.red(text))
  }

  promptText() {
    const { model, session } = this.context || {}
    const bits = []
    if (model) bits.push(truncate(model, 26))
    if (session) bits.push(`s:${session.slice(-4)}`)
    return bits.length ? `freecode [${bits.join(" · ")}] › ` : "freecode › "
  }

  ask() {
    return new Promise((resolve) => {
      if (!this.rl || this.rl.closed) {
        resolve(null)
        return
      }
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        this.rl.removeListener("close", onClose)
        resolve(value)
      }
      const onClose = () => finish(null)
      this.rl.once("close", onClose)
      this.rl.question(this.promptText(), (answer) => finish(answer))
    })
  }

  close() {
    this.stopSpinner()
    if (this.rl && !this.rl.closed) this.rl.close()
  }
}
