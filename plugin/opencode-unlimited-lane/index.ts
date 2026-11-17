// opencode-unlimited-lane — universal plugin: opencode 1.19.5 + opencode 2.x
//
// v1 (<=1.x):  export default factory(input, options) => hooks
// v2 (>=2.0):  export default { id, setup(ctx) }
//
// The runtime major version is read from the executing binary
// (/proc/self/exe -> opencode-<major>.<minor>.<patch>.bin), because both
// builds ship the same argv and the same plugin entrypoint.
//
// Behaviour in both versions:
//   quota / 429 / 5xx     -> rotate WARP /64, retry the same model
//   model unavailable     -> switch to the next free model and continue
//   network reset/timeout -> retry, rotate on repeated hits
//   context wall          -> cap output tokens, handoff, compact
//   stops mid-way         -> resume with a synthetic "continue"

import { appendFileSync, chmodSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

type Options = {
  warnAt?: number
  compactAt?: number
  handoffAt?: number
  cooldownMs?: number
  contextLimit?: number
  maxOutputFloor?: number
  proxyUrl?: string
  maxRetries?: number // 0 = unlimited
  retryCooldownMs?: number
  logFile?: string
  memoryDir?: string
  verbose?: boolean
}

const DEFAULTS = {
  warnAt: 0.55,
  compactAt: 0.65,
  handoffAt: 0.75,
  cooldownMs: 120_000,
  contextLimit: 120_000,
  maxOutputFloor: 4_096,
  proxyUrl: "http://127.0.0.1:8789",
  maxRetries: 0,
  retryCooldownMs: 15_000,
  verbose: false,
}

const CONTEXT_ERROR =
  /maximum context length|requested token count exceeds|too many tokens|context length|prompt is too long|reduce the length of the messages/i

const MODEL_ERROR =
  /model[^.\n]{0,48}(not found|not available|unavailable|does not exist|deactivated|unsupported|disabled)|no access to (this |the )?model|invalid model|unknown model|model_not_found|no such model/i

const QUOTA_ERROR =
  /free usage limit|free usage exceeded|usage exceeded|quota|rate.?limit|too many requests|429|402|503|502|service unavailable|capacity|overloaded|try again later|usage limit|daily limit|limit reached|insufficient|subscribe to|upgrade to/i

// Hard free-tier walls ("Free usage exceeded, subscribe to Go") are account
// scoped, not IP scoped: rotating the exit alone does not help, so the lane
// also switches to the next free model.
const FREE_TIER_ERROR =
  /free usage exceeded|usage exceeded|subscribe to|upgrade to|upgrade your plan|free tier|plan limit|monthly limit|weekly limit|daily limit|per day limit/i

const NETWORK_ERROR =
  /ECONNRESET|ECONNREFUSED|socket|fetch failed|cannot connect to api|network|timeout|timed out|proxy refused|econnaborted|etimedout/i

type Budget = { budget: number; context: number; output: number; providerID: string; modelID: string }
type Usage = { used: number; budget: number; ratio: number; at: number }
type ModelRef = { providerID: string; modelID: string }
type Adapter = {
  kind: "v1" | "v2"
  listProviders(): Promise<any[]>
  messages(sessionID: string): Promise<{ role: string; text: string }[]>
  compact(sessionID: string, providerID: string, modelID: string): Promise<any>
  abort(sessionID: string): Promise<any>
  continue(sessionID: string, model?: ModelRef): Promise<any>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function providersFrom(res: any): any[] {
  const root = res?.data ?? res
  if (Array.isArray(root)) return root
  if (Array.isArray(root?.providers)) return root.providers
  if (Array.isArray(root?.providers?.data)) return root.providers.data
  return []
}

function errorText(error: any): string {
  if (!error) return ""
  if (typeof error === "string") return error
  const text =
    error?.message ??
    error?.data?.message ??
    error?.error?.message ??
    error?.cause?.message ??
    error?.type ??
    error?.name
  if (text) return String(text)
  try {
    return JSON.stringify(error).slice(0, 400)
  } catch {
    return ""
  }
}

function messageText(parts: any[]): string {
  const out: string[] = []
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") out.push(part.text)
    else if (part.type === "tool") out.push(`[tool ${part.tool ?? "?"}] ${part.state?.title ?? ""}`.trim())
    else if (part.type === "file") out.push(`[file ${part.filename ?? part.url ?? ""}]`.trim())
  }
  return out.join("\n").trim()
}

// ------------------------------------------------------------------ version

function binaryPath(): string {
  try {
    return readlinkSync("/proc/self/exe").replace(/ \(deleted\)$/, "")
  } catch {
    return process.execPath ?? ""
  }
}

function detectMajor(): number {
  for (const path of [binaryPath(), process.execPath ?? ""]) {
    const match = /opencode-(\d+)\.\d+\.\d+\.bin$/.exec(path)
    if (match) return Number(match[1])
    if (/\/opencode-2\.\d+\.\d+\//.test(path) || /oc230/.test(path)) return 2
  }
  if (process.argv.includes("--service")) return 2
  return 1
}

const V2 = detectMajor() >= 2

// ------------------------------------------------------------------- tools

async function resolveV1Tool(): Promise<any> {
  try {
    const mod: any = await import("@opencode-ai/plugin")
    if (typeof mod?.tool === "function") return mod.tool
  } catch {
    // opencode 2.x has no @opencode-ai/plugin; v1 may run without it too
  }
  try {
    const mod: any = await import("zod")
    const z: any = mod?.z ?? mod
    if (typeof z?.string === "function" && typeof z?.object === "function") {
      const tool: any = (def: any) => def
      tool.schema = z
      return tool
    }
  } catch {
    // no zod either: register the lane without tools
  }
  return null
}

// -------------------------------------------------------------------- core

function createCore(adapter: Adapter, options?: Options) {
  const cfg = { ...DEFAULTS, ...(options ?? {}) }
  const home = process.env.HOME ?? ""
  const logFile = options?.logFile ?? (home ? join(home, ".local/share/opencode/unlimited-lane.log") : "")
  const memoryDir = options?.memoryDir ?? (home ? join(home, ".config/opencode/memory") : "")

  const budgets = new Map<string, Budget>()
  const usage = new Map<string, Usage>()
  const compacting = new Set<string>()
  const rotating = new Set<string>()
  const continuing = new Set<string>()
  const lastCompact = new Map<string, number>()
  const lastWarn = new Map<string, number>()
  const lastHandoff = new Map<string, number>()
  const lastRetry = new Map<string, number>()
  const lastNetwork = new Map<string, number>()
  const retries = new Map<string, number>()
  const netRetries = new Map<string, number>()
  const resumes = new Map<string, number>()
  const currentModel = new Map<string, ModelRef>()

  let modelCache: { at: number; list: ModelRef[] } | null = null
  let recycling: Promise<boolean> | null = null

  const log = (line: string) => {
    if (cfg.verbose) process.stderr.write(`unlimited-lane: ${line}\n`)
    if (!logFile) return
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`)
    } catch {}
  }

  const describe = (model: ModelRef | null | undefined) =>
    model ? `${model.providerID}/${model.modelID}` : "?"

  const rank = (id: string) =>
    /deepseek/i.test(id) ? 0 : /glm/i.test(id) ? 1 : /flint|minimax|beam/i.test(id) ? 2 : 3

  function listFreeModels(providers: any[]): ModelRef[] {
    const out: ModelRef[] = []
    for (const provider of providers) {
      const providerID = provider?.id ?? provider?.providerID ?? provider?.name
      if (!providerID) continue
      const models = provider?.models
      const entries: [string, any][] =
        models instanceof Map
          ? [...models.entries()]
          : models && typeof models === "object"
            ? Object.entries(models)
            : []
      for (const [modelID, info] of entries) {
        const cost = info?.cost
        const free =
          /-free$/i.test(modelID) ||
          info?.free === true ||
          (cost !== undefined && Number(cost?.input ?? 0) === 0 && Number(cost?.output ?? 0) === 0)
        if (free) out.push({ providerID, modelID })
      }
    }
    return out.sort(
      (a, b) => rank(a.modelID) - rank(b.modelID) || a.modelID.localeCompare(b.modelID),
    )
  }

  async function freeFor(): Promise<ModelRef[]> {
    if (modelCache && Date.now() - modelCache.at < 300_000) return modelCache.list
    try {
      const list = listFreeModels(await adapter.listProviders())
      if (list.length) modelCache = { at: Date.now(), list }
      return list
    } catch (error) {
      log(`provider list failed: ${errorText(error)}`)
      return modelCache?.list ?? []
    }
  }

  function setBudget(sessionID: string, model: ModelRef, limit?: { context?: number; output?: number }) {
    const context = Math.max(1, Number(limit?.context ?? cfg.contextLimit))
    const output = Math.max(
      cfg.maxOutputFloor,
      Number(limit?.output ?? Math.min(8_000, Math.floor(context / 4))),
    )
    const budget = Math.max(1, context - Math.max(output, cfg.maxOutputFloor))
    const value: Budget = {
      budget,
      context,
      output,
      providerID: model.providerID,
      modelID: model.modelID,
    }
    budgets.set(sessionID, value)
    currentModel.set(sessionID, model)
    return value
  }

  function trackUsage(sessionID: string, used: number): Usage {
    const budget = budgets.get(sessionID)?.budget ?? cfg.contextLimit
    const value: Usage = {
      used,
      budget,
      ratio: budget > 0 ? used / budget : 0,
      at: Date.now(),
    }
    usage.set(sessionID, value)
    return value
  }

  async function nextFreeModel(sessionID: string): Promise<ModelRef | null> {
    const list = await freeFor()
    if (!list.length) return null
    const current = currentModel.get(sessionID)
    if (!current) return list[0]
    const index = list.findIndex(
      (item) => item.providerID === current.providerID && item.modelID === current.modelID,
    )
    const next = index < 0 ? list[0] : list[(index + 1) % list.length]
    if (next.providerID === current.providerID && next.modelID === current.modelID) return null
    return next
  }

  async function rotateWarp(reason: string): Promise<boolean> {
    if (!cfg.proxyUrl) return false
    if (recycling) return recycling
    recycling = (async () => {
      try {
        log(`recycling WARP pool (${reason})`)
        const res = await fetch(`${cfg.proxyUrl}/recycle`, {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
        })
        await res.text().catch(() => "")
        if (!res.ok) {
          log(`recycle rejected: HTTP ${res.status}`)
          return false
        }
        await sleep(1_500)
        log("WARP pool recycled")
        return true
      } catch (error) {
        log(`recycle failed: ${errorText(error)}`)
        return false
      } finally {
        recycling = null
      }
    })()
    return recycling
  }

  async function writeHandoff(sessionID: string, reason: string): Promise<string | null> {
    if (!memoryDir) return null
    const now = Date.now()
    if (now - (lastHandoff.get(sessionID) ?? 0) < cfg.cooldownMs) return null
    lastHandoff.set(sessionID, now)
    let entries: { role: string; text: string }[] = []
    try {
      entries = await adapter.messages(sessionID)
    } catch (error) {
      log(`handoff read failed: ${errorText(error)}`)
    }
    const state = usage.get(sessionID)
    const lines = [
      "# unlimited-lane handoff",
      "",
      `- session: ${sessionID}`,
      `- reason: ${reason}`,
      `- model: ${describe(currentModel.get(sessionID))}`,
      `- usage: ${
        state ? `${state.used}/${state.budget} (${(state.ratio * 100).toFixed(1)}%)` : "unknown"
      }`,
      `- written: ${new Date(now).toISOString()}`,
      "",
      "## tail",
      "",
    ]
    for (const item of entries.slice(-40)) {
      lines.push(`### ${item.role}`, "", item.text.slice(0, 4_000), "")
    }
    const path = join(memoryDir, `unlimited-handoff-${sessionID.replace(/[^\w.-]/g, "_")}.md`)
    try {
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(path, lines.join("\n"))
      log(`handoff written: ${path}`)
      return path
    } catch (error) {
      log(`handoff write failed: ${errorText(error)}`)
      return null
    }
  }

  async function compact(sessionID: string, reason: string, force = false): Promise<boolean> {
    if (compacting.has(sessionID)) return false
    const now = Date.now()
    if (!force && now - (lastCompact.get(sessionID) ?? 0) < cfg.cooldownMs) return false
    compacting.add(sessionID)
    lastCompact.set(sessionID, now)
    const model = currentModel.get(sessionID)
    try {
      log(`compacting (${reason})`)
      await adapter.abort(sessionID)
      await sleep(250)
      await writeHandoff(sessionID, reason)
      await adapter.compact(sessionID, model?.providerID ?? "", model?.modelID ?? "")
      return true
    } catch (error) {
      log(`compact failed: ${errorText(error)}`)
      return false
    } finally {
      compacting.delete(sessionID)
    }
  }

  async function continueSession(sessionID: string, model?: ModelRef): Promise<boolean> {
    if (continuing.has(sessionID)) return false
    continuing.add(sessionID)
    try {
      const target = model ?? currentModel.get(sessionID)
      log(`resuming session${target ? ` on ${describe(target)}` : ""}`)
      await adapter.continue(sessionID, target ?? undefined)
      return true
    } catch (error) {
      log(`resume failed: ${errorText(error)}`)
      return false
    } finally {
      continuing.delete(sessionID)
    }
  }

  async function switchToNext(sessionID: string, reason: string): Promise<ModelRef | null> {
    if (rotating.has(sessionID)) return null
    rotating.add(sessionID)
    try {
      const next = await nextFreeModel(sessionID)
      if (!next) {
        log(`no free model available (${reason})`)
        return null
      }
      log(`switching ${describe(currentModel.get(sessionID))} -> ${describe(next)} (${reason})`)
      currentModel.set(sessionID, next)
      await adapter.continue(sessionID, next)
      return next
    } catch (error) {
      log(`switch failed: ${errorText(error)}`)
      return null
    } finally {
      rotating.delete(sessionID)
    }
  }

  async function handleFailure(
    sessionID: string,
    error: any,
    assistantMessageID?: string,
  ): Promise<"retry" | "handoff" | "none"> {
    const text = errorText(error)
    if (!text) return "none"
    const now = Date.now()

    if (NETWORK_ERROR.test(text) && !QUOTA_ERROR.test(text) && !MODEL_ERROR.test(text)) {
      const hits = (netRetries.get(sessionID) ?? 0) + 1
      netRetries.set(sessionID, hits)
      if (now - (lastNetwork.get(sessionID) ?? 0) < 5_000) return "none"
      lastNetwork.set(sessionID, now)
      log(`network hiccup #${hits}: ${text.slice(0, 160)}`)
      if (hits % 2 === 0) await rotateWarp("network")
      await continueSession(sessionID)
      return "retry"
    }

    if (MODEL_ERROR.test(text) || FREE_TIER_ERROR.test(text)) {
      log(`model wall: ${text.slice(0, 160)}`)
      const next = await switchToNext(sessionID, "model wall")
      if (next) return "retry"
      const rotated = await rotateWarp("model wall")
      await continueSession(sessionID)
      return rotated ? "retry" : "none"
    }

    if (CONTEXT_ERROR.test(text)) {
      log(`context wall${assistantMessageID ? ` after ${assistantMessageID}` : ""}: ${text.slice(0, 160)}`)
      await compact(sessionID, "context wall", true)
      await continueSession(sessionID)
      return "handoff"
    }

    if (QUOTA_ERROR.test(text)) {
      const hits = (retries.get(sessionID) ?? 0) + 1
      retries.set(sessionID, hits)
      log(`quota/rate wall #${hits}: ${text.slice(0, 160)}`)
      if (cfg.maxRetries > 0 && hits > cfg.maxRetries) {
        const next = await switchToNext(sessionID, "quota exhausted")
        return next ? "retry" : "none"
      }
      if (now - (lastRetry.get(sessionID) ?? 0) < cfg.retryCooldownMs) return "none"
      lastRetry.set(sessionID, now)
      if (FREE_TIER_ERROR.test(text)) {
        const next = await switchToNext(sessionID, "free tier")
        if (next) return "retry"
      }
      const rotated = await rotateWarp("quota")
      await continueSession(sessionID)
      return rotated ? "retry" : "none"
    }

    if (cfg.verbose) log(`unhandled error: ${text.slice(0, 160)}`)
    return "none"
  }

  const pick = (args: any, ctx: any) =>
    String(args?.session_id ?? args?.sessionID ?? ctx?.sessionID ?? ctx?.session?.id ?? "")

  const budgetLine = (sessionID: string) => {
    const known = budgets.get(sessionID)
    return known
      ? `context ${known.context}, output ${known.output}, usable ${known.budget}`
      : `context ${cfg.contextLimit}, output floor ${cfg.maxOutputFloor}`
  }

  function toolDefs() {
    return [
      {
        name: "token_status",
        description: "Report the unlimited-lane token budget and the last usage ratio for this session.",
        property: ["session_id", "optional session id; defaults to the current session"],
        async run(args: any, ctx: any) {
          const sessionID = pick(args, ctx)
          const state = usage.get(sessionID)
          const rows = [...usage.entries()].map(
            ([id, item]) => `- ${id}: ${item.used}/${item.budget} (${(item.ratio * 100).toFixed(1)}%)`,
          )
          return [
            `session: ${sessionID || "?"}`,
            `budget: ${budgetLine(sessionID)}`,
            `model: ${describe(currentModel.get(sessionID))}`,
            `last usage: ${
              state
                ? `${state.used} tokens at ${(state.ratio * 100).toFixed(1)}% (${new Date(state.at).toISOString()})`
                : "none"
            }`,
            `sessions:\n${rows.length ? rows.join("\n") : "- none yet"}`,
          ].join("\n")
        },
      },
      {
        name: "free_models",
        description: "List the free models the lane can rotate to, in switch order.",
        property: ["session_id", "optional session id used to mark the current model"],
        async run(args: any, ctx: any) {
          const sessionID = pick(args, ctx)
          const list = await freeFor()
          if (!list.length) return "no free models discovered"
          const current = currentModel.get(sessionID)
          return list
            .map((item, index) => {
              const mark =
                current &&
                current.providerID === item.providerID &&
                current.modelID === item.modelID
                  ? " (current)"
                  : ""
              return `${index + 1}. ${describe(item)}${mark}`
            })
            .join("\n")
        },
      },
      {
        name: "handoff",
        description: "Write a markdown handoff of the last messages into the opencode memory directory.",
        property: ["session_id", "optional session id; defaults to the current session"],
        async run(args: any, ctx: any) {
          const sessionID = pick(args, ctx)
          if (!sessionID) return "no session id"
          lastHandoff.delete(sessionID)
          const path = await writeHandoff(sessionID, "manual handoff")
          return path ? `handoff written: ${path}` : "handoff not written (memory dir unavailable)"
        },
      },
      {
        name: "compact_now",
        description: "Abort the running step and compact this session immediately.",
        property: ["session_id", "optional session id; defaults to the current session"],
        async run(args: any, ctx: any) {
          const sessionID = pick(args, ctx)
          if (!sessionID) return "no session id"
          const ok = await compact(sessionID, "manual compact", true)
          return ok ? "compaction requested" : "compaction skipped (already running or failed)"
        },
      },
    ]
  }

  function estimateTokens(message: any): number {
    const info = message?.info ?? {}
    const t = info?.tokens
    if (t && typeof t === "object") {
      const used =
        (t.input ?? 0) +
        (t.output ?? 0) +
        (t.reasoning ?? 0) +
        (t.cache?.read ?? 0) +
        (t.cache?.write ?? 0)
      if (Number.isFinite(used) && used > 0) return Number(used)
    }
    return Math.ceil(messageText(message?.parts ?? []).length / 4) + 8
  }

  // Pre-flight guard. The provider rejects the whole request when the prompt is
  // longer than the window, so messages are trimmed before they are sent: the
  // newest turns plus the task anchor survive, the middle is elided.
  function fitMessages(sessionID: string, messages: any[]): number {
    if (!Array.isArray(messages) || messages.length === 0) return 0
    const budget = budgets.get(sessionID)
    const limit = Math.max(2_048, budget?.context ?? cfg.contextLimit)
    const reserve = Math.max(budget?.output ?? cfg.maxOutputFloor, cfg.maxOutputFloor)
    const room = Math.max(1_024, limit - reserve)
    const sizes = messages.map((message) => estimateTokens(message))
    const total = sizes.reduce((sum, size) => sum + size, 0)
    if (total <= room * 0.92) return total

    const keep: number[] = []
    let used = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const size = sizes[index]
      if (keep.length > 0 && used + size > room) break
      if (keep.length === 0 && size > room) {
        const message = messages[index]
        const parts: any[] = Array.isArray(message?.parts)
          ? message.parts.filter((part: any) => part?.type === "text")
          : []
        const text = parts.map((part: any) => String(part.text ?? "")).join("\n")
        const keepChars = Math.max(2_000, Math.floor(room * 4 - 4_000))
        message.parts = [
          {
            type: "text",
            text: `[unlimited-lane: earlier text elided to fit the context window]\n${text.slice(-keepChars)}`,
          },
        ]
        keep.unshift(index)
        used = Math.ceil(keepChars / 4) + 64
        break
      }
      keep.unshift(index)
      used += size
      if (index === 0) break
    }

    if (keep.length > 0 && keep[0] > 0) {
      const anchor = sizes[0]
      if (used + anchor <= room) {
        keep.unshift(0)
        used += anchor
      }
    }

    const kept = new Set(keep)
    const removed = messages.length - kept.size
    const next = messages.filter((_message: any, index: number) => kept.has(index))
    if (next.length === 0) return total

    const first = next[0]
    const parts: any[] = Array.isArray(first?.parts) ? first.parts : []
    const note = `[unlimited-lane: ${removed} older messages dropped so this request fits the model's context window. Continue from the newest messages.]`
    const textPart = parts.find((part: any) => part?.type === "text")
    if (textPart) textPart.text = `${note}\n\n${String(textPart.text ?? "")}`
    else first.parts = [{ type: "text", text: note }, ...parts]

    messages.length = 0
    for (const message of next) messages.push(message)
    log(`trimmed ${sessionID}: dropped ${removed} messages, ~${used}/${room} tokens in (was ${total})`)
    return used
  }

  function needsCompact(sessionID: string): boolean {
    const state = usage.get(sessionID)
    return Boolean(state && state.ratio >= cfg.compactAt)
  }

  return {
    cfg,
    log,
    budgets,
    usage,
    currentModel,
    setBudget,
    trackUsage,
    fitMessages,
    needsCompact,
    freeFor,
    nextFreeModel,
    rotateWarp,
    writeHandoff,
    compact,
    continueSession,
    switchToNext,
    handleFailure,
    toolDefs,
    canResume: (sessionID: string) => (resumes.get(sessionID) ?? 0) < 3,
    noteResume: (sessionID: string) => resumes.set(sessionID, (resumes.get(sessionID) ?? 0) + 1),
    resetResume: (sessionID: string) => resumes.delete(sessionID),
  }
}

type Core = ReturnType<typeof createCore>

// --------------------------------------------------- shared event handling

async function handleEvent(core: Core, event: any): Promise<void> {
  if (!event || typeof event !== "object") return
  const props = event.properties ?? event.data ?? {}
  const retryData = props.data ?? props
  const sessionID: string | undefined =
    props.sessionID ?? props.info?.sessionID ?? retryData?.sessionID ?? props.part?.sessionID
  if (!sessionID) return

  const type = String(event.type ?? "")
  if (type === "session.compacted" || type === "session.compaction.finished") {
    core.usage.delete(sessionID)
    core.resetResume(sessionID)
    core.log(`compaction finished for ${sessionID}`)
    return
  }

  if (type === "session.status" || type === "session.retry.scheduled") {
    const status = type === "session.status" ? props.status : retryData
    if (!status) return
    if (type === "session.status" && status.type !== "retry") return
    const message = String(
      status.message ??
        status.action?.reason ??
        status.action?.message ??
        status.error?.data?.message ??
        status.error?.message ??
        "",
    )
    if (!QUOTA_ERROR.test(message)) return
    core.log(`retry loop on ${sessionID} (attempt ${status.attempt ?? "?"}): ${message.slice(0, 120)}`)
    await core.handleFailure(sessionID, message)
    return
  }

  if (type === "session.error") {
    const message = String(props.error?.data?.message ?? props.error?.message ?? props.error?.name ?? "")
    if (props.error?.data?.providerID && props.error?.data?.modelID) {
      core.currentModel.set(sessionID, {
        providerID: props.error.data.providerID,
        modelID: props.error.data.modelID,
      })
    }
    await core.handleFailure(sessionID, message)
    return
  }

  const applyUsage = async (
    used: number,
    model: ModelRef | null,
    limit?: { context?: number; output?: number },
  ) => {
    if (used < 1_000) return
    if (model) core.setBudget(sessionID, model, limit)
    const state = core.trackUsage(sessionID, used)
    if (state.ratio >= core.cfg.warnAt) {
      core.log(`usage ${sessionID} ${used}/${state.budget} (${(state.ratio * 100).toFixed(1)}%)`)
    }
    if (state.ratio >= core.cfg.handoffAt) {
      await core.writeHandoff(sessionID, "automatic: context almost full")
    }
    if (state.ratio >= core.cfg.compactAt) {
      await core.compact(sessionID, `${(state.ratio * 100).toFixed(1)}% full`)
    }
  }

  if (type === "session.usage.updated") {
    const usage = props.usage ?? props.tokens ?? props.info?.tokens ?? retryData?.tokens ?? {}
    const used =
      Number(usage.total ?? usage.used ?? 0) ||
      (usage.input ?? 0) +
        (usage.output ?? 0) +
        (usage.reasoning ?? 0) +
        (usage.cache?.read ?? 0) +
        (usage.cache?.write ?? 0)
    const info = props.info ?? {}
    const modelRef = props.model ?? info.model ?? {}
    const providerID = props.providerID ?? info.providerID ?? modelRef.providerID
    const modelID = props.modelID ?? info.modelID ?? modelRef.modelID ?? modelRef.id
    const model: ModelRef | null =
      providerID && modelID ? { providerID, modelID } : core.currentModel.get(sessionID) ?? null
    const limit = props.limit ?? info.limit ?? modelRef.limit ?? {}
    await applyUsage(used, model, {
      context: Number(limit.context ?? 0) || undefined,
      output: Number(limit.output ?? 0) || undefined,
    })
    return
  }

  if (type !== "message.updated") return
  const info = props.info
  if (!info || info.role !== "assistant") return

  const failure = String(info.error?.data?.message ?? info.error?.data?.error ?? "")
  if (failure) {
    if (info.providerID && info.modelID) {
      core.currentModel.set(sessionID, { providerID: info.providerID, modelID: info.modelID })
    }
    await core.handleFailure(sessionID, failure, info.id)
    return
  }
  if (info.summary) return

  const tokens = info.tokens
  if (!tokens) return
  const used =
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  const model: ModelRef | null =
    info.providerID && info.modelID
      ? { providerID: info.providerID, modelID: info.modelID }
      : core.currentModel.get(sessionID) ?? null
  await applyUsage(used, model, {
    context: Number(info.limit?.context ?? info.model?.limit?.context ?? 0) || undefined,
    output: Number(info.limit?.output ?? info.model?.limit?.output ?? 0) || undefined,
  })
}

// ------------------------------------------------------ v1: opencode <= 1.x

async function v1Factory(input: any, rawOptions?: Options) {
  const client = input?.client ?? {}
  const directory = input?.directory ?? process.cwd()

  const adapter: Adapter = {
    kind: "v1",
    async listProviders() {
      const res = await client.config.providers()
      return providersFrom(res)
    },
    async messages(sessionID) {
      const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
      const list = res?.data ?? res ?? []
      return (Array.isArray(list) ? list : []).map((item: any) => ({
        role: item?.info?.role ?? item?.role ?? "?",
        text: messageText(item?.parts ?? item?.content ?? []),
      }))
    },
    async compact(sessionID, providerID, modelID) {
      return client.session.summarize({
        path: { id: sessionID },
        body: { providerID, modelID },
        query: { directory },
      })
    },
    async abort(sessionID) {
      return client.session.abort({ path: { id: sessionID }, query: { directory } })
    },
    async continue(sessionID, model) {
      return client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: "continue", synthetic: true }],
          ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        },
        query: { directory },
      })
    },
  }

  const core = createCore(adapter, rawOptions ?? {})

  const buildTools = async () => {
    const tool = await resolveV1Tool()
    if (!tool) return undefined
    const schema = tool.schema
    const out: Record<string, any> = {}
    for (const def of core.toolDefs()) {
      const [name, hint] = def.property ?? []
      let args: any = {}
      if (name && schema?.string) {
        try {
          args = { [name]: schema.string().describe(hint ?? "").optional() }
        } catch {
          args = {}
        }
      }
      out[def.name] = tool({
        description: def.description,
        args,
        async execute(input: any, context: any) {
          return def.run({ ...(input ?? {}), sessionID: context?.sessionID }, context ?? {})
        },
      })
    }
    return out
  }

  const tools = await buildTools()
  const hooks: Record<string, any> = {
    async event({ event }: any) {
      try {
        await handleEvent(core, event)
      } catch (error) {
        core.log(`event handler failed: ${errorText(error)}`)
      }
    },

    async "chat.params"(params: any, output: any) {
      try {
        const sessionID: string | undefined = params?.sessionID
        const model = params?.model
        if (!sessionID || !model?.providerID || !model?.id) return
        core.setBudget(
          sessionID,
          { providerID: model.providerID, modelID: model.id },
          model.limit?.context
            ? { context: Number(model.limit.context), output: Number(model.limit.output) || undefined }
            : undefined,
        )
        const state = core.usage.get(sessionID)
        const budget = core.budgets.get(sessionID)
        if (!budget) return
        const remaining = budget.context - (state?.used ?? 0)
        const cap = Math.max(1_024, Math.min(budget.output, remaining - 1_024))
        if (!Number.isFinite(cap) || cap <= 0) return
        if (typeof output?.maxOutputTokens !== "number" || output.maxOutputTokens > cap) {
          output.maxOutputTokens = cap
        }
        if (core.cfg.verbose) {
          core.log(`chat.params ${sessionID}: used=${state?.used ?? 0} ctx=${budget.context} out=${budget.output} cap=${cap}`)
        }
      } catch (error) {
        core.log(`chat.params failed: ${errorText(error)}`)
      }
    },

    // The real context wall: the request itself is too big before the model
    // ever answers. Trim here so the provider never sees an oversized prompt.
    async "experimental.chat.messages.transform"(params: any, output: any) {
      try {
        const messages: any[] = Array.isArray(output?.messages) ? output.messages : []
        if (messages.length === 0) return
        const sessionID: string =
          params?.sessionID ?? output?.sessionID ?? messages[messages.length - 1]?.info?.sessionID ?? ""
        if (!sessionID) return
        if (!core.budgets.has(sessionID)) {
          const info = messages[messages.length - 1]?.info ?? {}
          const providerID = info.providerID
          const modelID = info.modelID ?? info.model?.id
          if (providerID && modelID) core.setBudget(sessionID, { providerID, modelID })
        }
        if (core.cfg.verbose) core.log(`messages.transform ${sessionID}: ${messages.length} msgs`)
        core.fitMessages(sessionID, messages)
      } catch (error) {
        core.log(`message trim failed: ${errorText(error)}`)
      }
    },

    // Compaction only swaps what the model sees for a summary; these two hooks
    // protect task state and resume the task automatically afterwards.
    async "experimental.session.compacting"(_input: any, output: any) {
      try {
        output.context.push(
          "Preserve every user decision, file path, command, error, and next step. Never drop task state.",
        )
      } catch {}
    },

    async "experimental.compaction.autocontinue"(_input: any, output: any) {
      output.enabled = true
    },
  }

  if (tools) hooks.tool = tools
  core.log(`v1 lane ready (tools: ${tools ? Object.keys(tools).length : 0}, verbose: ${core.cfg.verbose})`)
  return hooks
}

// --------------------------------------------------------- v2: opencode 2.x

async function v2Setup(ctx: any): Promise<() => void> {
  const directories: string[] = []
  const disposes: Array<() => void> = []
  let stopped = false
  let core: Core

  const adapter: Adapter = {
    kind: "v2",
    async listProviders() {
      const res = await ctx.provider.list()
      return providersFrom(res)
    },
    async messages(sessionID) {
      const res = await ctx.session.context({ sessionID })
      const list = res?.data ?? res ?? []
      return (Array.isArray(list) ? list : []).map((msg: any) => ({
        role: msg?.type === "assistant" ? "assistant" : "user",
        text:
          typeof msg?.text === "string"
            ? msg.text
            : Array.isArray(msg?.content)
              ? msg.content
                  .filter((part: any) => part?.type === "text" && typeof part.text === "string")
                  .map((part: any) => part.text)
                  .join("\n")
              : "",
      }))
    },
    async compact(sessionID) {
      return ctx.session.compact({ sessionID })
    },
    async abort(sessionID) {
      return ctx.session.interrupt({ sessionID })
    },
    async continue(sessionID, model) {
      if (model) {
        try {
          await ctx.session.switchModel({
            sessionID,
            model: { id: model.modelID, providerID: model.providerID },
          })
        } catch (error) {
          core?.log?.(`v2 switchModel failed: ${errorText(error)}`)
        }
      }
      try {
        return await ctx.session.synthetic({
          sessionID,
          text: "continue",
          description: "unlimited lane resume",
        })
      } catch {
        return ctx.session.prompt({ sessionID, text: "continue" })
      }
    },
  }

  const options = ctx?.options?.unlimitedLane ?? ctx?.options ?? {}
  core = createCore(adapter, options)
  if (directories.length === 0) directories.push("")

  const needsResume = new Set<string>()
  const attempts = new Map<string, number>()

  const onEvent = async (event: any) => {
    try {
      const props = event?.data ?? event?.properties ?? {}
      const retryData = props?.data ?? props
      const sessionID: string | undefined =
        props?.sessionID ?? props?.info?.sessionID ?? retryData?.sessionID

      const type = String(event?.type ?? "")
      if (type === "session.idle" || type === "session.execution.idle") {
        if (sessionID && core.needsCompact(sessionID)) {
          await core.compact(sessionID, "context window guard (v2)")
        }
        if (!sessionID || !needsResume.has(sessionID)) return
        if (!core.canResume(sessionID)) {
          core.log(`resume budget exhausted for ${sessionID}`)
          needsResume.delete(sessionID)
          return
        }
        needsResume.delete(sessionID)
        core.noteResume(sessionID)
        await sleep(1_500)
        await core.continueSession(sessionID)
        return
      }

      if (
        type === "session.step.failed" ||
        type === "session.execution.failed" ||
        type === "session.error"
      ) {
        if (sessionID) needsResume.add(sessionID)
        const error =
          props?.error ?? props?.data?.error ?? retryData?.error ?? event?.error ?? type
        const result = sessionID ? await core.handleFailure(sessionID, error) : "none"
        core.log(`v2 ${type}: ${result}`)
        return
      }

      if (type === "session.status" && props?.status?.type === "retry") {
        if (sessionID) needsResume.add(sessionID)
        const message = String(
          props.status.message ??
            props.status.action?.reason ??
            props.status.action?.message ??
            props.status.error?.message ??
            "",
        )
        if (QUOTA_ERROR.test(message) && sessionID) await core.handleFailure(sessionID, message)
        return
      }

      if (sessionID) await handleEvent(core, event)
    } catch (error) {
      core.log(`v2 event handler failed: ${errorText(error)}`)
    }
  }

  // Retry hook: keep the step alive with backoff and rotate the lane every few
  // attempts, which is what stops a reply from dying mid-stream.
  try {
    const registration = await ctx.session.hook("retry", async (input: any) => {
      try {
        const sessionID: string = input?.sessionID ?? input?.session?.id ?? ""
        if (!sessionID) return undefined
        const attempt = (attempts.get(sessionID) ?? 0) + 1
        attempts.set(sessionID, attempt)
        const reason = errorText(input?.error ?? input?.failure ?? input?.reason ?? "")
        core.log(`v2 retry attempt ${attempt}${reason ? `: ${reason.slice(0, 120)}` : ""}`)
        needsResume.add(sessionID)
        if (attempt % 3 === 0) await core.handleFailure(sessionID, reason || "retry")
        const delay = Math.min(2_000 * 2 ** Math.min(attempt, 4), 30_000)
        try {
          input.decision = { type: "retry", delay }
        } catch {}
        return { retry: true, delay }
      } catch (error) {
        core.log(`v2 retry hook failed: ${errorText(error)}`)
        return undefined
      }
    })
    if (registration?.dispose) disposes.push(() => registration.dispose())
    core.log("v2 retry hook registered")
  } catch (error) {
    core.log(`v2 retry hook unavailable: ${errorText(error)}`)
  }

  // Tools: the v2 editor takes JSON Schema. The exact key name is not stable
  // across 2.x builds, so try parameters, then input, then args.
  try {
    const registration = await ctx.tool.transform((editor: any) => {
      for (const def of core.toolDefs()) {
        const [name, hint] = def.property ?? []
        const schema = {
          type: "object",
          properties: name ? { [name]: { type: "string", description: hint ?? "" } } : {},
          additionalProperties: false,
        }
        const execute = async (input: any, context: any) => ({
          output: await def.run(input ?? {}, context ?? {}),
        })
        const base = { name: def.name, description: def.description, execute }
        const variants = [
          { ...base, parameters: schema },
          { ...base, input: schema },
          { ...base, args: schema },
          base,
        ]
        for (const variant of variants) {
          try {
            editor.add(variant)
            break
          } catch {}
        }
      }
    })
    if (registration?.dispose) disposes.push(() => registration.dispose())
    core.log("v2 tools registered")
  } catch (error) {
    core.log(`v2 tool registration failed: ${errorText(error)}`)
  }

  // Background event stream: failure -> rotate/compact, idle -> resume.
  ;(async () => {
    try {
      for await (const event of ctx.event.subscribe()) {
        if (stopped) break
        await onEvent(event)
      }
    } catch (error) {
      core.log(`v2 event stream stopped: ${errorText(error)}`)
    }
  })()

  core.log("v2 lane ready")
  return () => {
    stopped = true
    for (const dispose of disposes) {
      try {
        dispose()
      } catch {}
    }
  }
}

const v2Plugin = {
  id: "opencode-unlimited-lane",
  async setup(ctx: any) {
    return v2Setup(ctx)
  },
}

export default V2 ? v2Plugin : v1Factory

