import fs from "node:fs"
import process from "node:process"
import readline from "node:readline"
import { configPaths, loadConfig, sessionDir } from "./config.js"
import { buildCatalog, catalogSummary } from "./models.js"
import { ModelPool } from "./providers.js"
import { Session } from "./session.js"
import { Agent } from "./agent.js"
import { UI } from "./ui.js"
import { AbortedError, VERSION, truncate } from "./util.js"

let activeAbort = null

function printHelp() {
  console.log(`freecode ${VERSION} — terminal coding agent with free-model failover

Usage:
  freecode [options] [prompt]
  freecode doctor [--test]
  freecode models

Options:
  -m, --model <id|model|auto>   Prefer a catalog id or upstream model name
      --max-steps <n>           Max model turns per request (default 40)
      --timeout <seconds>       Per-request timeout (default 300)
  -c, --continue                Continue the latest session for this directory
      --session <id>            Load a specific session
      --offline                 Skip OpenRouter model discovery
      --no-color                Disable colors
  -v, --version                 Print version
  -h, --help                    Show this help

Commands in the REPL:
  /help  /model [n|id|auto]  /models [all]  /sessions  /session <n|id>
  /new  /clear  /continue  /status  /retry  /quit

Model switching: /model alone shows a numbered picker, /model 3 switches.
Sessions: /sessions lists recent ones, /session 2 loads, /new starts fresh.

Provider keys come from environment variables:
  OPENROUTER_API_KEY  GROQ_API_KEY       GEMINI_API_KEY
  CEREBRAS_API_KEY    MISTRAL_API_KEY    GITHUB_TOKEN
  SAMBANOVA_API_KEY   NVIDIA_API_KEY     POLLINATIONS_API_KEY
  LLM7_API_KEY

Keyless: LLM7 and Pollinations need no key. Local models also need none:
Ollama on 127.0.0.1:11434, LM Studio on 127.0.0.1:1234.
HTTPS_PROXY and NO_PROXY are honored.`)
}

function parseArgs(argv) {
  const options = {
    command: "",
    prompt: [],
    model: "",
    maxSteps: 0,
    timeout: 0,
    session: "",
    continue: false,
    offline: false,
    noColor: false,
    help: false,
    version: false,
    test: false
  }
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => {
      const value = argv[++i]
      if (value == null) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg === "-h" || arg === "--help") options.help = true
    else if (arg === "-v" || arg === "--version") options.version = true
    else if (arg === "-m" || arg === "--model") options.model = take()
    else if (arg === "--max-steps") options.maxSteps = Number(take())
    else if (arg === "--timeout") options.timeout = Number(take())
    else if (arg === "--session") options.session = take()
    else if (arg === "-c" || arg === "--continue") options.continue = true
    else if (arg === "--offline") options.offline = true
    else if (arg === "--no-color") options.noColor = true
    else if (arg === "--test") options.test = true
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`)
    else positionals.push(arg)
  }
  if (["doctor", "models", "help"].includes(positionals[0])) options.command = positionals.shift()
  options.prompt = positionals
  if (options.maxSteps && (!Number.isInteger(options.maxSteps) || options.maxSteps < 1)) {
    throw new Error("--max-steps must be a positive integer")
  }
  if (options.timeout && (!Number.isFinite(options.timeout) || options.timeout < 1)) {
    throw new Error("--timeout must be a positive number of seconds")
  }
  return options
}

function createAgent(state) {
  return new Agent({
    pool: state.pool,
    config: state.config,
    cwd: state.cwd,
    session: state.session,
    ui: state.ui
  })
}

async function runPrompt(state, text) {
  const { ui, agent } = state
  const started = Date.now()
  const controller = new AbortController()
  activeAbort = controller
  const onSigint = () => controller.abort()
  process.once("SIGINT", onSigint)
  ui.startSpinner(agent.lastModel ? "working" : "thinking")
  let ok = true
  try {
    await agent.run(text, { signal: controller.signal })
    ui.done({
      model: agent.lastModel?.id || "",
      ms: Date.now() - started,
      usage: agent.lastUsage
    })
  } catch (error) {
    if (error instanceof AbortedError) {
      ui.info("aborted")
    } else {
      ui.error(`error: ${error?.message || error}`)
      ok = false
    }
  } finally {
    process.removeListener("SIGINT", onSigint)
    ui.endStream()
    ui.stopSpinner()
    activeAbort = null
  }
  return ok
}

function readyChoices(state) {
  const ready = new Set(state.pool.candidates().map((entry) => entry.id))
  return state.catalog.filter((entry) => ready.has(entry.id))
}

function activeModel(state) {
  return state.agent?.lastModel?.id || state.config.preferred?.[0] || state.config.model || "auto"
}

function modelPicker(state) {
  const { ui } = state
  const list = readyChoices(state)
  const current = activeModel(state)
  if (!list.length) {
    state.picker = ""
    ui.info("Koi ready model nahi — keys export karo ya `freecode doctor` chalao.")
    return
  }
  state.picker = "model"
  ui.line(ui.bold(`model switch (${list.length} ready)`))
  list.forEach((entry, index) => {
    const mark = entry.id === current ? "*" : " "
    const context = entry.context ? `${Math.round(entry.context / 1000)}k` : "?"
    ui.line(` ${String(index + 1).padStart(2)}.${mark} ${entry.id.padEnd(26)} ${String(entry.provider).padEnd(12)} ${context.padStart(5)} ${entry.tools ? "tools" : "no-tools"}`)
  })
  ui.info(`pick 1-${list.length} · /model <n> · direct: /model <id> · auto: /model auto · catalog: /models all`)
}

function sessionChoices(state) {
  const listed = Session.list(state.config)
  if (!listed.some((item) => item.id === state.session.id)) {
    listed.unshift({
      id: state.session.id,
      cwd: state.session.cwd,
      updatedAt: state.session.updatedAt,
      messages: state.session.messageCount,
      mtime: Date.now()
    })
  }
  return listed
}

function sessionPicker(state) {
  const { ui } = state
  const all = sessionChoices(state)
  const list = all.slice(0, 10)
  state.picker = "session"
  ui.line(ui.bold(`sessions (${all.length})`))
  list.forEach((item, index) => {
    const mark = item.id === state.session.id ? "*" : " "
    const cwd = item.cwd ? truncate(item.cwd, 30) : "—"
    ui.line(` ${String(index + 1).padStart(2)}.${mark} ${item.id} ${String(item.messages).padStart(3)} msgs ${String(item.updatedAt || "").slice(0, 19)} ${cwd}`)
  })
  ui.info(`pick 1-${list.length} · switch: /session <n|id> · latest: /continue · new: /new`)
}

async function handleCommand(state, input) {
  const { ui, config, pool, cwd } = state
  const [name, ...rest] = input.trim().split(/\s+/)
  const arg = rest.join(" ").trim()
  if (!["/model", "/sessions", "/session"].includes(name)) state.picker = ""
  switch (name) {
    case "/help":
      printHelp()
      return false
    case "/quit":
    case "/exit":
      return true
    case "/model": {
      if (!arg) {
        modelPicker(state)
        return false
      }
      state.picker = ""
      if (arg === "auto") {
        config.model = "auto"
        config.preferred = []
        state.agent.lastModel = null
        ui.info("model → auto (best free failover)")
        return false
      }
      if (arg === "all") {
        listModels(ui, state.catalog, pool, { all: true })
        return false
      }
      const list = readyChoices(state)
      const index = Number(arg)
      let entry = null
      if (Number.isInteger(index) && index > 0) {
        if (!list.length) {
          ui.info("Koi ready model nahi — `freecode doctor` chalao.")
          return false
        }
        if (index > list.length) {
          ui.error(`model number out of range 1..${list.length}`)
          return false
        }
        entry = list[index - 1]
      } else {
        entry = state.catalog.find((item) => item.id === arg || item.model === arg) || null
      }
      if (entry) {
        const isReady = list.some((item) => item.id === entry.id)
        config.model = entry.id
        config.preferred = [entry.id]
        state.agent.lastModel = null
        ui.info(`model → ${entry.id} (${entry.provider})${isReady ? "" : " · ready nahi, failover use hoga"}`)
      } else {
        config.model = arg
        config.preferred = [arg]
        state.agent.lastModel = null
        ui.info(`model → ${arg} · catalog me nahi, failover use hoga`)
      }
      return false
    }
    case "/models":
      listModels(ui, state.catalog, pool, { all: arg === "all" })
      return false
    case "/sessions":
    case "/session": {
      if (name === "/sessions" || !arg) {
        sessionPicker(state)
        return false
      }
      state.picker = ""
      if (arg === "new") {
        state.session = Session.create(config, cwd)
        state.agent = createAgent(state)
        ui.info(`new session ${state.session.id}`)
        return false
      }
      const all = sessionChoices(state)
      const index = Number(arg)
      let target = null
      if (Number.isInteger(index) && index > 0) {
        const shown = Math.min(all.length, 10)
        if (index > shown) {
          ui.error(`session number out of range 1..${shown}`)
          return false
        }
        target = all[index - 1]
      } else {
        target = { id: arg }
      }
      if (target.id === state.session.id) {
        ui.info(`session already active: ${state.session.id}`)
        return false
      }
      const session = Session.load(config, target.id)
      if (!session) {
        ui.error(`session not found: ${arg}`)
        return false
      }
      state.session = session
      state.agent = createAgent(state)
      ui.info(`session → ${session.id} (${session.messageCount} msgs)`)
      return false
    }
    case "/new":
    case "/clear":
      state.session = Session.create(config, cwd)
      state.agent = createAgent(state)
      ui.info(`new session ${state.session.id}`)
      return false
    case "/continue": {
      const latest = Session.latest(config, cwd)
      if (!latest) {
        ui.info("no saved sessions for this directory")
        return false
      }
      state.session = latest
      state.agent = createAgent(state)
      ui.info(`session → ${latest.id} (${latest.messageCount} msgs)`)
      return false
    }
    case "/status": {
      const cooling = [...pool.coolingUntil.entries()].filter(([, until]) => until > Date.now())
      const last = state.agent.lastModel
      const wanted = config.preferred?.[0]
      const chosen = last
        || state.catalog.find((entry) => entry.id === wanted || entry.model === wanted)
        || state.catalog.find((entry) => entry.id === config.model)
      const provider = chosen ? pool.providerFor(chosen) : null
      const lines = [
        `model    ${config.model}${last ? ` · last ${last.id}` : ""}`,
        `provider ${provider?.name || "—"}`,
        `session  ${state.session.id}`,
        `messages ${state.session.messageCount}`,
        `cwd      ${cwd}`,
        `ready    ${pool.candidates().length}/${state.catalog.length} models`,
        `file     ${state.session.file}`
      ]
      if (cooling.length) {
        lines.push(`cooling  ${cooling.slice(0, 5).map(([id, until]) => `${id} ${Math.ceil((until - Date.now()) / 1000)}s`).join(", ")}`)
      }
      ui.info(lines.join("\n"))
      return false
    }
    case "/retry": {
      const previous = [...state.session.messages].reverse().find((message) => message.role === "user")
      if (!previous) {
        ui.info("no previous prompt")
        return false
      }
      ui.info(`retrying: ${truncate(previous.content, 60)}`)
      await runPrompt(state, previous.content)
      return false
    }
    default:
      ui.info(`unknown command ${name} — try /help`)
      return false
  }
}

function listModels(ui, catalog, pool, { all = false } = {}) {
  const readyIds = new Set(pool.candidates().map((entry) => entry.id))
  const list = all ? catalog : catalog.filter((entry) => readyIds.has(entry.id))
  if (!list.length) {
    ui.info("Koi model ready nahi. `freecode doctor` chalao, ya `freecode models` se catalog dekho.")
    return
  }
  ui.line(ui.bold(`models (${readyIds.size} ready / ${catalog.length} total) · /model <n> picks a ready one`))
  const groups = new Map()
  for (const entry of list) {
    if (!groups.has(entry.provider)) groups.set(entry.provider, [])
    groups.get(entry.provider).push(entry)
  }
  for (const [providerId, entries] of groups) {
    const provider = pool.providerFor(entries[0])
    ui.line(ui.bold(provider?.name || providerId))
    for (const entry of entries) {
      const mark = readyIds.has(entry.id) ? "[ready]" : "[     ]"
      const context = entry.context ? `${Math.round(entry.context / 1000)}k` : "?"
      ui.line(`  ${mark} ${entry.id.padEnd(24)} ${String(entry.model).padEnd(44)} ${context.padStart(5)} ${entry.tools ? "tools" : "no-tools"}`)
    }
  }
  if (!readyIds.size) {
    ui.info("Koi ready model nahi — keys export karo ya `freecode doctor` chalao.")
  }
}

async function doctor({ ui, config, pool, catalog, cwd, test = false }) {
  ui.line(ui.bold("freecode doctor"))
  ui.line(`node      ${process.version}`)
  ui.line(`cwd       ${cwd}`)
  ui.line(`sessions  ${sessionDir(config)}`)
  for (const file of configPaths(cwd)) {
    ui.line(`config    ${file}${fs.existsSync(file) ? "" : " (missing)"}`)
  }
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || ""
  if (proxy) ui.line(`proxy     ${proxy}`)
  ui.line()
  const groups = new Map()
  for (const entry of catalog) {
    if (!groups.has(entry.provider)) groups.set(entry.provider, [])
    groups.get(entry.provider).push(entry)
  }
  for (const [name, entries] of groups) {
    const provider = pool.providerFor(entries[0])
    const keys = pool.keysFor(provider)
    const ready = Boolean(provider?.baseUrl && pool.hasCredentials(provider))
    let status = "missing config"
    if (provider?.keyless) status = keys.length ? `keyless +${keys.length} key(s)` : "keyless"
    else if (keys.length) status = `${keys.length} key(s)`
    else if (provider?.keyEnv) status = `missing ${provider.keyEnv}`
    ui.line(`${ready ? "[ready]" : "[     ]"} ${name.padEnd(14)} ${status.padEnd(28)} ${entries.length} model(s)`)
  }
  const summary = catalogSummary(catalog, pool)
  ui.line()
  ui.line(`catalog   ${summary.total} models · ${summary.tools} with tools · ${summary.ready} ready`)
  if (!summary.ready) {
    ui.line(ui.yellow("Koi model ready nahi. Key set karo ya local Ollama chalao."))
  }
  if (summary.ready && test) {
    ui.startSpinner("testing model")
    try {
      const result = await pool.chat({
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        tools: null,
        timeoutMs: 45000
      })
      ui.endStream()
      ui.line(`test      ${result.entry?.id}: ${truncate(String(result.content).trim(), 80)}`)
    } catch (error) {
      ui.error(`test failed: ${error?.message || error}`)
      process.exitCode = 1
    } finally {
      ui.stopSpinner()
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`freecode: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (options.help || options.command === "help") {
    printHelp()
    return
  }
  if (options.version) {
    console.log(`freecode ${VERSION}`)
    return
  }
  const cwd = process.cwd()
  const config = loadConfig(cwd)
  if (options.model) {
    config.model = options.model
    config.preferred = options.model === "auto" ? [] : [options.model]
  }
  if (options.maxSteps) config.maxSteps = options.maxSteps
  if (options.timeout) config.timeoutMs = options.timeout * 1000
  const catalog = await buildCatalog(config, { discover: !options.offline })
  const pool = new ModelPool({ config, catalog })
  const ui = new UI({ color: options.noColor ? false : null })
  if (options.command === "doctor") {
    await doctor({ ui, config, pool, catalog, cwd, test: options.test })
    ui.close()
    return
  }
  if (options.command === "models") {
    listModels(ui, catalog, pool, { all: true })
    return
  }
  let session = null
  if (options.session) {
    session = Session.load(config, options.session)
    if (!session) {
      ui.error(`session not found: ${options.session}`)
      process.exitCode = 1
      return
    }
  } else if (options.continue) {
    session = Session.latest(config, cwd)
  } else {
    session = Session.create(config, cwd)
  }
  if (!session) session = Session.create(config, cwd)
  const state = { ui, config, pool, cwd, catalog, session, agent: null, picker: "" }
  state.agent = createAgent(state)

  if (options.prompt.length) {
    const ok = await runPrompt(state, options.prompt.join(" "))
    if (!ok) process.exitCode = 1
    return
  }

  const summary = catalogSummary(catalog, pool)
  const configFiles = configPaths(cwd).filter((file) => fs.existsSync(file))
  ui.banner({
    version: VERSION,
    cwd,
    ready: summary.ready,
    total: summary.total,
    configFiles,
    model: activeModel(state),
    session: state.session.id,
    messages: state.session.messageCount
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    historySize: 200
  })
  ui.rl = rl
  const setPrompt = () => ui.setContext({
    model: activeModel(state),
    session: state.session.id
  })
  rl.completer = (line) => {
    const text = String(line)
    if (text.startsWith("/model") && text.includes(" ")) {
      const arg = text.slice(text.indexOf(" ") + 1)
      const ids = readyChoices(state).map((entry) => entry.id)
      return [ids.filter((id) => id.startsWith(arg)), arg]
    }
    if (text.startsWith("/session") && text.includes(" ")) {
      const arg = text.slice(text.indexOf(" ") + 1)
      const ids = sessionChoices(state).map((item) => item.id)
      return [ids.filter((id) => id.startsWith(arg)), arg]
    }
    const commands = ["/help", "/model", "/models", "/sessions", "/session", "/new", "/clear", "/continue", "/status", "/retry", "/quit"]
    return [commands.filter((command) => command.startsWith(text)), text]
  }
  setPrompt()
  let closed = false
  const queued = []
  let waiter = null
  const takeLine = () => {
    if (queued.length) return Promise.resolve(queued.shift())
    return new Promise((resolve) => { waiter = resolve })
  }
  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(line)
    } else {
      queued.push(line)
    }
  })
  rl.on("close", () => {
    closed = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(null)
    }
  })
  rl.on("SIGINT", () => {
    if (activeAbort) {
      activeAbort.abort()
      ui.info("stopping…")
    } else {
      ui.line()
      rl.close()
    }
  })

  while (!closed) {
    setPrompt()
    ui.inputOpen()
    rl.setPrompt(ui.promptText())
    rl.prompt()
    const answer = await takeLine()
    if (answer === null) {
      ui.inputClose()
      break
    }
    ui.inputClose()
    const text = answer.trim()
    if (!text) continue
    if (state.picker && /^\d+$/.test(text)) {
      const kind = state.picker
      state.picker = ""
      await handleCommand(state, kind === "session" ? `/session ${text}` : `/model ${text}`)
      continue
    }
    if (!text.startsWith("/")) state.picker = ""
    if (text.startsWith("/")) {
      const quit = await handleCommand(state, text)
      if (quit) break
      continue
    }
    await runPrompt(state, text)
  }
  ui.close()
}
