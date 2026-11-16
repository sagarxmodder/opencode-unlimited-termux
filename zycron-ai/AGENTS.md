# ZYCRON AI — Agent Instructions

Maintained by **@ItzsagarOp**. This is the working guide for AI coding agents and contributors on ZYCRON AI. ZYCRON also injects this file into the model context when this directory is the active project, so it must stay accurate, specific, and under 24,000 characters.

## 0. How to use this guide

- Read this file before changing code.
- Treat every rule here as an invariant unless the operator explicitly overrides it.
- If the code and this document disagree, fix whichever is wrong and say which changed.
- Prefer small, verifiable changes over broad rewrites.
- Finish the task: working code, tests, and an honest report.

## 1. What ZYCRON AI is

ZYCRON AI is a local-first AI chat and coding-agent service. A single Node.js process provides:

- a streaming chat API with provider routing and fallbacks,
- a sandboxed project workspace with file and shell tools,
- approval-gated mutations with undo/redo snapshots,
- a vanilla browser client,
- a zero-dependency terminal client in `src/tui/` with a `zycron` launcher.

There is no cloud dependency, no telemetry, no build step, and no npm dependency. SQLite stores conversations, messages, providers, models, settings, approvals, usage, changes, and plugin state.

Design priorities, in order: working software, local data ownership, zero dependencies, safe tool boundaries.

## 2. Operating rules

1. **Zero dependencies.** Use Node built-ins and browser APIs only. Do not add packages, bundlers, frameworks, or build pipelines without explicit approval.
2. **Never fake behavior.** No placeholder features, mock data, or buttons that only render. If something is not implemented, say so.
3. **Preserve user data.** Never drop tables or rows, rewrite settings, delete uploads, or rotate keys in a migration. Add guarded columns/tables.
4. **Never weaken security.** Keep path sandboxing, symlink checks, approval gates, auth, and secret encryption intact. Tests never justify loosening them.
5. **Keep IDs stable.** Provider/model IDs are referenced by conversations, usage, and settings.
6. **Verify, then report.** Run the checks in §16 and state only what actually passed.
7. **Minimal diffs.** Do not refactor unrelated modules or rename public contracts without need.
8. **Phone-first.** The UI and terminal client must remain usable on Termux/Android and narrow screens.

## 3. Environment and commands

- Runtime: Node.js **22.5+** with `node:sqlite`; developed on Node 24.
- Default bind: `127.0.0.1:8787`.
- No install step. Start with `npm start`.
- Tests: `npm test` (`node --test test/*.test.js`).
- Terminal client: `npm run tui` (or `node bin/zycron`). It refuses to start without a TTY; pass `--url`/`--token` to attach to a running server, or `--no-spawn` to disable auto-start.
- Syntax-check changed files with `node --check FILE`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZYCRON_HOST` | `127.0.0.1` | Bind address |
| `PORT` / `ZYCRON_PORT` | `8787` | HTTP port (`PORT` wins) |
| `ZYCRON_DATA` | `~/.local/share/zycron-ai` | SQLite, secret, uploads, backups |
| `ZYCRON_WORKSPACE` | `~/zycron-projects` | Project roots |
| `ZYCRON_TOKEN` | empty | Optional client auth token |
| `ZYCRON_SECRET` | generated file | Provider-key encryption material |

Termux notes: `/tmp` may be read-only; use `$PREFIX/tmp` or another writable temp dir. `rg` may be unavailable; fall back to `grep -r`. Kill test servers by PID, never by a pattern that matches your own command line.

## 4. Repository map

```
server.js              env parsing, startup, backups, signal handling
src/app.js             HTTP router, auth, REST, SSE chat, static/uploads/previews
src/db.js              schema, guarded migrations, defaults, usage accounting
src/providers.js       provider/model CRUD, key encryption, streaming, fallbacks
src/agent.js           system prompt, agent loop, tools, approvals, SSE events
src/projects.js        sandboxed tree, file ops, search, replace, command runner
src/changes.js         before/after snapshots for undo/redo
src/backup.js          startup/auto/manual DB backups and pruning
src/uploads.js         attachment storage and serving
src/plugins.js         optional local beforeChat/afterResponse hooks
src/presets.js         bundled provider and free-model catalog
public/                vanilla browser client (HTML/CSS/JS, no build)
src/tui/               zero-dependency terminal client
test/                  node:test suites
```

Terminal client modules: `ansi.js` (palette, width/wrap, cell grid, clipboard), `markdown.js` (markdown → styled spans, code blocks), `keys.js` (escape-sequence/paste parser), `api.js` (HTTP/SSE client), `local.js` (health check, server spawn/stop), `render.js` (frame + modals), `app.js` (state, input, SSE), `main.js` (CLI entry), and the executable `bin/zycron`. It must reuse the HTTP/SSE API and the same SQLite data. Never create a second database or duplicate provider/router logic.

## 5. Chat request lifecycle

1. Client sends `POST /api/chat` with `conversationId?`, `message`, `providerId?`, `model?`, `attachments?`.
2. `startChat` in `src/app.js` creates a `requestId` and `AbortController`, registers it in the request-scoped `controllers` map, writes SSE headers, emits `ready`, and calls `runChat`.
3. `runChat` inserts the user message, auto-titles a "New chat" session from the first message, emits `conversation`, and checks daily/monthly token limits.
4. For each agent step, `candidateList` selects up to **six** ready candidates. Free-first is the default; explicit provider+model bypasses routing.
5. `streamChat` emits `meta`, `delta`, and `thinking`; success clears the candidate cooldown, failure records a 60-second cooldown and emits `notice`.
6. Usage is recorded and emitted. Tool calls are normalized, executed in order, and persisted as assistant + `tool` rows.
7. With no tool calls the turn emits `done`. With tools it emits `step` and loops up to `maxAgentSteps` (1–30).
8. Abort produces `stopped`; failure produces `error`. Both close the stream. Clean-up always removes the controller.

`requestId` is not a conversation ID. Stop with `POST /api/chat/<requestId>/stop`. The response `close` handler also aborts, so a disconnected client cannot leave a turn running.

## 6. HTTP API

All responses are JSON. Errors are `{ "error": "message" }` with the matching status. `GET /api/health` is unauthenticated; every other API call requires `Authorization: Bearer <token>`, `x-zycron-token`, or `?token=` when `ZYCRON_TOKEN` is set.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness (`ok`, `version`, `name`) |
| GET | `/api/bootstrap` | App, settings, providers, models, conversations, projects, plugins, usage, backup |
| GET/PATCH | `/api/settings` | Read or patch runtime settings |
| GET | `/api/usage` | Today/month totals and per-provider usage |
| GET/POST/DELETE | `/api/conversations` | List/search, create, delete (`keepPinned=1`) |
| GET/PATCH/DELETE | `/api/conversations/:id` | Load messages; update title/model/mode/project/pin/archive; delete |
| POST | `/api/conversations/:id/duplicate` | Copy conversation and messages |
| POST | `/api/conversations/:id/clear` | Delete messages, keep session |
| POST | `/api/conversations/:id/compact` | Mark context compacted; history stays |
| POST | `/api/conversations/:id/undo` | Undo the latest file change |
| POST | `/api/conversations/:id/redo` | Redo the latest undone change |
| GET | `/api/conversations/:id/changes` | File-change history |
| GET | `/api/conversations/:id/export` | Markdown export (`format=json` supported) |
| PATCH | `/api/messages/:id` | Edit a user message; later messages are removed |
| POST | `/api/chat` | Start a streaming turn (SSE) |
| POST | `/api/chat/regenerate` | Regenerate the last user turn |
| POST | `/api/chat/:requestId/stop` | Abort a running turn |
| GET | `/api/approvals` | Pending approvals for live turns |
| POST | `/api/approvals/:id` | `{ approve: true \| false }` |
| GET/POST | `/api/providers` | List or add providers |
| PATCH/DELETE | `/api/providers/:id` | Update or remove a provider |
| POST | `/api/providers/:id/models` | Fetch and cache the model catalog |
| GET | `/api/models` | List models (`q`, `provider`, `free=1`) |
| GET/POST | `/api/projects` | List or create projects |
| DELETE | `/api/projects/:id` | Remove project (`deleteFiles=1` wipes files) |
| GET | `/api/projects/:id/tree` | Recursive tree (`path`, `depth`) |
| GET/PUT/DELETE | `/api/projects/:id/file` | Read, write, or delete a sandboxed file |
| POST | `/api/projects/:id/rename` | Rename a path |
| GET | `/api/projects/:id/search` | Literal content search (`q`) |
| POST | `/api/projects/:id/replace` | Replace across text files |
| POST | `/api/projects/:id/run` | Run a shell command (UI-initiated) |
| GET | `/api/projects/:id/instructions` | Parsed root `AGENTS.md` |
| GET/POST | `/api/backup` | Latest backup or create one |
| POST | `/api/uploads` | Store an attachment |
| GET | `/api/plugins` | List plugin hooks |
| PATCH | `/api/plugins/:id` | Enable or disable a plugin |
| GET | `/uploads/*`, `/preview/*` | Stored uploads and sandboxed project previews |

## 7. SSE contract

`POST /api/chat` returns `text/event-stream; charset=utf-8` frames of `event:` plus one-line JSON `data:`, separated by blank lines. Heartbeat: `: keep-alive` every 15 seconds.

| Event | Key payload |
| --- | --- |
| `ready` | `requestId`, `conversationId`, `conversation`, `regenerate` |
| `conversation` | `conversation`, `messageCount`, `titleUpdated` |
| `meta` | `providerName`, `model`, `attempt` |
| `delta` | `text` |
| `thinking` | `text` |
| `notice` | `message`, `retry` |
| `tool_start` | `id`, `name`, `args` |
| `tool_end` | `id`, `name`, `status`, `output`, `args` |
| `approval` | `id`, `kind`, `payload`, `conversationId`, `createdAt` |
| `usage` | `input`, `output`, `total`, `provider`, `model` |
| `step` | `step`, `tools` |
| `file_changed` | `projectId`, `path`, `action` |
| `command_start` / `command_end` | `command`, optional `code` |
| `project` | `project`, `conversationId` |
| `done` | `messageId`, `usage`, `provider`, `model`, `steps` |
| `error` | `message`, `status` |
| `stopped` | `requestId` |

SSE rules: write headers once, flush with `res.write`, never buffer or compress, never emit after `res.end`, and stop on client close. Keep `data:` JSON on one line.

## 8. Data model and migrations

SQLite lives at `ZYCRON_DATA/zycron.db` and is opened with `node:sqlite`.

Core tables: `conversations`, `messages`, `projects`, `providers`, `models`, `settings`, `approvals`, `usage_log`, `changes`, `plugins`.

- Messages: `role` is `user`, `assistant`, or `tool`; `attachments`, `tool_calls`, and `meta` are JSON; ordering is `created_at, rowid`.
- Conversations: `provider_id`, `model`, `mode`, `project_id`, `pinned`, `archived`, `compact_at`, timestamps.
- Approvals: JSON payload and `pending | approved | denied`. Only an in-memory pending entry can be resolved by a live turn; old rows may be stale.
- Changes: before/after snapshots used by undo/redo.
- Usage: `usage_log` stores day, month, provider, model, input/output tokens, and request count.
- Migrations are additive and guarded. Seed with `INSERT OR IGNORE`. Never delete user rows or unknown settings keys.
- Timestamps are milliseconds since epoch.

SQLite calls are synchronous. Keep statements short; do not hold a request open for bulk work outside async tool handlers.

## 9. Settings

Defaults live in `DEFAULT_SETTINGS` (`src/db.js`) and are stored as JSON values. Only documented keys are accepted by `PATCH /api/settings`.

`systemPrompt`, `defaultProvider` (`auto`), `defaultModel` (`auto`), `routing` (`free-first`), `maxAgentSteps` (12; clamp 1–30), `contextChars` (60000; clamp 4000–400000), `approvalsRequired` (always true), `dailyTokenLimit` (0 = off), `monthlyTokenLimit` (0 = off), `temperature` (0.7; clamp 0–2), `autoTitle` (true), `theme` (`amoled|midnight`), `accent` (`violet|blue|cyan|rose`).

Settings are global. Per-conversation overrides live on the conversation row: provider, model, mode, project, system prompt.

## 10. Providers, models, and routing

- Catalog: **14 providers, 49 models, 44 free, 5 paid** (update these numbers when `src/presets.js` changes).
- Keyless providers: LLM7, Pollinations, Ollama, LM Studio. Key-required providers stay disabled until a key is saved.
- A provider is usable when it has a decrypted key or is keyless.
- Explicit provider+model bypasses routing; both must exist and the provider must be usable.
- Auto routing prefers free models, then free providers, then recency. `paid-first` reverses the free preference; `manual` is accepted but auto selection still uses the free-first sort.
- Failed candidates cool down for 60 seconds; the candidate list is deduplicated and capped at six.
- No usable model must produce a clear 400 asking for a provider/key, not a generic 500.
- Keys are encrypted with AES-256-GCM using a 32-byte local secret (`secret.key`, mode 0600). Public provider output exposes only `hasKey` and `keyHint`.
- Keep provider/model IDs stable; upserts must not orphan conversation or usage history.

## 11. Agent modes, tools, and approvals

Modes: `build`, `plan`, `debug`, `review`. `plan` and `review` are read-only at the tool layer; mutating tools return an error instead of executing.

Tools: `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `delete_file`, `rename_file`, `run_command`, `create_project`.

Approvals are mandatory for `write_file`, `edit_file`, `delete_file`, `rename_file`, `run_command`, and `create_project`.

- Write the approval row as `pending`, emit `approval`, then await the in-memory promise.
- Resolve once, remove from the pending map, and update the row.
- Deny and settle on abort, on the 10-minute timeout, and when no live entry exists.
- Read-only tools never require approval.
- Never execute a mutating tool before approval resolves.
- Approval payloads must show the exact path, command, rename source/target, or project name.
- `run_command` uses `bash -lc`, a 120-second timeout, and caps stdout/stderr at 30 KB each inside the project root.
- Tool output sent back to the model is truncated (20,000 chars).

## 12. Web UI contract

The browser client is the reference experience and follows an opencode-style terminal chat layout.

- Full-width message blocks with a 3 px left rule: blue for the user, violet for the assistant. Uppercase heads (`YOU · MESSAGE`, `✦ ZYCRON AI`); borderless content.
- Composer: `Enter` sends, `Shift+Enter` newlines, `↑/↓` history, `/` commands, `@` file mentions, `#` modes.
- Sidebar/top bar expose sessions, search, model, mode, project, export, and workspace.
- Workspace modal: project list, explorer, editor tabs, syntax highlighting, `Ctrl+S` save, search, and a terminal panel.
- The welcome hero appears only when the active session has no messages and no stream.
- Escape all untrusted text. Markdown must pass through `public/markdown.js`; never inject raw HTML.
- Plain JavaScript with `$`/`$$` helpers and delegated events. No framework, bundler, inline handlers, or build step.
- Preserve the AMOLED palette, spacing, and narrow-width behavior.

## 13. Terminal UI

`src/tui/` is a zero-dependency ANSI client that talks to the same HTTP/SSE API. It must not open the database directly or duplicate provider logic.

Visual contract:

- True-black AMOLED background (`48;5;16`), thin `┃` gutter, compact spacing, no cards, gradients, or rounded panels.
- Header; optional sidebar (30 cols at ≥96, 26 at ≥76, hidden below 76); chat viewport; three-row active-task block while busy; bordered multiline composer; one-row status bar.
- Status bar: eight dots, `esc interrupt` / `enter send`, token count with context percent, `ctrl+p commands`.
- Thinking/streaming must update without flicker; render is coalesced and never blocks input.

Input contract:

- Enter sends; Shift+Enter inserts a newline; `Esc` interrupts a turn or closes a modal.
- `Ctrl+P` command palette, `Ctrl+N` new session, `Ctrl+K` sessions, `Ctrl+M` models, `Ctrl+R` rename, `Ctrl+F` pin, `Ctrl+E` export, `Ctrl+Y` copy, `Ctrl+T` providers, `Tab`/`Shift+Tab` cycle modes, `PgUp/PgDn` scroll.
- Leader prefix `Ctrl+X` (2 s window): `n` new, `l` sessions, `m` models, `a` providers, `s` status, `c` compact, `u` undo, `r` redo, `b` toggle sidebar, `q` quit.
- Bracketed paste must be handled atomically.
- Clipboard: `termux-clipboard-set`, then OSC 52 fallback.

Engineering rules:

- Enter the alternate screen and disable autowrap; restore cursor, wrap, paste mode, and the alt screen on every exit path, including errors and signals.
- Render into an off-screen cell grid and emit fixed-width rows; never rely on terminal wrapping for layout.
- Surface approvals as an explicit allow/deny modal. Never auto-approve. A denial must resolve the server promise.
- Consume SSE asynchronously; keep a single active turn; stop via `POST /api/chat/:requestId/stop`.
- Test with pure render/wrap/markdown assertions plus a headless fake-provider integration test. No PTY dependency for tests.
- Launcher flags: `--url <base>`, `--token <token>`, `--no-spawn`, `-h/--help`, `-v/--version`; env fallbacks `ZYCRON_URL`/`ZYCRON_TOKEN`. Auto-start uses `server.js` and writes `<dataDir>/tui-server.log`.
- Tests: `test/tui.test.js` (width/wrap/markdown/keys/frames) and `test/tui-stream.test.js` (fake OpenAI-compatible provider + spawned server).
- Update this section and `README.md` as modules change; do not describe unfinished pieces as shipped.

## 14. Security and sandboxing

- Project paths resolve against the real project root and must never escape it, including through symlinks. Check the resolved target and, for writes, the resolved parent.
- File reads are capped at 2 MB; command output and runtime are capped; commands run inside the project root.
- `/uploads` and `/preview` are auth-checked handlers. Never serve `ZYCRON_DATA` or the secret file statically.
- Auth comparison uses `timingSafeEqual`; the server sets `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.
- Never log API keys, bearer tokens, decrypted secrets, or raw authorization headers. `keyHint` is the only key detail allowed in responses.
- Treat model output, provider responses, project files, filenames, and attachments as untrusted input.
- Do not introduce shell interpolation; pass argument arrays where possible.
- Keep `approvalsRequired` true. Do not add a bypass setting or silent write path.

## 15. Coding conventions

- ES modules, double quotes, no semicolons, two-space indentation.
- Small exported functions, explicit error handling, and meaningful error messages.
- Use `HttpError(status, message)` for API failures.
- camelCase in API JSON; snake_case only at the SQLite boundary.
- Validate and clamp request input in the router; never trust the client.
- Keep async boundaries explicit; `node:sqlite` is synchronous, so keep queries short.
- Comment only non-obvious logic; never add AI or generated-code noise.
- Frontend and terminal code stay dependency-free and framework-free.
- Add fields instead of renaming existing API fields; keep clients backward compatible.
- Preserve stable sorting, IDs, and file formats unless the change requires otherwise.

## 16. Verification protocol

Before reporting work complete:

1. `node --check` every changed JavaScript file.
2. Run `npm test`; add tests for new behavior and failure paths.
3. Smoke-test with isolated paths on a non-default port:
   `ZYCRON_DATA=/path/tmp/data ZYCRON_WORKSPACE=/path/tmp/work PORT=18091 node server.js`
   then check `/api/health`, `/api/bootstrap`, create a project, write/read a file, run a command, and search.
4. Test provider/agent changes with a **local fake OpenAI-compatible provider** that streams SSE and reports usage. Never use paid or rate-limited remote APIs for tests.
5. Verify approvals end-to-end: allow, deny, abort, timeout, and stale approval after restart.
6. Verify project `AGENTS.md` reaches the prompt with `GET /api/projects/:id/instructions` and the assembled messages.
7. Confirm catalog counts after preset changes (currently 14/49/44/5).
8. For terminal work, run unit/render tests and a headless SSE test; check widths 50, 80, and 120 where possible.

Tests must not touch the user's real data directory or default port. Clean up child processes and temporary directories.

## 17. Definition of done

- The feature works through the real API/UI path, not a stub.
- Errors are handled and surfaced to the user.
- Permissions, approvals, and sandbox rules are intact.
- New behavior has tests; existing tests pass.
- `node --check` passes for changed files.
- Docs and this guide reflect reality.
- The report states what changed, what was verified, and any remaining limitation.

## 18. Known pitfalls

- `src/app.js` matches routes by both `pathname` and `segments`; keep specific routes before the final 404 and method checks explicit.
- `POST /api/chat` owns the response. Never call `sendJson` on an SSE response, and never write after the stream closes.
- The controllers map is keyed by `requestId`, not conversation ID, and must be cleaned in `finally`.
- A chat request may create the conversation; read the real ID from `ready`.
- `auto` is a routing sentinel. Never pass `auto` as a provider model to an upstream API.
- Persisted approvals can outlive their resolver; after restart expect stale `pending` rows.
- `settings.approvalsRequired` is forced true by the settings handler.
- Auto-titling only applies while the title is `New chat`.
- Context assembly keeps a recent slice under `contextChars` and never starts on a `tool` message.
- Startup and 30-minute automatic backups are expected; keep pruning.
- `decodeURIComponent(url.pathname)` can throw on malformed input; the router catch handles it.
- On Termux, `/tmp` may be read-only and `rg` may be missing.
- The web UI and terminal UI share one backend; an API shape change requires updating both.

## 19. Never

- Add dependencies, a bundler, TypeScript, or a framework to the web or terminal client.
- Remove providers, free models, sessions, settings, or user history.
- Bypass approvals with direct filesystem writes from agent tools.
- Weaken sandbox checks, auth, or key encryption.
- Expose the data directory, database, uploads, backups, or secret over HTTP.
- Commit `node_modules`, `.env`, runtime data, or secrets.
- Fabricate test results, provider behavior, or feature completion.
- Rewrite unrelated files to make a focused change look larger.

## 20. Maintenance

Keep this file synchronized with the code. When a route, SSE event, setting, mode, tool, keybinding, or client surface changes, update the matching section here. Prefer precise tables and invariants over prose. Stay under 24,000 characters; tighten wording rather than deleting safety rules.
