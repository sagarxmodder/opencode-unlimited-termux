import path from "node:path"
import { dataDir } from "./config.js"
import { collect, httpRequest } from "./providers.js"
import { parseKeys, readJson, slugify, writeJson } from "./util.js"

const CACHE_TTL = 12 * 60 * 60 * 1000

const CATALOG = [
  { id: "or-openrouter-free", provider: "openrouter", model: "openrouter/free", context: 200000, tools: true, free: true },
  { id: "or-recursive-flint-v1-0", provider: "openrouter", model: "recursive/flint-v1.0:free", context: 262144, tools: true, free: true },
  { id: "or-cohere-north-mini-code", provider: "openrouter", model: "cohere/north-mini-code:free", context: 256000, tools: true, free: true },
  { id: "or-dots-studio-dots-3-note-preview", provider: "openrouter", model: "dots-studio/dots-3-note-preview:free", context: 512000, tools: true, free: true },
  { id: "or-thinkingmachines-inkling-2-small", provider: "openrouter", model: "thinkingmachines/inkling-2-small:free", context: 1048576, tools: true, free: true },
  { id: "or-nvidia-nemotron-3-ultra-550b-a55b", provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", context: 1000000, tools: true, free: true },
  { id: "or-nvidia-nemotron-3-5-lightning", provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free", context: 1000000, tools: true, free: true },
  { id: "or-nvidia-nemotron-3-nano-omni-30b-a3b-reasoning", provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", context: 256000, tools: true, free: true },
  { id: "or-nvidia-nemotron-3-5-super-vl", provider: "openrouter", model: "nvidia/nemotron-3.5-super-vl:free", context: 1000000, tools: true, free: true },
  { id: "or-inclusionai-ling-3-2-flash", provider: "openrouter", model: "inclusionai/ling-3.2-flash:free", context: 1048576, tools: true, free: true },
  { id: "or-baidu-ernie-5-5-flash-preview", provider: "openrouter", model: "baidu/ernie-5.5-flash-preview:free", context: 1024000, tools: true, free: true },
  { id: "or-particle-ai-particle-1", provider: "openrouter", model: "particle-ai/particle-1:free", context: 1048576, tools: true, free: true },
  { id: "or-google-gemma-4-31b-it", provider: "openrouter", model: "google/gemma-4-31b-it:free", context: 262144, tools: true, free: true },
  { id: "or-google-gemma-4-26b-a4b-it", provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free", context: 262144, tools: true, free: true },
  { id: "or-liquid-lfm-3-1-7b", provider: "openrouter", model: "liquid/lfm-3-1.7b:free", context: 262144, tools: true, free: true },

  { id: "llm7-gpt-oss-20b", provider: "llm7", model: "gpt-oss:20b", context: 128000, tools: true, free: true },
  { id: "llm7-minimax-m27", provider: "llm7", model: "minimax-m2.7", context: 200000, tools: true, free: true },
  { id: "llm7-deepseek-v4-flash", provider: "llm7", model: "DeepSeek-V4-Flash-0731", context: 400000, tools: true, free: true },
  { id: "llm7-glm-53-flash", provider: "llm7", model: "glm-5.3-flash", context: 200000, tools: true, free: true },
  { id: "llm7-codestral", provider: "llm7", model: "codestral-latest", context: 32000, tools: true, free: true },

  { id: "groq-llama33", provider: "groq", model: "llama-3.3-70b-versatile", context: 131072, tools: true, free: true },
  { id: "groq-kimi-k2", provider: "groq", model: "moonshotai/kimi-k2-instruct", context: 131072, tools: true, free: true },
  { id: "groq-qwen3-32b", provider: "groq", model: "qwen/qwen3-32b", context: 131072, tools: true, free: true },
  { id: "groq-llama31-8b", provider: "groq", model: "llama-3.1-8b-instant", context: 131072, tools: true, free: true },

  { id: "gemini-25-flash", provider: "gemini", model: "gemini-2.5-flash", context: 1048576, tools: true, free: true },
  { id: "gemini-20-flash", provider: "gemini", model: "gemini-2.0-flash", context: 1048576, tools: true, free: true },
  { id: "gemini-25-flash-lite", provider: "gemini", model: "gemini-2.5-flash-lite", context: 1048576, tools: true, free: true },

  { id: "cerebras-llama33", provider: "cerebras", model: "llama-3.3-70b", context: 32768, tools: true, free: true },
  { id: "cerebras-qwen3-32b", provider: "cerebras", model: "qwen-3-32b", context: 32768, tools: true, free: true },

  { id: "mistral-devstral", provider: "mistral", model: "devstral-small-latest", context: 131072, tools: true, free: true },
  { id: "mistral-nemo", provider: "mistral", model: "open-mistral-nemo", context: 131072, tools: true, free: true },

  { id: "gh-gpt41-mini", provider: "github", model: "openai/gpt-4.1-mini", context: 128000, tools: true, free: true },
  { id: "gh-gpt4o-mini", provider: "github", model: "openai/gpt-4o-mini", context: 128000, tools: true, free: true },

  { id: "samba-llama33", provider: "sambanova", model: "Meta-Llama-3.3-70B-Instruct", context: 131072, tools: true, free: true },

  { id: "nvidia-deepseek-r1", provider: "nvidia", model: "deepseek-ai/deepseek-r1", context: 131072, tools: false, free: true },
  { id: "nvidia-qwen25-coder", provider: "nvidia", model: "qwen/qwen2.5-coder-32b-instruct", context: 32768, tools: false, free: true },

  { id: "pol-openai", provider: "pollinations", model: "openai", context: 128000, tools: true, free: true },
  { id: "pol-openai-fast", provider: "pollinations", model: "openai-fast", context: 128000, tools: true, free: true },

  { id: "ollama-qwen25-coder", provider: "ollama", model: "qwen2.5-coder:7b", context: 32768, tools: true, free: true },
  { id: "ollama-llama32", provider: "ollama", model: "llama3.2:3b", context: 131072, tools: true, free: true },
  { id: "ollama-deepseek-r1", provider: "ollama", model: "deepseek-r1:8b", context: 65536, tools: false, free: true },

  { id: "lmstudio-local", provider: "lmstudio", model: "local-model", context: 32768, tools: false, free: true }
]

function cacheFile() {
  return path.join(dataDir(), "openrouter-free.json")
}

function isFreeModel(model) {
  const id = String(model?.id || "")
  if (!id.includes("/")) return false
  if (id.endsWith(":free")) return true
  const prompt = Number(model?.pricing?.prompt ?? 1)
  const completion = Number(model?.pricing?.completion ?? 1)
  return prompt === 0 && completion === 0
}

function toEntry(model) {
  const params = Array.isArray(model?.supported_parameters) ? model.supported_parameters : []
  return {
    id: `or-${slugify(String(model.id).replace(/:free$/, ""))}`,
    provider: "openrouter",
    model: model.id,
    context: Number(model.context_length) || Number(model.top_provider?.context_length) || 0,
    tools: params.length ? params.includes("tools") : true,
    free: true
  }
}

async function fetchOpenRouter(apiKey, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const response = await httpRequest({
      url: "https://openrouter.ai/api/v1/models",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json"
      },
      signal: controller.signal
    })
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
    const text = await collect(response.stream, 4 * 1024 * 1024)
    const data = JSON.parse(text)
    const entries = (data.data || []).filter(isFreeModel).map(toEntry)
    if (!entries.length) throw new Error("no free models returned")
    return entries
  } finally {
    clearTimeout(timer)
  }
}

export async function openRouterCatalog(apiKey, timeoutMs = 4000) {
  const cache = readJson(cacheFile(), null)
  const fresh = cache && Date.now() - Number(cache.time || 0) < CACHE_TTL && Array.isArray(cache.entries)
  if (fresh) return cache.entries
  try {
    const entries = await fetchOpenRouter(apiKey, timeoutMs)
    writeJson(cacheFile(), { time: Date.now(), entries })
    return entries
  } catch (error) {
    if (cache?.entries?.length) return cache.entries
    throw error
  }
}

export function curatedCatalog() {
  return CATALOG.map((entry) => ({ ...entry }))
}

export function configCatalog(config) {
  const list = Array.isArray(config?.models) ? config.models : []
  return list
    .filter((entry) => entry && entry.id && entry.provider && entry.model)
    .map((entry) => ({ context: 0, tools: true, free: true, ...entry }))
}

export function mergeCatalog(base, extra) {
  const byId = new Map((base || []).map((entry) => [entry.id, entry]))
  for (const entry of extra || []) {
    if (!entry?.id) continue
    byId.set(entry.id, { ...(byId.get(entry.id) || {}), ...entry })
  }
  return [...byId.values()]
}

export async function buildCatalog(config, { discover = true, timeoutMs = 4000 } = {}) {
  let catalog = mergeCatalog(curatedCatalog(), configCatalog(config))
  if (!discover) return catalog
  const configured = config?.providers?.openrouter?.apiKey
  const key = parseKeys(configured)[0] || parseKeys(process.env.OPENROUTER_API_KEY)[0]
  if (!key) return catalog
  try {
    const dynamic = await openRouterCatalog(key, timeoutMs)
    catalog = mergeCatalog(catalog, dynamic)
  } catch {
    return catalog
  }
  return catalog
}

export function catalogSummary(catalog, pool) {
  const ready = catalog.filter((entry) => {
    const provider = pool?.providerFor?.(entry)
    return provider?.baseUrl && pool?.hasCredentials?.(provider)
  })
  return {
    total: catalog.length,
    ready: ready.length,
    tools: catalog.filter((entry) => entry.tools).length
  }
}
