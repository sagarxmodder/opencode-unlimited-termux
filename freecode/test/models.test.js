import test from "node:test"
import assert from "node:assert/strict"
import { PROVIDERS } from "../src/providers.js"
import {
  buildCatalog,
  configCatalog,
  curatedCatalog,
  mergeCatalog
} from "../src/models.js"

test("curated catalog is unique and references known providers", () => {
  const catalog = curatedCatalog()
  assert.ok(catalog.length >= 20)
  const ids = new Set()
  for (const entry of catalog) {
    assert.ok(entry.id, "entry id missing")
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`)
    ids.add(entry.id)
    assert.ok(PROVIDERS[entry.provider], `unknown provider ${entry.provider}`)
    assert.equal(typeof entry.tools, "boolean")
    assert.ok(entry.model)
  }
})

test("keyless providers ship usable catalog entries", () => {
  const catalog = curatedCatalog()
  for (const name of ["llm7", "pollinations"]) {
    assert.equal(PROVIDERS[name].keyless, true, `${name} should be keyless`)
    assert.ok(catalog.some((entry) => entry.provider === name), `${name} has no curated models`)
  }
  assert.ok(catalog.some((entry) => entry.id === "llm7-gpt-oss-20b" && entry.tools))
})

test("config models are merged and can override curated entries", async () => {
  const config = {
    models: [
      { id: "or-openrouter-free", provider: "openrouter", model: "custom/model", context: 1000, tools: false },
      { id: "local-custom", provider: "ollama", model: "my-model:7b", tools: true }
    ]
  }
  assert.equal(configCatalog(config).length, 2)
  const catalog = await buildCatalog(config, { discover: false })
  const override = catalog.find((entry) => entry.id === "or-openrouter-free")
  assert.equal(override.model, "custom/model")
  assert.equal(override.tools, false)
  const custom = catalog.find((entry) => entry.id === "local-custom")
  assert.equal(custom.provider, "ollama")
})

test("mergeCatalog keeps base order and appends new entries", () => {
  const base = [{ id: "a", provider: "ollama", model: "a" }]
  const merged = mergeCatalog(base, [
    { id: "a", model: "b" },
    { id: "b", provider: "ollama", model: "c" }
  ])
  assert.equal(merged[0].id, "a")
  assert.equal(merged[0].model, "b")
  assert.equal(merged[1].id, "b")
})
