# ZYCRON AI

Local-first AI chat and coding-agent for Termux and desktop. One Node.js process, a browser UI plus an AMOLED terminal client, SQLite persistence, streaming model calls, a sandboxed workspace, and approval-gated tools.

Built and maintained by **@ItzsagarOp**. Zero npm dependencies.

## Features

- **Free-first routing** across 14 providers and 49 models (44 free), including keyless LLM7, Pollinations, Ollama and LM Studio.
- **Streaming chat** with reasoning text, provider fallback, token usage, and stop/regenerate.
- **Coding agent** with project files, search, shell commands, undo/redo and per-action approvals.
- **Workspace editor** with explorer, tabs, syntax highlighting, project search and a terminal panel.
- **Sessions** with pin, archive, duplicate, rename, export and full-text search.
- **Projects** with a root `AGENTS.md` guide injected into every model turn.
- **AMOLED UI** in the opencode/ZYCRON terminal-chat style: block messages with left accent rules, composer hints and a live status bar — in the browser and in the terminal (`npm run tui`).
- **Flow video studio** at `/flow`: write a scene-by-scene storyboard, generate keyless images, render a WebM film in the browser, or hand the story to a Sora/Veo provider.
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

## Terminal client

```bash
npm run tui        # or: node bin/zycron
```

On Termux the shared `/sdcard` mount drops execute bits, so link the launcher once:

```bash
printf '#!/data/data/com.termux/files/usr/bin/bash\nexec node ~/opencode-unlimited-termux/zycron-ai/bin/zycron "$@"\n' > $PREFIX/bin/zycron
chmod +x $PREFIX/bin/zycron
```

It starts the local server if needed, then opens the AMOLED terminal UI: streaming chat with tool/approval modals, sessions, models, providers, projects, undo/redo, and the command palette. Flags: `--url <base>` / `--token <token>` attach to an already running server, `--no-spawn` disables auto-start, `-h` and `-v` print help and the version. Keys: `ctrl+p` palette, `ctrl+n` new, `ctrl+k` sessions, `ctrl+m` models, `ctrl+t` providers, `ctrl+x` leader (`n l m a s c u r b q`), `tab` mode, `esc` interrupt.

## Flow video studio

Open `http://127.0.0.1:8787/flow` (or the **Flow Studio** entry in the sidebar).

1. Type an idea in the **Create** bar (or tap the mic and speak) and hit **Create** — it writes the scene, paints it, narrates it, renders the film, and downloads it in one pass.
2. Or work scene by scene: prompt, duration, camera move, style, aspect ratio, seed. **Generate storyboard** paints each scene with your image provider (`/images/generations`), free Pollinations, or an uploaded frame; if painting fails it falls back to typographic frames.
3. **Narration**: dictation uses the browser Speech API, **Preview** speaks with the device voice, and **Generate voice** writes an MP3 track via the picked provider's `/audio/speech` or the free Google TTS engine. **Render video** mixes the track into the WebM.
4. **AI video** mode sends the full story to a configured provider instead: OpenAI-style `POST /videos` (Sora) or Gemini/Veo `predictLongRunning`, using the provider key saved in Settings.

Storyboard mode needs no key. Files live in `ZYCRON_DATA/videos`; uploads are capped at 200 MB.

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
