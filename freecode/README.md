# freecode

Terminal coding agent that runs on free model tiers and fails over automatically when one model is rate-limited, missing, or does not support tools. Zero npm dependencies, Node built-ins only, Termux-friendly.

```
freecode "fix the failing test in src/app.test.js"
```

## Features

- Automatic failover across a catalog of free OpenAI-compatible models.
- Per-provider API key rotation (comma-separated keys), cooldowns, and model penalty memory.
- Retries without tools when a provider rejects function calling.
- Streaming output, tool calls, sessions, context trimming and retry on context overflow.
- REPL pickers: `/model` lists ready models by number, `/sessions` lists saved sessions, and the prompt shows the active model + short session id.
- Built-in tools: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `webfetch`.
- OpenRouter free-model discovery (cached), plus a curated fallback catalog.
- Local models via Ollama or LM Studio; no key required.
- HTTP proxy support through `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` and `NO_PROXY`.

## Requirements

- Node.js 18 or newer (`pkg install nodejs` on Termux).
- No key needed to start: LLM7 and Pollinations are keyless. Add any provider key below for higher limits, or run a local Ollama / LM Studio server.

## Install

```bash
cd freecode
bash install.sh
```

On Termux with the warp lane installed, skip this: `oc` → `2` installs and launches freecode from `~/.local/share/opencode-unlimited-warp/freecode`. Standalone, the script links `bin/freecode` into `$PREFIX/bin` on Termux, or `~/.local/bin` otherwise. You can also run it directly:

```bash
node /path/to/freecode/bin/freecode --help
```

## Keys

Keyless providers (LLM7, Pollinations) work without setup. Keyed providers are used only when their key is present. Free keyless tiers are rate-limited; failover keeps the agent moving.

| Provider | Environment variable | Notes |
| --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | Many `:free` models; discovery updates the catalog |
| Groq | `GROQ_API_KEY` | Fast free tier |
| Google AI Studio | `GEMINI_API_KEY` | OpenAI-compatible endpoint |
| Cerebras | `CEREBRAS_API_KEY` | Free tier |
| Mistral | `MISTRAL_API_KEY` | Free tier |
| GitHub Models | `GITHUB_TOKEN` | Free with a GitHub token |
| SambaNova | `SAMBANOVA_API_KEY` | Free tier |
| NVIDIA NIM | `NVIDIA_API_KEY` | Free credits |
| Pollinations | `POLLINATIONS_API_KEY` | Keyless; free tier allows roughly one reply per 45s per IP |
| LLM7 | `LLM7_API_KEY` | Keyless; anonymous daily token quota, token optional |

```bash
export OPENROUTER_API_KEY=sk-or-...
export GROQ_API_KEY=gsk_...
freecode doctor
```

## Local models

```bash
ollama serve
ollama pull qwen2.5-coder:7b
freecode --model ollama-qwen25-coder
```

LM Studio works through its OpenAI-compatible server on `127.0.0.1:1234` (`freecode --model lmstudio-local`).

## Usage

```bash
freecode                          # interactive REPL
freecode "add input validation"   # one-shot
freecode doctor                   # provider and key status
freecode doctor --test            # send a tiny prompt through the failover pool
freecode models                   # full catalog with availability
freecode -c                       # continue the latest session for this directory
freecode --session <id>           # load a specific session
freecode --model gemini-25-flash  # prefer a catalog id or upstream model name
freecode --model auto             # restore automatic failover order
freecode --offline                # skip OpenRouter discovery
```

Options: `--max-steps <n>`, `--timeout <seconds>`, `--no-color`, `--version`, `--help`.

REPL commands:

| Command | Action |
| --- | --- |
| `/help` | command reference |
| `/model` | numbered picker of ready models |
| `/model <n>` | switch by picker number |
| `/model <id>` | switch by catalog id or upstream model name |
| `/model auto` | back to automatic failover |
| `/models [all]` | catalog (only ready models, or everything) |
| `/sessions` | recent sessions for this directory, numbered |
| `/session <n\|id>` | switch to a session |
| `/new` · `/clear` | new session |
| `/continue` | latest session for this directory |
| `/status` | model, provider, session, context, cooldowns |
| `/retry` | resend the previous prompt |
| `/quit` | exit |

The prompt shows live context:

```
freecode [llm7-gpt-oss-20b · s:6217] ›
```

Tab completion works for commands, model ids and session ids.

## Failover behavior

1. Models are ranked by tools support, availability, the last successful model, and your preferred model.
2. On rate limits or auth failures the pool tries up to three keys per provider.
3. On a tool-related 400 the model is retried once without tools and marked as tool-less.
4. Rate-limited models cool down for 20 seconds; auth failures for an hour; missing models for six hours.
5. If every candidate fails, the pool waits briefly and retries ignoring cooldowns.
6. Context-overflow errors are surfaced to the agent, which trims older messages and retries.

## Configuration

Optional global config: `~/.config/freecode/config.json` (or `$XDG_CONFIG_HOME/freecode/config.json`). Project config: `.freecode.json` in the working directory, which overrides global values.

```json
{
  "model": "auto",
  "preferred": ["or-openrouter-free", "llm7-gpt-oss-20b", "groq-llama33"],
  "maxSteps": 40,
  "timeoutMs": 300000,
  "temperature": null,
  "sessionDir": "~/.local/share/freecode/sessions",
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-...",
      "headers": { "X-Title": "freecode" }
    },
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1"
    }
  },
  "models": [
    { "id": "my-model", "provider": "ollama", "model": "qwen2.5-coder:7b", "context": 32768, "tools": true }
  ]
}
```

- `providers.<name>.baseUrl` overrides any built-in endpoint.
- `providers.<name>.apiKey` can be a comma-separated key list.
- `providers.<name>.keyless: false` disables a keyless provider.
- `models` entries are merged into the catalog by `id`.

Storing keys in config is plain text. Environment variables are safer.

## Storage

- Sessions: `~/.local/share/freecode/sessions/<id>.json` (XDG-aware).
- OpenRouter discovery cache: `~/.local/share/freecode/openrouter-free.json` (12 hour TTL).

## Proxy

```bash
export HTTPS_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1,.local
```

HTTPS requests use a CONNECT tunnel followed by TLS. Local addresses bypass the proxy automatically.

## Tests

```bash
npm test
```

40 local-only tests cover SSE parsing, JSON responses, failover, key rotation, tool fallback, proxy CONNECT, provider summaries, sessions, file tools, the agent loop, and the CLI REPL (banner, model/session pickers) against a local fake OpenAI server. No live provider is called.

## Notes

- Free tiers change their model names and quotas. Use `freecode models` and `freecode doctor` when a model starts failing, or pin one with `--model`.
- LLM7 and Pollinations need no key, but both enforce per-IP anonymous limits. For heavier use, add a provider key or run local models.
- Provider and model identifiers in the curated catalog are best-effort; a stale model simply cools down and failover continues.
- The agent can run shell commands and write files in the current directory. Review its work like any other automated tool.

MIT license.
