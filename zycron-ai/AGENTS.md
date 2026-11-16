# ZYCRON AI — Agent Instructions

Maintained by **@ItzsagarOp**. This file is the project guide for AI coding agents working on ZYCRON AI. It is also loaded by ZYCRON at runtime when this directory is the active project. Keep it accurate when the architecture changes.

## Project

ZYCRON AI is a local-first AI chat and coding-agent web app. It is a single Node.js service with a vanilla browser UI, SQLite persistence, streaming provider calls, workspace editing, and approval-gated tools.

- Runtime: Node.js 22.5+ with `node:sqlite`; developed on Node 24.
- Dependencies: none. Use Node built-ins and browser APIs only.
- No build step. `server.js` serves `public/` directly.
- Start: `npm start` (defaults to `127.0.0.1:8787`).
- Test: `npm test` (`node --test test/*.test.js`).

## Architecture

- `server.js` — environment parsing and process startup.
- `src/app.js` — HTTP server, auth, REST API, SSE chat stream, static files.
- `src/db.js` — SQLite schema, migrations, defaults, settings, usage accounting.
- `src/providers.js` — provider/model CRUD, encrypted API keys, streaming and fallbacks.
- `src/agent.js` — agent loop, system prompt assembly, tools, approvals, SSE events.
- `src/projects.js` — sandboxed project tree, file operations, search, command runner, `AGENTS.md` loading.
- `src/changes.js` — file snapshots for undo/redo.
- `src/backup.js` — database backups and pruning.
- `src/uploads.js` — attachment storage.
- `src/plugins.js` — optional local plugin hooks.
- `src/presets.js` — bundled provider and free-model catalog.
- `public/index.html` — app shell and SVG icon sprite.
- `public/styles.css` — AMOLED responsive UI.
- `public/app.js` — browser controller, state, API/SSE client, dialogs, workspace editor.
- `public/markdown.js` — safe markdown rendering and syntax highlighting.

## HTTP API

All API responses are JSON. Errors use `{ "error": "message" }` with the matching status code. With `ZYCRON_TOKEN` set, send `x-zycron-token` or `?token=`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness probe |
| GET | `/api/bootstrap` | App, settings, providers, models, conversations, projects, plugins, usage, backup |
| GET/PATCH | `/api/settings` | Read or patch runtime settings |
| GET | `/api/usage` | Token usage today, month, per provider |
| GET/POST/DELETE | `/api/conversations` | List/search, create, delete (optionally keep pinned) |
| GET/PATCH | `/api/conversations/:id` | Load messages or rename, change model/mode/project |
| PATCH | `/api/messages/:id` | Edit a user message |
| POST | `/api/conversations/:id/:action` | `undo` or `redo` the latest file change |
| POST | `/api/chat` | Start a streaming agent turn (SSE response) |
| POST | `/api/chat/regenerate` | Regenerate the last assistant turn |
| POST | `/api/chat/:id/stop` | Abort a running stream |
| GET | `/api/approvals` | Pending approval requests |
| POST | `/api/approvals/:id` | `{ approve: true|false }` |
| GET/POST | `/api/providers` | List or add providers |
| PATCH/DELETE | `/api/providers/:id` | Update or remove a provider |
| POST | `/api/providers/:id/models` | Fetch the provider model catalog |
| GET | `/api/models` | List models (`q`, `provider`, `free`) |
| GET/POST | `/api/projects` | List or create projects |
| DELETE | `/api/projects/:id` | Remove a project (`deleteFiles=1` to wipe files) |
| GET | `/api/projects/:id/tree` | Recursive tree (`path`, `depth`) |
| GET/PUT/DELETE | `/api/projects/:id/file` | Read, write or delete a sandboxed file |
| POST | `/api/projects/:id/rename` | Rename a path |
| GET | `/api/projects/:id/search` | Literal search (`q`) |
| POST | `/api/projects/:id/replace` | Replace across text files |
| POST | `/api/projects/:id/run` | Run a shell command (UI-initiated) |
| GET | `/api/projects/:id/instructions` | Parsed root `AGENTS.md` |
| GET/POST | `/api/backup` | Latest backup or create one |
| POST | `/api/uploads` | Store an attachment |
| GET | `/api/plugins` | List plugin hooks |

## SSE contract

`POST /api/chat` returns `text/event-stream` blocks with `event:` and JSON `data:` payloads:

- `start` — request id, conversation id, provider/model.
- `thinking` — streamed reasoning text, when the provider exposes it.
- `delta` — streamed assistant text.
- `notice` — provider fallback or retry information.
- `tool_start` / `tool_end` — tool id, name, args, status, output.
- `approval` — approval id, kind, payload; the turn pauses until resolved.
- `usage` — token counts for the step.
- `step` — agent step index and tool count.
- `file_changed` — project id and path after a write/edit/delete.
- `project` — project list changed.
- `error`, `stopped`, `done` — terminal events.

Abort handling lives in `src/agent.js`; approvals resolve through `resolveApproval` and are also released when the stream is cancelled.

## Data model

SQLite lives at `ZYCRON_DATA/zycron.db`. Core tables: `conversations`, `messages`, `projects`, `providers`, `models`, `settings`, `approvals`, `usage`, `changes`, `plugins`. Approvals store a JSON payload and a `pending|approved|denied` status. `changes` stores before/after snapshots for undo/redo. Seeding uses `INSERT OR IGNORE`; never drop user rows in a migration.

## Chat UI

The browser UI follows the opencode/ZYCRON terminal chat layout:

- Messages are full-width blocks with a 3px left rule: blue for the user, violet for the assistant. Labels are uppercase (`YOU · MESSAGE`, `✦ ZYCRON AI`); content is borderless.
- Composer: `Enter` sends, `Shift+Enter` inserts a newline, `↑/↓` walks input history, `/` opens commands, `@` mentions project files, `#` mentions modes.
- Sidebar and top bar expose sessions, search, model, mode, project and export.
- The workspace modal provides a project list, explorer, editor tabs, syntax highlighting, save (`Ctrl+S`), project search and a terminal panel.
- The welcome hero appears only when the current session has no messages.

## Project instructions

`AGENTS.md` at the active project root is loaded into the system prompt before each model step. Root-level only; nested instruction files are ignored. Keep it under 24,000 characters because longer files are truncated. Project instructions guide conventions and workflow but must never bypass approval gates or sandbox checks.

## Data and security

- Default data: `~/.local/share/zycron-ai`; workspace: `~/zycron-projects`.
- Override with `ZYCRON_DATA`, `ZYCRON_WORKSPACE`, `ZYCRON_HOST`, `ZYCRON_PORT`.
- API keys are encrypted at rest with `ZYCRON_SECRET` or a local secret file.
- Optional client auth uses `ZYCRON_TOKEN` and the `x-zycron-token` header.
- All project paths must stay inside the project root. Reject symlink escapes.
- Agent writes, deletes, renames, project creation, and shell commands require approval.
- Plan and review modes are read-only.
- Never log API keys, bearer tokens, or decrypted secrets.
- Never weaken sandboxing or approval checks to make a test pass.

## Coding conventions

- ES modules, double quotes, no semicolons, two-space indentation.
- Prefer small exported functions and explicit error handling.
- Use `HttpError(status, message)` for API failures.
- Keep the dependency count at zero unless the user explicitly approves a dependency.
- Preserve existing database rows and settings during migrations; add columns/tables with guarded migrations.
- Use `INSERT OR IGNORE` when seeding presets so user changes survive restarts.
- Keep provider/model IDs stable; they are referenced by conversations and usage rows.
- Frontend code is plain JavaScript with `$`/`$$` helpers and delegated events. Do not introduce a framework or bundler.
- Escape untrusted text before inserting HTML. Markdown output must pass through `markdown.js` escaping.

## Free-model routing

- Routing is `free-first` by default. Free models and free providers are attempted before paid ones.
- Keyless providers: LLM7, Pollinations, Ollama, LM Studio.
- Key-required providers stay disabled until a key is saved.
- A provider is usable when it has a decrypted key or is keyless.
- Preserve fallback ordering, 60-second provider cooldowns, and the six-candidate limit.

## Verification

Before reporting work complete:

1. Run `node --check` on changed JavaScript files.
2. Run `npm test`; add tests for new behavior.
3. Smoke-test the server with a temporary `ZYCRON_DATA` and non-default port.
4. Confirm catalog counts after changes to `presets.js`.
5. For agent changes, test with a local fake OpenAI-compatible provider rather than a paid or rate-limited remote API.
6. Verify `AGENTS.md` changes are present in the assembled system prompt.

## Do not

- Do not commit `node_modules`, data directories, uploads, backups, `.env`, or secrets.
- Do not edit generated backups or runtime SQLite files.
- Do not silently remove features, providers, or free models.
- Do not rewrite the UI into a framework or add a build pipeline.
- Do not bypass the approval flow with direct filesystem writes from agent tools.
