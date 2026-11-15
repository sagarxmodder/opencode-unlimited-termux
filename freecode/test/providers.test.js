import http from "node:http"
import test from "node:test"
import assert from "node:assert/strict"
import {
  ModelPool,
  chatOnce,
  classifyError,
  describeError,
  httpRequest,
  proxyFor
} from "../src/providers.js"
import { HttpError } from "../src/util.js"

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    }
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => resolve(body))
  })
}

function sseResponse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.write("data: [DONE]\n\n")
  response.end()
}

function poolConfig(baseUrl, extra = {}) {
  return {
    model: "auto",
    preferred: [],
    timeoutMs: 5000,
    providers: { ollama: { baseUrl, keyless: true, ...extra } },
    models: []
  }
}

const entry = (id, model, tools = false) => ({ id, provider: "ollama", model, tools })

test("chatOnce parses streamed content and tool call fragments", async () => {
  let seen = null
  const srv = await listen(async (request, response) => {
    seen = { url: request.url, auth: request.headers.authorization, body: JSON.parse(await readBody(request)) }
    sseResponse(response, [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.js\"}" } }] } }] },
      { choices: [{ finish_reason: "tool_calls", delta: {} }] }
    ])
  })
  try {
    const deltas = []
    const result = await chatOnce({
      provider: { baseUrl: srv.baseUrl, headers: {} },
      entry: { id: "fake", model: "fake-model" },
      messages: [{ role: "user", content: "hi" }],
      apiKey: "secret",
      timeoutMs: 5000,
      temperature: 0.3,
      onDelta: (text) => deltas.push(text)
    })
    assert.equal(seen.url, "/v1/chat/completions")
    assert.equal(seen.auth, "Bearer secret")
    assert.equal(seen.body.model, "fake-model")
    assert.equal(seen.body.stream, true)
    assert.equal(seen.body.temperature, 0.3)
    assert.equal(result.content, "Hello")
    assert.deepEqual(deltas, ["Hel", "lo"])
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read")
    assert.deepEqual(result.toolCalls[0].arguments, { path: "a.js" })
    assert.equal(result.finishReason, "tool_calls")
  } finally {
    await srv.close()
  }
})

test("chatOnce accepts non-streamed JSON responses", async () => {
  const srv = await listen(async (request, response) => {
    await readBody(request)
    response.writeHead(200, { "content-type": "application/json", connection: "close" })
    response.end(JSON.stringify({
      choices: [{ message: { content: "plain" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 }
    }))
  })
  try {
    const result = await chatOnce({
      provider: { baseUrl: srv.baseUrl, headers: {} },
      entry: { id: "fake", model: "fake-model" },
      messages: [{ role: "user", content: "hi" }]
    })
    assert.equal(result.content, "plain")
    assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 1 })
  } finally {
    await srv.close()
  }
})

test("chatOnce surfaces HTTP errors and classification", async () => {
  const srv = await listen(async (request, response) => {
    await readBody(request)
    response.writeHead(429, { "content-type": "application/json", connection: "close" })
    response.end(JSON.stringify({ error: { message: "rate limit exceeded" } }))
  })
  try {
    await assert.rejects(
      chatOnce({
        provider: { baseUrl: srv.baseUrl, headers: {} },
        entry: { id: "fake", model: "fake-model" },
        messages: [{ role: "user", content: "hi" }]
      }),
      (error) => {
        assert.ok(error instanceof HttpError)
        assert.equal(error.status, 429)
        assert.equal(classifyError(error), "rate")
        assert.match(describeError(error), /HTTP 429: rate limit exceeded/)
        return true
      }
    )
  } finally {
    await srv.close()
  }
})

test("ModelPool fails over to the next model after a rate limit", async () => {
  const requests = []
  const srv = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request))
    requests.push(body.model)
    if (body.model === "model-a") {
      response.writeHead(429, { "content-type": "application/json", connection: "close" })
      response.end(JSON.stringify({ error: { message: "rate limit" } }))
      return
    }
    sseResponse(response, [{ choices: [{ delta: { content: "from-b" } }] }])
  })
  try {
    const config = poolConfig(srv.baseUrl)
    const pool = new ModelPool({ config, catalog: [entry("a", "model-a"), entry("b", "model-b")] })
    const result = await pool.chat({ messages: [{ role: "user", content: "hi" }], tools: null, timeoutMs: 5000 })
    assert.equal(result.content, "from-b")
    assert.equal(result.entry.id, "b")
    assert.deepEqual(requests, ["model-a", "model-b"])
    assert.equal(pool.coolingUntil.has("a"), true)
  } finally {
    await srv.close()
  }
})

test("ModelPool retries without tools when the provider rejects tools", async () => {
  const bodies = []
  const srv = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request))
    bodies.push(body)
    if (body.tools) {
      response.writeHead(400, { "content-type": "application/json", connection: "close" })
      response.end(JSON.stringify({ error: { message: "tools are not supported for this model" } }))
      return
    }
    sseResponse(response, [{ choices: [{ delta: { content: "no-tools" } }] }])
  })
  try {
    const pool = new ModelPool({ config: poolConfig(srv.baseUrl), catalog: [entry("t", "tool-model", true)] })
    const result = await pool.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      timeoutMs: 5000
    })
    assert.equal(result.content, "no-tools")
    assert.equal(bodies.length, 2)
    assert.ok(bodies[0].tools)
    assert.equal(bodies[1].tools, undefined)
  } finally {
    await srv.close()
  }
})

test("ModelPool rotates API keys on auth failures", async () => {
  const auths = []
  const srv = await listen(async (request, response) => {
    await readBody(request)
    auths.push(request.headers.authorization)
    if (request.headers.authorization === "Bearer key-1") {
      response.writeHead(401, { "content-type": "application/json", connection: "close" })
      response.end(JSON.stringify({ error: { message: "invalid api key" } }))
      return
    }
    sseResponse(response, [{ choices: [{ delta: { content: "key-2" } }] }])
  })
  try {
    const config = poolConfig(srv.baseUrl, { keyless: false, apiKey: "key-1,key-2" })
    const pool = new ModelPool({ config, catalog: [entry("k", "key-model")] })
    const result = await pool.chat({ messages: [{ role: "user", content: "hi" }], tools: null, timeoutMs: 5000 })
    assert.equal(result.content, "key-2")
    assert.deepEqual(auths, ["Bearer key-1", "Bearer key-2"])
  } finally {
    await srv.close()
  }
})

test("ModelPool summarizes failures across every model", async () => {
  const pool = new ModelPool({
    config: poolConfig("http://127.0.0.1:1/v1", { keyless: true }),
    catalog: [entry("first-model", "m1"), entry("second-model", "m2")]
  })
  await assert.rejects(
    pool.chat({ messages: [{ role: "user", content: "hi" }], timeoutMs: 2000 }),
    (error) => {
      assert.match(error.message, /all 2 free models failed/)
      assert.match(error.message, /first-model:/)
      assert.match(error.message, /\(\+1 more\)/)
      return true
    }
  )
})

test("ModelPool reports a helpful error when nothing is configured", async () => {
  const pool = new ModelPool({ config: poolConfig("http://127.0.0.1:1/v1", { keyless: false }), catalog: [entry("none", "x")] })
  await assert.rejects(
    pool.chat({ messages: [{ role: "user", content: "hi" }] }),
    /Koi free model available nahi/
  )
})

test("httpRequest performs a plain GET", async () => {
  const srv = await listen(async (request, response) => {
    response.writeHead(200, { "content-type": "text/plain", connection: "close" })
    response.end(`path=${request.url}`)
  })
  try {
    const response = await httpRequest({ url: `${srv.baseUrl}/hello` })
    let body = ""
    for await (const chunk of response.stream) body += chunk
    assert.equal(response.status, 200)
    assert.equal(body, "path=/v1/hello")
  } finally {
    await srv.close()
  }
})

test("classifyError distinguishes contexts, models tools and auth", () => {
  assert.equal(classifyError(new HttpError(400, '{"error":{"message":"maximum context length exceeded"}}')), "context")
  assert.equal(classifyError(new HttpError(400, '{"error":{"message":"tools are not supported"}}')), "tools")
  assert.equal(classifyError(new HttpError(404, '{"error":{"message":"model not found"}}')), "model")
  assert.equal(classifyError(new HttpError(401, "unauthorized")), "auth")
  assert.equal(classifyError(new HttpError(500, "boom")), "retry")
  assert.equal(classifyError(new Error("socket hang up")), "retry")
})

test("httpRequest tunnels HTTPS through an HTTP CONNECT proxy", async (t) => {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  let connectLine = ""
  const server = http.createServer()
  server.on("connect", (request, socket) => {
    connectLine = `${request.method} ${request.url}`
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`
  await assert.rejects(
    httpRequest({ url: "https://api.example.com/v1/models" }),
    (error) => /proxy CONNECT failed/.test(error.message)
  )
  assert.equal(connectLine, "CONNECT api.example.com:443")
})

test("proxyFor honors env, localhost bypass and NO_PROXY", (t) => {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  for (const key of keys) delete process.env[key]
  assert.equal(proxyFor(new URL("https://api.example.com/v1")), null)
  process.env.HTTPS_PROXY = "http://proxy.local:8080"
  assert.equal(proxyFor(new URL("https://api.example.com/v1")), "http://proxy.local:8080")
  assert.equal(proxyFor(new URL("http://127.0.0.1:11434/v1")), null)
  process.env.NO_PROXY = ".example.com,other.test"
  assert.equal(proxyFor(new URL("https://api.example.com/v1")), null)
  assert.equal(proxyFor(new URL("https://api.other.test/v1")), null)
  assert.equal(proxyFor(new URL("https://api.third.test/v1")), "http://proxy.local:8080")
})
