# ZYCRON AI

Local-first AI chat and coding-agent web app for Termux and desktop. One Node.js process, a browser UI, SQLite persistence, streaming model calls, a sandboxed workspace, and approval-gated tools.

Built and maintained by **@ItzsagarOp**. Zero npm dependencies.

## Features

- **Free-first routing** across 14 providers and 49 models (44 free), including keyless LLM7, Pollinations, Ollama and LM Studio.
- **Streaming chat** with reasoning text, provider fallback, token usage, and stop/regenerate.
- **Coding agent** with project files, search, shell commands, undo/redo and per-action approvals.
- **Workspace editor** with explorer, tabs, syntax highlighting, project search and a terminal panel.
- **Sessions** with pin, archive, duplicate, rename, export and full-text search.
- **Projects** with a root `AGENTS.md` guide injected into every model turn.
- **AMOLED UI** in the opencode/ZYCRON terminal-chat style: block messages with left accent rules, composer hints and a live status bar.
- **Local data**: API keys encrypted at rest, optional token auth, no telemetry.

## Quick start

```bash
cd zycron-ai
npm start
```

Open `http://127.0.0.1:8787`. Node.js 22.5+ is required (`node:sqlite`).

On Termux:

```bash
pkg install nodejs
cd ~/opencode-unlimited-termux/zycron-ai
npm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZYCRON_PORT` / `PORT` | `8787` | HTTP port |
| `ZYCRON_HOST` | `127.0.0.1` | Bind address |
| `ZYCRON_DATA` | `~/.local/share/zycron-ai` | Database, uploads, backups, secret |
| `ZYCRON_WORKSPACE` | `~/zycron-projects` | Project root |
| `ZYCRON_TOKEN` | empty | Require `x-zycron-token` or `?token=` |
| `ZYCRON_SECRET` | local secret file | Encryption key for provider API keys |

Settings, providers and models can be managed from the UI. Keys are never logged or returned in plaintext.

## Tests

```bash
npm test
```

Use a temporary `ZYCRON_DATA` and a non-default port when smoke-testing. For agent tests prefer a local OpenAI-compatible stub over paid or rate-limited APIs.

## Layout

```
server.js            startup and environment
src/app.js           HTTP router, auth, SSE, static files
src/agent.js         agent loop, prompt, tools, approvals
src/providers.js     provider/model catalog and streaming
src/projects.js      sandboxed files, search, commands, AGENTS.md
src/db.js            SQLite schema and settings
src/presets.js       bundled provider catalog
public/index.html    app shell and icon sprite
public/app.js        browser state, API/SSE client, workspace UI
public/styles.css    AMOLED responsive theme
public/markdown.js   safe markdown and syntax highlighting
```

The full contributor and agent guide is in [`AGENTS.md`](AGENTS.md).
