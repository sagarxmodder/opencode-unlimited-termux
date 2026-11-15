import { TOOL_DEFINITIONS, executeTool } from "./tools.js"
import { systemPrompt } from "./prompt.js"
import { AbortedError } from "./util.js"

function sanitize(messages) {
  const out = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || message.role === "system" || message.role === "tool") continue
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const ids = new Set(message.tool_calls.map((call) => call.id))
      const responses = []
      let j = i + 1
      while (j < messages.length && messages[j]?.role === "tool") {
        if (ids.has(messages[j].tool_call_id)) responses.push(messages[j])
        j++
      }
      if (responses.length === ids.size) out.push(message, ...responses)
      i = j - 1
      continue
    }
    out.push(message)
  }
  return out
}

export class Agent {
  constructor({ pool, config, cwd, session, ui = null }) {
    this.pool = pool
    this.config = config
    this.cwd = cwd
    this.session = session
    this.ui = ui
    this.system = systemPrompt({ cwd })
    this.lastModel = null
    this.lastUsage = null
    this.compressLevel = 0
    this.messages = [{ role: "system", content: this.system }, ...sanitize(session.messages)]
  }

  reset() {
    this.messages = [{ role: "system", content: this.system }, ...sanitize(this.session.messages)]
  }

  recordTool(id, content) {
    const message = { role: "tool", tool_call_id: id, content: String(content) }
    this.messages.push(message)
    this.session.append(message)
  }

  compress() {
    const level = Math.min(this.compressLevel++, 2)
    const keep = [12, 6, 3][level]
    const limit = [8000, 4000, 2000][level]
    const trimLimit = Math.max(1000, Math.floor(limit * 0.75))
    const system = this.messages[0]
    const trimmed = this.messages.slice(1).map((message) => {
      if (typeof message.content !== "string" || message.content.length <= limit) return message
      return { ...message, content: `${message.content.slice(0, trimLimit)}\n\n[... truncated to save context ...]` }
    })
    const window = trimmed.slice(-keep)
    const lastUser = [...trimmed].reverse().find((message) => message.role === "user")
    const seed = lastUser && !window.includes(lastUser) ? [lastUser, ...window] : window
    this.messages = [system, ...sanitize(seed)]
  }

  async run(prompt, { signal = null } = {}) {
    const user = { role: "user", content: String(prompt) }
    this.session.append(user)
    this.messages.push(user)
    let steps = 0
    let contextRetries = 0
    while (steps < this.config.maxSteps) {
      if (signal?.aborted) throw new AbortedError()
      this.ui?.startSpinner?.(steps === 0 ? "thinking" : "working")
      let result
      try {
        result = await this.pool.chat({
          messages: this.messages,
          tools: TOOL_DEFINITIONS,
          preferred: this.config.model,
          signal,
          timeoutMs: this.config.timeoutMs,
          onDelta: (delta) => this.ui?.delta?.(delta),
          onStart: (entry) => this.ui?.assistant?.(entry.id),
          onRetry: (info) => this.ui?.retry?.(info)
        })
      } catch (error) {
        if (error?.kind === "context" && contextRetries < 2) {
          contextRetries++
          this.compress()
          this.ui?.info?.("context full — trimming older output and retrying")
          continue
        }
        throw error
      }
      steps++
      this.lastModel = result.entry || null
      this.lastUsage = result.usage || this.lastUsage
      const assistant = { role: "assistant", content: result.content || "" }
      if (result.toolCalls.length) {
        assistant.tool_calls = result.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      }
      this.messages.push(assistant)
      this.session.append(assistant)
      this.ui?.endStream?.()
      if (!result.toolCalls.length) return result.content
      for (let index = 0; index < result.toolCalls.length; index++) {
        const call = result.toolCalls[index]
        if (signal?.aborted) {
          for (const pending of result.toolCalls.slice(index)) {
            this.recordTool(pending.id, "Cancelled by user.")
          }
          throw new AbortedError()
        }
        this.ui?.toolCall?.(call.name, call.arguments)
        const started = Date.now()
        const output = await executeTool(call.name, call.arguments, { cwd: this.cwd })
        this.ui?.toolResult?.(call.name, !String(output).startsWith("Error:"), Date.now() - started)
        this.recordTool(call.id, output)
      }
    }
    throw new Error(`max steps (${this.config.maxSteps}) reached — reply "continue" to keep going`)
  }
}
