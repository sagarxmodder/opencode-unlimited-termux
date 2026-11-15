import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { Agent } from "../src/agent.js"
import { AbortedError } from "../src/util.js"

class FakeSession {
  constructor() {
    this.messages = []
  }

  append(message) {
    this.messages.push(message)
    return message
  }
}

class FakePool {
  constructor(results) {
    this.results = [...results]
    this.calls = 0
  }

  async chat(options) {
    const next = this.results[this.calls++]
    if (next instanceof Error) throw next
    if (typeof next === "function") return next(options)
    return next
  }
}

function fakeUi() {
  return {
    deltas: [],
    tools: [],
    infos: [],
    startSpinner() {},
    delta(text) { this.deltas.push(text) },
    endStream() {},
    toolCall(name, args) { this.tools.push({ name, args }) },
    retry() {},
    info(text) { this.infos.push(text) }
  }
}

function result(content, toolCalls = [], id = "fake") {
  return { content, toolCalls, entry: { id } }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-agent-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeAgent(t, results, overrides = {}) {
  const cwd = tempDir(t)
  const session = new FakeSession()
  const ui = fakeUi()
  const config = { maxSteps: 5, model: "auto", timeoutMs: 1000, ...overrides }
  const agent = new Agent({ pool: new FakePool(results), config, cwd, session, ui })
  return { agent, session, ui, cwd }
}

test("agent executes tool calls and returns the final answer", async (t) => {
  const { agent, session, ui, cwd } = makeAgent(t, [
    result("writing", [{ id: "call_1", name: "write", arguments: { path: "x.txt", content: "hi" } }]),
    result("done", [])
  ])
  const answer = await agent.run("create x.txt")
  assert.equal(answer, "done")
  assert.equal(fs.readFileSync(path.join(cwd, "x.txt"), "utf8"), "hi")
  assert.equal(agent.lastModel.id, "fake")
  assert.deepEqual(ui.tools.map((tool) => tool.name), ["write"])
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"])
  assert.match(session.messages[2].content, /Wrote 2 bytes/)
})

test("agent compresses context and retries", async (t) => {
  const contextError = () => Object.assign(new Error("maximum context length exceeded"), { kind: "context" })
  const { agent, session, ui } = makeAgent(t, [contextError(), contextError(), result("recovered")])
  const answer = await agent.run("hello")
  assert.equal(answer, "recovered")
  assert.equal(agent.pool.calls, 3)
  assert.equal(ui.infos.filter((text) => text.includes("context full")).length, 2)
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant"])
})

test("agent stops before starting when the signal is already aborted", async (t) => {
  const { agent } = makeAgent(t, [result("never")])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    agent.run("hello", { signal: controller.signal }),
    (error) => error instanceof AbortedError
  )
  assert.equal(agent.pool.calls, 0)
})

test("agent enforces max steps", async (t) => {
  const { agent } = makeAgent(
    t,
    [result("looping", [{ id: "call_1", name: "bash", arguments: { command: "true" } }])],
    { maxSteps: 1 }
  )
  await assert.rejects(agent.run("loop"), /max steps \(1\) reached/)
})
