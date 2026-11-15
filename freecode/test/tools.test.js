import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { executeTool, TOOL_DEFINITIONS } from "../src/tools.js"

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("tool definitions expose the expected function names", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.function.name)
  assert.deepEqual(names, ["read", "write", "edit", "glob", "grep", "bash", "webfetch"])
})

test("write, read and edit round-trip", async (t) => {
  const cwd = tempDir(t)
  const written = await executeTool("write", { path: "notes/a.txt", content: "one\ntwo\nthree" }, { cwd })
  assert.match(written, /Wrote 13 bytes/)
  assert.equal(fs.readFileSync(path.join(cwd, "notes/a.txt"), "utf8"), "one\ntwo\nthree")

  const read = await executeTool("read", { path: "notes/a.txt" }, { cwd })
  assert.match(read, /1\| one/)
  assert.match(read, /3\| three/)

  const slice = await executeTool("read", { path: "notes/a.txt", offset: 2, limit: 1 }, { cwd })
  assert.match(slice, /2\| two/)
  assert.doesNotMatch(slice, /one/)

  const edited = await executeTool("edit", { path: "notes/a.txt", oldString: "two", newString: "TWO" }, { cwd })
  assert.match(edited, /Replaced 1 occurrence/)
  assert.match(fs.readFileSync(path.join(cwd, "notes/a.txt"), "utf8"), /TWO/)

  const missing = await executeTool("edit", { path: "notes/a.txt", oldString: "nope", newString: "x" }, { cwd })
  assert.match(missing, /^Error: oldString not found/)
})

test("edit refuses ambiguous matches unless replaceAll is set", async (t) => {
  const cwd = tempDir(t)
  await executeTool("write", { path: "dup.txt", content: "aa\naa\n" }, { cwd })
  const ambiguous = await executeTool("edit", { path: "dup.txt", oldString: "aa", newString: "bb" }, { cwd })
  assert.match(ambiguous, /matches 2 times/)
  const replaced = await executeTool("edit", { path: "dup.txt", oldString: "aa", newString: "bb", replaceAll: true }, { cwd })
  assert.match(replaced, /Replaced 2 occurrence/)
  assert.equal(fs.readFileSync(path.join(cwd, "dup.txt"), "utf8"), "bb\nbb\n")
})

test("glob and grep skip node_modules and honor filters", async (t) => {
  const cwd = tempDir(t)
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
  fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true })
  fs.writeFileSync(path.join(cwd, "src/a.js"), "const x = 1\n")
  fs.writeFileSync(path.join(cwd, "src/b.ts"), "needle here\n")
  fs.writeFileSync(path.join(cwd, "node_modules/skip.js"), "needle here too\n")

  const files = await executeTool("glob", { pattern: "**/*.js" }, { cwd })
  assert.match(files, /src\/a\.js/)
  assert.doesNotMatch(files, /node_modules/)

  const matches = await executeTool("grep", { pattern: "needle" }, { cwd })
  assert.match(matches, /src\/b\.ts:1: needle here/)
  assert.doesNotMatch(matches, /node_modules/)

  const include = await executeTool("grep", { pattern: "needle", include: "*.js" }, { cwd })
  assert.match(include, /No matches/)

  const insensitive = await executeTool("grep", { pattern: "NEEDLE", ignoreCase: true }, { cwd })
  assert.match(insensitive, /src\/b\.ts/)
})

test("bash returns exit code and output", async (t) => {
  const cwd = tempDir(t)
  const ok = await executeTool("bash", { command: "printf hello" }, { cwd })
  assert.match(ok, /exit: 0/)
  assert.match(ok, /hello/)
  const bad = await executeTool("bash", { command: "echo oops >&2; exit 3" }, { cwd })
  assert.match(bad, /exit: 3/)
  assert.match(bad, /oops/)
})

test("webfetch converts HTML to text and drops scripts", async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" })
    response.end("<html><body><h1>Hello</h1><script>evil()</script><p>World &amp; more</p></body></html>")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections?.()
    return new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()
  const output = await executeTool("webfetch", { url: `http://127.0.0.1:${port}/page` }, {})
  assert.match(output, /^HTTP 200 text\/html/)
  assert.match(output, /Hello/)
  assert.match(output, /World & more/)
  assert.doesNotMatch(output, /evil/)
})

test("unknown tools return an error string", async () => {
  const output = await executeTool("nope", {}, {})
  assert.match(output, /^Error: unknown tool/)
})
