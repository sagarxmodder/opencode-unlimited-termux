import test from "node:test"
import assert from "node:assert/strict"
import {
  AbortedError,
  deepMerge,
  parseKeys,
  sessionStamp,
  sleep,
  truncate
} from "../src/util.js"

test("truncate keeps short text and shortens long text", () => {
  assert.equal(truncate("hello", 10), "hello")
  assert.equal(truncate("hello world", 8), "hello w…")
})

test("parseKeys splits comma, newline and arrays", () => {
  assert.deepEqual(parseKeys("a,b\nc; d"), ["a", "b", "c", "d"])
  assert.deepEqual(parseKeys([" x ", "", "y"]), ["x", "y"])
  assert.deepEqual(parseKeys(null), [])
})

test("deepMerge merges nested objects without mutating inputs", () => {
  const base = { model: "auto", providers: { groq: { apiKey: "x", headers: { a: "1" } } } }
  const extra = { providers: { groq: { headers: { b: "2" } } } }
  const merged = deepMerge(base, extra)
  assert.equal(merged.model, "auto")
  assert.equal(merged.providers.groq.apiKey, "x")
  assert.deepEqual(merged.providers.groq.headers, { a: "1", b: "2" })
  assert.deepEqual(base.providers.groq.headers, { a: "1" })
})

test("sessionStamp is filesystem-safe and unique", () => {
  const a = sessionStamp()
  const b = sessionStamp()
  assert.match(a, /^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d-[0-9a-f]{4}$/)
  assert.notEqual(a, b)
})

test("sleep resolves and respects abort", async () => {
  await sleep(5)
  const controller = new AbortController()
  const pending = sleep(1000, controller.signal)
  controller.abort()
  await assert.rejects(pending, (error) => error instanceof AbortedError)
})
