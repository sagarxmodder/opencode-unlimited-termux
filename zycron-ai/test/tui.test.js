import assert from "node:assert/strict"
import test from "node:test"
import { Grid, charWidth, textWidth, truncate, wrapText, clipSpans, span, spansWidth, formatTokens } from "../src/tui/ansi.js"
import { KeyParser } from "../src/tui/keys.js"
import { renderMarkdown } from "../src/tui/markdown.js"
import { readSse } from "../src/tui/api.js"
import { renderScreen } from "../src/tui/render.js"

const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "")

test("measures display width for ascii, wide and combining text", () => {
  assert.equal(textWidth("abc"), 3)
  assert.equal(charWidth("界".codePointAt(0)), 2)
  assert.equal(textWidth("a界b"), 4)
  assert.equal(textWidth("\u0301"), 0)
  assert.equal(truncate("abcdefgh", 5), "abcd…")
})

test("wraps text to a hard width without losing words", () => {
  const lines = wrapText("the quick brown fox jumps over the lazy dog", 12)
  for (const line of lines) assert.ok(spansWidth(line) <= 12, line.map((part) => part.t).join(""))
  const plain = lines.map((line) => line.map((part) => part.t).join("")).join(" ")
  assert.equal(plain.split(/\s+/).join(" "), "the quick brown fox jumps over the lazy dog")
})

test("clips spans at the width boundary", () => {
  const clipped = clipSpans([span("abcdef", ""), span("ghij", "")], 6)
  assert.equal(spansWidth(clipped), 6)
})

test("grid overlays bytes and keeps every row exactly the requested width", () => {
  const grid = new Grid(10, 3)
  grid.clear("")
  grid.put(2, 1, "hello")
  grid.put(8, 1, "世界")
  const lines = grid.toLines()
  assert.equal(lines.length, 3)
  for (const line of lines) assert.equal(textWidth(plain(line)), 10)
  assert.match(lines[1], /hello/)
})

test("formats token counts", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(78_800), "78.8K")
  assert.equal(formatTokens(1_500_000), "1.5M")
})

test("parses navigation, control and modification sequences", () => {
  const parse = (input) => {
    const parser = new KeyParser()
    return [...parser.feed(input), ...parser.flush()]
  }
  assert.equal(parse("\x1b[A")[0].name, "up")
  assert.equal(parse("\x03")[0].name, "ctrl")
  assert.equal(parse("\x03")[0].key, "c")
  assert.equal(parse("\x1b[13;2u")[0].name, "newline")
  assert.equal(parse("\x1b\r")[0].name, "newline")
  const paste = parse("\x1b[200~hello\nworld\x1b[201~")
  assert.equal(paste[0].name, "paste")
  assert.equal(paste[0].text, "hello\nworld")
})

test("flushes a lone escape after the grace period", () => {
  const parser = new KeyParser()
  assert.equal(parser.feed("\x1b").length, 0)
  const flushed = parser.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].name, "escape")
})

test("renders markdown headings, fences and task lists", () => {
  const { lines } = renderMarkdown("# Title\n\n```js\nconst x = 1\n```\n\n- [x] done\n- [ ] todo", 60)
  const text = lines.map((line) => line.map((part) => part.t).join("")).join("\n")
  assert.match(text, /Title/)
  assert.match(text, /const x = 1/)
  assert.match(text, /✓ done/)
  assert.match(text, /○ todo/)
})

test("renders a full frame at several widths with the status bar intact", () => {
  const base = {
    rows: 24,
    sessions: [{ id: "a", title: "Session", messageCount: 2, updatedAt: Date.now(), pinned: true }],
    projects: [],
    providers: [],
    allModels: [{ model: "fake-1", context: 8192, free: true }],
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi **there**\n\n```js\nconst x = 1\n```" }
    ],
    composer: "draft",
    cursor: 3,
    model: "auto",
    mode: "build",
    tokens: 42_000,
    context: 128_000,
    sidebar: true
  }
  for (const cols of [50, 80, 120]) {
    const frame = renderScreen({ ...base, cols })
    assert.equal(frame.lines.length, 24)
    for (const line of frame.lines) assert.equal(textWidth(plain(line)), cols, plain(line))
    assert.match(frame.text, /ctrl\+p commands/)
  }
})

test("shows the busy task block and usage totals", () => {
  const state = {
    cols: 100,
    rows: 28,
    sessions: [],
    projects: [],
    providers: [],
    allModels: [],
    messages: [],
    composer: "",
    cursor: 0,
    model: "fake-1",
    mode: "build",
    tokens: 0,
    context: 8192,
    busy: true,
    streamingText: "hello",
    spinner: "⠋",
    sidebar: true,
    usage: {
      today: { tokens_in: 10, tokens_out: 20, requests: 2 },
      month: { tokens_in: 100, tokens_out: 200, requests: 9 }
    }
  }
  const busy = renderScreen(state)
  assert.match(busy.text, /Build/)
  const usage = renderScreen({ ...state, modal: { type: "usage" }, busy: false })
  assert.match(usage.text, /30 tokens · 2 requests/)
  assert.match(usage.text, /300 tokens · 9 requests/)
})

test("times out a stalled stream instead of hanging", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: delta\ndata: {\"text\":\"a\"}\n\n"))
    }
  })
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
  const seen = []
  await assert.rejects(
    (async () => {
      for await (const event of readSse(response, null, { idleMs: 60 })) seen.push(event)
    })(),
    /stream stalled/
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].event, "delta")
})

test("cancels a stalled stream as soon as the turn is aborted", async () => {
  const stream = new ReadableStream({ start() {} })
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 40)
  const started = Date.now()
  for await (const _event of readSse(response, controller.signal, { idleMs: 30_000 })) {
    assert.fail("no events expected")
  }
  assert.ok(Date.now() - started < 2000)
})
