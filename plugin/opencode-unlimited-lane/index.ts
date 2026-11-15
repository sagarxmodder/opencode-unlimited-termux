// opencode-unlimited-lane — v1 plugin for opencode 1.x (Termux warp lane)
//
// Two jobs, both model-agnostic (har har free model ke liye):
//
//  1. quota bypass: on a free-limit / 429 / 5xx wall, rotate the WARP exit
//     pool through the local proxy (/recycle), wait for a fresh healthy
//     exit IP, then auto-continue the session on the new /64.
//
//  2. context guard: track usage from message.updated, cap maxOutputTokens
//     to the remaining budget, hand off the transcript, and compact via
//     POST /session/{id}/summarize before the context-length wall.
//
// Install: copy as a FLAT file to ~/.config/opencode/plugins/opencode-unlimited-lane.ts
// (opencode 1.19.5 imports sub-directory index.ts but does not invoke it),
// or list the absolute path in config `plugin`.

import { tool } from "@opencode-ai/plugin"
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs"
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
  warnAt: 0.7,
  compactAt: 0.85,
  handoffAt: 0.95,
  cooldownMs: 180_000,
  contextLimit: 200_000,
  maxOutputFloor: 4_096,
  proxyUrl: "http://127.0.0.1:8789",
  maxRetries: 0,
  retryCooldownMs: 45_000,
  verbose: false,
}

const CONTEXT_ERROR =
  /maximum context length|requested token count exceeds|too many tokens|context length|prompt is too long|reduce the length of the messages/i

const QUOTA_ERROR =
  /free usage limit|quota|rate.?limit|too many requests|429|402|503|502|service unavailable|capacity|overloaded|try again later|usage limit|daily limit|limit reached|insufficient/i

type Budget = { budget: number; context: number; output: number; providerID: string; modelID: string }
type Usage = { used: number; budget: number; ratio: number; at: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function unlimitedLane(input: any, rawOptions?: Options) {
  const options = { ...DEFAULTS, ...(rawOptions ?? {}) }
  const home = process.env.HOME ?? "/data/data/com.termux/files/home"
  const memoryDir = options.memoryDir ?? join(home, ".config/opencode/memory")
  const logFile = options.logFile ?? join(memoryDir, "unlimited-tokens.log")
  const directory: string = input?.directory ?? process.cwd()
  const client = input?.client
  const proxy =
    process.env.OC_LANE_PROXY ??
    (() => {
      const value = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? ""
      return /127\.0\.0\.1:\d+/.test(value) ? value : options.proxyUrl
    })()

  const budgets = new Map<string, Budget>()
  const usage = new Map<string, Usage>()
  const compacting = new Set<string>()
  const rotating = new Set<string>()
  const lastCompact = new Map<string, number>()
  const lastWarn = new Map<string, number>()
  const lastHandoff = new Map<string, number>()
  const lastRetry = new Map<string, number>()
  const retries = new Map<string, number>()
  const verbose = options.verbose || process.env.OPENCODE_TOKENS_VERBOSE === "1"

  const now = () => Date.now()

  const log = (message: string) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
      appendFileSync(logFile, `${new Date().toISOString()}  ${message}\n`, "utf8")
    } catch {
      // logging must never break a session
    }
  }

  log(`lane plugin loaded (proxy ${proxy}, compact ${options.compactAt}, retries ${options.maxRetries})`)

  // ---------------------------------------------------------------- warp pool

  async function exits(): Promise<string[]> {
    try {
      const res = await fetch(`${proxy}/exits`, { signal: AbortSignal.timeout(4_000) })
      if (!res.ok) return []
      const data: any = await res.json()
      return (Array.isArray(data) ? data : [])
        .filter((exit: any) => exit?.state === "healthy" && exit?.ip)
        .map((exit: any) => String(exit.ip))
    } catch {
      return []
    }
  }

  async function rotateWarp(): Promise<boolean> {
    const before = new Set(await exits())
    try {
      const res = await fetch(`${proxy}/recycle`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok && res.status !== 202) {
        log(`recycle rejected: ${res.status}`)
        return false
      }
    } catch (error) {
      log(`recycle failed: ${String(error)}`)
      return false
    }
    for (let i = 0; i < 40; i++) {
      await sleep(1_000)
      const current = await exits()
      const fresh = current.filter((ip) => !before.has(ip))
      if (fresh.length > 0) {
        log(`warp rotated: ${[...before].join(",") || "?"} -> ${fresh.join(",")}`)
        return true
      }
    }
    log("warp rotation timed out (no fresh exit)")
    return false
  }

  // ---------------------------------------------------------------- budget

  async function resolveBudget(sessionID: string, info?: any): Promise<Budget> {
    const known = budgets.get(sessionID)
    if (known) return known
    const providerID = info?.providerID
    const modelID = info?.modelID
    if (providerID && modelID && client?.config?.providers) {
      try {
        const res: any = await client.config.providers()
        const providers = res?.data ?? res
        for (const provider of Array.isArray(providers) ? providers : []) {
          if (provider?.id !== providerID) continue
          const model = provider?.models?.[modelID]
          const context = Number(model?.limit?.context) || 0
          const output = Number(model?.limit?.output) || 0
          if (context > 0) {
            const value = {
              budget: Math.max(1, context - Math.max(output, options.maxOutputFloor)),
              context,
              output,
              providerID,
              modelID,
            }
            budgets.set(sessionID, value)
            return value
          }
        }
      } catch (error) {
        log(`provider lookup failed: ${String(error)}`)
      }
    }
    const fallback: Budget = {
      budget: options.contextLimit,
      context: options.contextLimit,
      output: options.maxOutputFloor,
      providerID: providerID ?? "",
      modelID: modelID ?? "",
    }
    budgets.set(sessionID, fallback)
    return fallback
  }

  // ---------------------------------------------------------------- handoff

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

  async function writeHandoff(sessionID: string, reason: string): Promise<string> {
    const res: any = await client.session
      .messages({ path: { id: sessionID }, query: { directory } })
      .catch(() => undefined)
    const messages = res?.data ?? res ?? []
    const blocks: string[] = []
    for (const message of Array.isArray(messages) ? messages.slice(-80) : []) {
      const text = messageText(message?.parts ?? [])
      if (!text) continue
      blocks.push(`## ${String(message?.info?.role ?? "message").toUpperCase()}\n${text}`)
    }
    let body = blocks.join("\n\n")
    if (body.length > 120_000) body = `…(older context trimmed)…\n\n${body.slice(-120_000)}`
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const header = [
      "# OpenCode session handoff",
      "",
      `- session: ${sessionID}`,
      `- reason: ${reason}`,
      `- created: ${new Date().toISOString()}`,
      "",
      "Continue the work from this transcript in a fresh session.",
      "",
    ].join("\n")
    mkdirSync(memoryDir, { recursive: true, mode: 0o700 })
    const file = join(memoryDir, `handoff-${stamp}.md`)
    writeFileSync(file, `${header}${body}\n`, { encoding: "utf8", mode: 0o600 })
    writeFileSync(join(memoryDir, "latest-handoff.md"), `${header}${body}\n`, { encoding: "utf8", mode: 0o600 })
    chmodSync(file, 0o600)
    return file
  }

  // ---------------------------------------------------------------- compaction

  async function compact(sessionID: string, reason: string): Promise<boolean> {
    if (!sessionID || compacting.has(sessionID)) return false
    if (now() - (lastCompact.get(sessionID) ?? 0) < options.cooldownMs) return false
    if (!client?.session?.summarize) {
      log("client.session.summarize missing; cannot compact")
      return false
    }
    compacting.add(sessionID)
    lastCompact.set(sessionID, now())
    const budget = await resolveBudget(sessionID)
    const handoff = await writeHandoff(sessionID, `before compaction: ${reason}`).catch((error: any) => {
      log(`handoff failed: ${String(error)}`)
      return ""
    })
    if (handoff) log(`handoff wrote ${handoff}`)
    try {
      await client.session.summarize({
        path: { id: sessionID },
        body: { providerID: budget.providerID, modelID: budget.modelID },
        query: { directory },
      })
      log(`compaction requested (${reason})`)
      return true
    } catch (error) {
      log(`compaction failed (${reason}): ${String(error)}`)
      return false
    } finally {
      compacting.delete(sessionID)
    }
  }

  // ---------------------------------------------------------------- quota retry

  async function retryAfterRotation(sessionID: string, reason: string): Promise<boolean> {
    if (rotating.has(sessionID)) return false
    if (now() - (lastRetry.get(sessionID) ?? 0) < options.retryCooldownMs) return false
    if (options.maxRetries > 0 && (retries.get(sessionID) ?? 0) >= options.maxRetries) {
      log(`retry budget exhausted for ${sessionID} (${options.maxRetries}); manual resend needed`)
      return false
    }
    rotating.add(sessionID)
    lastRetry.set(sessionID, now())
    retries.set(sessionID, (retries.get(sessionID) ?? 0) + 1)
    try {
      log(`quota wall on ${sessionID} (${reason}); rotating WARP exit`)
      const ok = await rotateWarp()
      if (!ok) {
        log("rotation failed; leaving the error visible")
        return false
      }
      await sleep(800)
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: "continue", synthetic: true }] },
        query: { directory },
      })
      log(`auto-continue sent on ${sessionID} via fresh WARP exit`)
      return true
    } catch (error) {
      log(`auto-continue failed: ${String(error)}`)
      return false
    } finally {
      rotating.delete(sessionID)
    }
  }

  function describe(sessionID: string): string {
    const last = usage.get(sessionID)
    const budget = budgets.get(sessionID)?.budget ?? options.contextLimit
    if (!last) return `context: no step measured yet (budget ${budget.toLocaleString()})`
    const state = compacting.has(sessionID) ? "compacting" : now() - last.at > 300_000 ? "stale" : "tracking"
    return [
      `context: ${last.used.toLocaleString()} / ${last.budget.toLocaleString()} (${(last.ratio * 100).toFixed(1)}%)`,
      `thresholds: warn ${(options.warnAt * 100).toFixed(0)}% | compact ${(options.compactAt * 100).toFixed(0)}% | handoff ${(options.handoffAt * 100).toFixed(0)}%`,
      `warp retries: ${retries.get(sessionID) ?? 0}${options.maxRetries > 0 ? `/${options.maxRetries}` : " (unlimited)"}`,
      `state: ${state}`,
    ].join("\n")
  }

  // ---------------------------------------------------------------- hooks

  const hooks = {
    async event({ event }: any) {
      try {
        if (!event || typeof event !== "object") return
        const props = event.properties ?? event.data ?? {}
        const sessionID: string | undefined = props.sessionID ?? props.info?.sessionID
        if (!sessionID) return

        if (event.type === "session.compacted") {
          compacting.delete(sessionID)
          usage.delete(sessionID)
          log(`compaction finished for ${sessionID}`)
          return
        }

        if (event.type === "session.error") {
          const message = String(props.error?.data?.message ?? props.error?.message ?? "")
          if (CONTEXT_ERROR.test(message)) {
            log(`context error on ${sessionID}; compacting`)
            await compact(sessionID, "context-length error")
            return
          }
          if (QUOTA_ERROR.test(message)) {
            await retryAfterRotation(sessionID, message.slice(0, 120))
          }
          return
        }

        if (event.type !== "message.updated") return
        const info = props.info
        if (!info || info.role !== "assistant") return

        const failure = String(info.error?.data?.message ?? info.error?.data?.error ?? "")
        if (CONTEXT_ERROR.test(failure)) {
          log(`context error inside message on ${sessionID}; compacting`)
          await compact(sessionID, "context-length error")
          return
        }
        if (QUOTA_ERROR.test(failure)) {
          await retryAfterRotation(sessionID, failure.slice(0, 120))
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
        if (used < 1_000) return

        const budget = await resolveBudget(sessionID, info)
        const ratio = used / budget.budget
        usage.set(sessionID, { used, budget: budget.budget, ratio, at: now() })
        retries.delete(sessionID)

        if (verbose || ratio >= options.warnAt) {
          log(`usage ${sessionID} ${used}/${budget.budget} (${(ratio * 100).toFixed(1)}%)`)
        }

        if (ratio >= options.warnAt && now() - (lastWarn.get(sessionID) ?? 0) > options.cooldownMs) {
          lastWarn.set(sessionID, now())
          log(`warning ${sessionID}: context ${(ratio * 100).toFixed(1)}% — /compact ya compact_now tool`)
        }

        if (ratio >= options.handoffAt && now() - (lastHandoff.get(sessionID) ?? 0) > options.cooldownMs) {
          lastHandoff.set(sessionID, now())
          const file = await writeHandoff(sessionID, "automatic: context almost full").catch(() => "")
          if (file) log(`auto handoff wrote ${file}`)
        }

        if (ratio >= options.compactAt) await compact(sessionID, `${(ratio * 100).toFixed(1)}% full`)
      } catch (error) {
        log(`event handler failed: ${String(error)}`)
      }
    },

    async "chat.params"(params: any, output: any) {
      try {
        const sessionID: string | undefined = params?.sessionID
        if (!sessionID) return
        const model = params?.model
        if (model?.limit?.context > 0) {
          const context = Number(model.limit.context)
          const completion = Number(model.limit.output) || options.maxOutputFloor
          budgets.set(sessionID, {
            budget: Math.max(1, context - Math.max(completion, options.maxOutputFloor)),
            context,
            output: completion,
            providerID: model.providerID,
            modelID: model.id,
          })
        }
        const last = usage.get(sessionID)
        const budget = budgets.get(sessionID)
        if (!last || !budget) return
        const remaining = budget.context - last.used
        if (remaining <= 0) return
        const cap = Math.max(options.maxOutputFloor, remaining - 2_048)
        if (typeof output?.maxOutputTokens !== "number" || output.maxOutputTokens > cap) {
          output.maxOutputTokens = cap
          if (last.ratio >= options.warnAt) log(`capped maxOutputTokens to ${cap}`)
        }
      } catch (error) {
        log(`chat.params failed: ${String(error)}`)
      }
    },

    tool: {
      token_status: tool({
        description: "Show context usage, compaction state, and WARP retry count for this session.",
        args: {},
        async execute(_args: any, context: any) {
          const budget = await resolveBudget(context.sessionID)
          return `${describe(context.sessionID)}\nmodel budget: ${budget.budget.toLocaleString()} (context ${budget.context.toLocaleString()}, completion ${budget.output.toLocaleString()})`
        },
      }),
      handoff: tool({
        description: "Save this session's transcript to a Markdown memory file so a fresh session can continue.",
        args: { note: tool.schema.string().describe("Short reason for the handoff").optional() },
        async execute(args: any, context: any) {
          const file = await writeHandoff(context.sessionID, args?.note ?? "manual")
          return `Handoff saved to ${file}. Start a new session and read ~/.config/opencode/memory/latest-handoff.md to continue.`
        },
      }),
      compact_now: tool({
        description: "Hand off the transcript and compact this session immediately, freeing context without closing it.",
        args: {},
        async execute(_args: any, context: any) {
          lastCompact.delete(context.sessionID)
          const ok = await compact(context.sessionID, "manual: compact_now")
          return ok
            ? "Compaction requested. The session stays open with a summary."
            : "Compaction did not start (already running, cooling down, or unsupported). Use the /compact command."
        },
      }),
      warp_rotate: tool({
        description: "Rotate the WARP exit pool (fresh /64) and report the new egress IPs.",
        args: {},
        async execute() {
          const before = await exits()
          const ok = await rotateWarp()
          const after = await exits()
          return ok
            ? `WARP rotated.\nbefore: ${before.join(", ") || "?"}\nafter:  ${after.join(", ") || "?"}`
            : `Rotation failed. Current exits: ${after.join(", ") || "none"}. Run opencode-unlimited-hop.`
        },
      }),
    },
  }

  return hooks
}
