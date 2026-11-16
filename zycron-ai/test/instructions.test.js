import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildMessages } from "../src/agent.js"
import { getSettings, openDb } from "../src/db.js"
import { readProjectInstructions } from "../src/projects.js"

function tempProject(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zycron-agents-"))
  if (content !== undefined) fs.writeFileSync(path.join(root, "AGENTS.md"), content)
  return { id: "test", name: "Test", path: root }
}

test("reads AGENTS.md from the project root", () => {
  const project = tempProject("# Rules\n\nUse tabs.\n")
  const instructions = readProjectInstructions(project)
  assert.equal(instructions.path, "AGENTS.md")
  assert.match(instructions.content, /Use tabs/)
  assert.equal(instructions.truncated, false)
})

test("returns null when AGENTS.md is absent", () => {
  const project = tempProject()
  assert.equal(readProjectInstructions(project), null)
})

test("truncates oversized AGENTS.md", () => {
  const project = tempProject("x".repeat(1200))
  const instructions = readProjectInstructions(project, 1000)
  assert.equal(instructions.content.length, 1000)
  assert.equal(instructions.truncated, true)
})

test("injects AGENTS.md into the system prompt", () => {
  const project = tempProject("Always run the focused test suite before reporting.")
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "zycron-db-"))
  const db = openDb(path.join(data, "test.db"))
  const conversation = {
    id: "conversation-1",
    mode: "build",
    compact_at: null,
    system_prompt: "",
    provider_id: "auto",
    model: "auto",
    project_id: project.id
  }
  const messages = buildMessages(db, conversation, getSettings(db), project, data)
  assert.equal(messages[0].role, "system")
  assert.match(messages[0].content, /PROJECT INSTRUCTIONS from AGENTS\.md/)
  assert.match(messages[0].content, /focused test suite/)
  db.close()
  fs.rmSync(data, { recursive: true, force: true })
  fs.rmSync(project.path, { recursive: true, force: true })
})
