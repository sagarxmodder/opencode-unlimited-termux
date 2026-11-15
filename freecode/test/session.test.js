import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { Session } from "../src/session.js"

function tempConfig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-sessions-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { sessionDir: dir, providers: {}, models: [], preferred: [] }
}

test("sessions persist and reload messages", (t) => {
  const config = tempConfig(t)
  const session = Session.create(config, "/work/project")
  session.append({ role: "user", content: "hello" })
  session.append({ role: "assistant", content: "hi" })
  assert.equal(session.messageCount, 2)
  assert.ok(fs.existsSync(session.file))

  const loaded = Session.load(config, session.id)
  assert.ok(loaded)
  assert.equal(loaded.id, session.id)
  assert.equal(loaded.cwd, "/work/project")
  assert.deepEqual(loaded.messages.map((message) => message.content), ["hello", "hi"])
})

test("sessions can be loaded from an absolute file path", (t) => {
  const config = tempConfig(t)
  const session = Session.create(config, "/work/project")
  session.append({ role: "user", content: "x" })
  const loaded = Session.load(config, session.file)
  assert.ok(loaded)
  assert.equal(loaded.id, session.id)
})

test("missing sessions return null", (t) => {
  const config = tempConfig(t)
  assert.equal(Session.load(config, "does-not-exist"), null)
})

test("list and latest return stored sessions", (t) => {
  const config = tempConfig(t)
  const first = Session.create(config, "/one")
  first.append({ role: "user", content: "a" })
  const second = Session.create(config, "/two")
  second.append({ role: "user", content: "b" })

  const list = Session.list(config)
  assert.equal(list.length, 2)
  const labels = list.map((item) => item.id).sort()
  assert.deepEqual(labels, [first.id, second.id].sort())

  const latest = Session.latest(config, "/one")
  assert.ok(latest)
  assert.equal(latest.cwd, "/one")
})
