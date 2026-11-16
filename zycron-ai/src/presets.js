export const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    free: false,
    keyless: false,
    docs: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", free: false, vision: true, tools: true, context: 1048576 },
      { id: "gpt-4o-mini", label: "GPT-4o mini", free: false, vision: true, tools: true, context: 128000 },
      { id: "gpt-4.1", label: "GPT-4.1", free: false, vision: true, tools: true, context: 1048576 }
    ]
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    free: false,
    keyless: false,
    docs: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", free: false, vision: false, tools: true, context: 131072 },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", free: false, vision: false, tools: true, context: 131072 }
    ]
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    free: true,
    keyless: false,
    docs: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", free: true, vision: true, tools: true, context: 1048576 },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", free: true, vision: true, tools: true, context: 1048576 },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", free: true, vision: true, tools: true, context: 1048576 }
    ]
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    free: true,
    keyless: false,
    docs: "https://openrouter.ai/keys",
    models: [
      { id: "openrouter/free", label: "OpenRouter Free Router", free: true, vision: false, tools: true, context: 200000 },
      { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek V3 free", free: true, vision: false, tools: true, context: 163840 },
      { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder free", free: true, vision: false, tools: true, context: 262144 },
      { id: "recursive/flint-v1.0:free", label: "Recursive Flint v1.0 free", free: true, vision: false, tools: true, context: 262144 },
      { id: "cohere/north-mini-code:free", label: "Cohere North Mini Code free", free: true, vision: false, tools: true, context: 256000 },
      { id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note Preview free", free: true, vision: false, tools: true, context: 512000 },
      { id: "thinkingmachines/inkling-2-small:free", label: "Inkling 2 Small free", free: true, vision: false, tools: true, context: 1048576 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra free", free: true, vision: false, tools: true, context: 1000000 },
      { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning free", free: true, vision: false, tools: true, context: 1000000 },
      { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni free", free: true, vision: false, tools: true, context: 256000 },
      { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL free", free: true, vision: true, tools: true, context: 1000000 },
      { id: "inclusionai/ling-3.2-flash:free", label: "Ling 3.2 Flash free", free: true, vision: false, tools: true, context: 1048576 },
      { id: "baidu/ernie-5.5-flash-preview:free", label: "ERNIE 5.5 Flash free", free: true, vision: false, tools: true, context: 1024000 },
      { id: "particle-ai/particle-1:free", label: "Particle 1 free", free: true, vision: false, tools: true, context: 1048576 },
      { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B free", free: true, vision: false, tools: true, context: 262144 },
      { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B free", free: true, vision: false, tools: true, context: 262144 },
      { id: "liquid/lfm-3-1.7b:free", label: "LFM 3 1.7B free", free: true, vision: false, tools: true, context: 262144 }
    ]
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    free: true,
    keyless: false,
    docs: "https://console.groq.com/keys",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", free: true, vision: false, tools: true, context: 131072 },
      { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2 Instruct", free: true, vision: false, tools: true, context: 131072 },
      { id: "qwen/qwen3-32b", label: "Qwen3 32B", free: true, vision: false, tools: true, context: 131072 },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", free: true, vision: false, tools: true, context: 131072 }
    ]
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    free: true,
    keyless: false,
    docs: "https://cloud.cerebras.ai",
    models: [
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", free: true, vision: false, tools: true, context: 32768 },
      { id: "qwen-3-32b", label: "Qwen3 32B", free: true, vision: false, tools: true, context: 32768 }
    ]
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    free: true,
    keyless: false,
    docs: "https://console.mistral.ai/api-keys",
    models: [
      { id: "devstral-small-latest", label: "Devstral Small", free: true, vision: false, tools: true, context: 131072 },
      { id: "open-mistral-nemo", label: "Mistral Nemo", free: true, vision: false, tools: true, context: 131072 }
    ]
  },
  {
    id: "github",
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    free: true,
    keyless: false,
    docs: "https://github.com/settings/tokens",
    models: [
      { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", free: true, vision: true, tools: true, context: 128000 },
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini", free: true, vision: true, tools: true, context: 128000 }
    ]
  },
  {
    id: "sambanova",
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    free: true,
    keyless: false,
    docs: "https://cloud.sambanova.ai/apis",
    models: [
      { id: "Meta-Llama-3.3-70B-Instruct", label: "Llama 3.3 70B", free: true, vision: false, tools: true, context: 131072 }
    ]
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    free: true,
    keyless: false,
    docs: "https://build.nvidia.com",
    models: [
      { id: "deepseek-ai/deepseek-r1", label: "DeepSeek R1", free: true, vision: false, tools: false, context: 131072 },
      { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B", free: true, vision: false, tools: false, context: 32768 }
    ]
  },
  {
    id: "llm7",
    name: "LLM7",
    baseUrl: "https://api.llm7.io/v1",
    free: true,
    keyless: true,
    docs: "https://api.llm7.io",
    models: [
      { id: "gpt-oss:20b", label: "GPT-OSS 20B", free: true, vision: false, tools: true, context: 128000 },
      { id: "minimax-m2.7", label: "MiniMax M2.7", free: true, vision: false, tools: true, context: 200000 },
      { id: "DeepSeek-V4-Flash-0731", label: "DeepSeek V4 Flash", free: true, vision: false, tools: true, context: 400000 },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash", free: true, vision: false, tools: true, context: 200000 },
      { id: "codestral-latest", label: "Codestral", free: true, vision: false, tools: true, context: 32000 }
    ]
  },
  {
    id: "pollinations",
    name: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    free: true,
    keyless: true,
    docs: "https://pollinations.ai",
    models: [
      { id: "openai", label: "Pollinations OpenAI", free: true, vision: false, tools: true, context: 128000 },
      { id: "openai-fast", label: "Pollinations OpenAI Fast", free: true, vision: false, tools: true, context: 128000 }
    ]
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    free: true,
    keyless: true,
    docs: "https://ollama.com",
    models: [
      { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", free: true, vision: false, tools: true, context: 32768 },
      { id: "llama3.2:3b", label: "Llama 3.2 3B", free: true, vision: false, tools: true, context: 131072 },
      { id: "deepseek-r1:8b", label: "DeepSeek R1 8B", free: true, vision: false, tools: false, context: 65536 }
    ]
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    free: true,
    keyless: true,
    docs: "https://lmstudio.ai",
    models: [
      { id: "local-model", label: "Local model", free: true, vision: false, tools: false, context: 32768 }
    ]
  }
]

export const CUSTOM_PROVIDER = {
  id: "custom",
  name: "Custom endpoint",
  baseUrl: "",
  free: true,
  keyless: false,
  docs: "",
  models: []
}
