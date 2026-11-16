import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ZycronApi } from "../src/tui/api.js"

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server.address().port))
  })
}

function startFakeProvider() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: "fake-1", context_length: 8192 }] }))
        return
      }
      if (req.url === "/v1/chat/completions") {
        requests.push(JSON.parse(body || "{}"))
        res.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        chunk({ choices: [{ delta: { content: "Hello " } }] })
        chunk({ choices: [{ delta: { content: "from fake" } }] })
        chunk({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } })
        res.end("data: [DONE]\n\n")
        return
      }
      res.writeHead(404).end()
    })
  })
  return { server, requests }
}

async function waitHealth(baseUrl, deadline = Date.now() + 25_000) {
  let last = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return await response.json()
      last = new Error(`health ${response.status}`)
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw last || new Error("server did not start")
}

test("streams a chat through a local openai-compatible provider", { timeout: 90_000 }, async () => {
  const root = new URL("..", import.meta.url).pathname
  const data = await mkdtemp(join(tmpdir(), "zycron-tui-data-"))
  const workspace = await mkdtemp(join(tmpdir(), "zycron-tui-ws-"))
  const fake = startFakeProvider()
  const fakePort = await listen(fake.server)
  const port = 18191
  const baseUrl = `http://127.0.0.1:${port}`
  let child = null
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), ZYCRON_DATA: data, ZYCRON_WORKSPACE: workspace, ZYCRON_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let logs = ""
    child.stdout.on("data", (chunk) => (logs += chunk))
    child.stderr.on("data", (chunk) => (logs += chunk))
    await waitHealth(baseUrl).catch((error) => {
      throw new Error(`${error.message}\n${logs.slice(-2000)}`)
    })

    const api = new ZycronApi({ baseUrl })
    const saved = await api.saveProvider({
      name: "Fake Local",
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      kind: "openai"
    })
    const provider = saved.provider
    assert.equal(provider.id, "fake-local")

    const fetched = await api.fetchProviderModels(provider.id)
    assert.equal(fetched.models.length, 1)
    assert.equal(fetched.models[0].model, "fake-1")

    const created = await api.createConversation({ title: "Stream check" })
    const conversation = created.conversation
    const events = []
    let reply = ""
    let usage = null
    for await (const event of api.chat({ conversationId: conversation.id, message: "hi there" })) {
      events.push(event)
      if (event.event === "delta") reply += event.data.text || ""
      if (event.event === "usage") usage = event.data
      if (event.event === "error") assert.fail(`chat error: ${event.data.message}`)
    }

    assert.equal(fake.requests.length, 1)
    assert.match(fake.requests[0].messages.at(-1).content, /^hi there/)
    assert.equal(reply, "Hello from fake")
    assert.ok(usage, "usage event is emitted")
    assert.equal(usage.total, 16)

    const names = events.map((event) => event.event)
    assert.ok(names.includes("ready"))
    assert.ok(names.includes("done"))

    const detail = await api.conversation(conversation.id)
    const roles = detail.messages.map((message) => message.role)
    assert.deepEqual(roles, ["user", "assistant"])
    assert.equal(detail.messages[1].content, "Hello from fake")
  } finally {
    if (child) {
      child.kill("SIGTERM")
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 4000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await new Promise((resolve) => fake.server.close(resolve))
    await rm(data, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
