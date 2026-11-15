import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import assert from "node:assert/strict"

const CLI = new URL("../bin/freecode", import.meta.url).pathname

function fakeServer() {
  return http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello from fake" } }] })}\n\n`)
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
}

function runCli({ args, cwd, env, input = null, timeout = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-cli-"))
  const server = fakeServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  fs.writeFileSync(path.join(dir, ".freecode.json"), JSON.stringify({
    providers: {
      ollama: { baseUrl: `http://127.0.0.1:${port}/v1`, keyless: true },
      llm7: { keyless: false },
      lmstudio: { keyless: false },
      pollinations: { keyless: false }
    }
  }, null, 2))
  t.after(() => {
    server.closeAllConnections?.()
    return new Promise((resolve) => server.close(resolve))
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data") }
  for (const key of [
    "OPENROUTER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY",
    "MISTRAL_API_KEY", "GITHUB_TOKEN", "SAMBANOVA_API_KEY", "NVIDIA_API_KEY",
    "POLLINATIONS_API_KEY", "LLM7_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
    "https_proxy", "http_proxy", "all_proxy"
  ]) delete env[key]
  return { dir, env }
}

test("CLI one-shot prompt against a local OpenAI-compatible server", async (t) => {
  const { dir, env } = await setup(t)
  const run = await runCli({ args: ["--offline", "--no-color", "say hi"], cwd: dir, env })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /hello from fake/)
})

test("CLI REPL accepts piped commands", async (t) => {
  const { dir, env } = await setup(t)
  const run = await runCli({ args: ["--offline", "--no-color"], cwd: dir, env, input: "/status\n/quit\n" })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /freecode 0\.1\.0/)
  assert.match(run.stdout, /messages 0/)
})

test("CLI REPL exposes model and session pickers", async (t) => {
  const { dir, env } = await setup(t)
  const run = await runCli({
    args: ["--offline", "--no-color"],
    cwd: dir,
    env,
    input: "/model\n/model 1\n/sessions\n/status\n/quit\n"
  })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /model switch \(3 ready\)/)
  assert.match(run.stdout, /model → ollama-qwen25-coder/)
  assert.match(run.stdout, /sessions \(1\)/)
  assert.match(run.stdout, /switch: \/session <n\|id>/)
  assert.match(run.stdout, /messages 0/)
  assert.match(run.stdout, /freecode \[/)
})

test("CLI reports a missing session", async (t) => {
  const { dir, env } = await setup(t)
  const run = await runCli({ args: ["--offline", "--no-color", "--session", "nope"], cwd: dir, env })
  assert.equal(run.code, 1, run.stderr)
  assert.match(`${run.stdout}${run.stderr}`, /session not found/)
})
