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

- streaming chat with provider routing and fallbacks,
- a sandboxed project workspace with file and shell tools,
- approval-gated mutations with undo/redo,
- a browser client, a zero-dependency terminal client (`src/tui/`, `zycron` launcher),
- a Flow-style video studio (storyboard → WebM, optional Sora/Veo).

No cloud dependency, telemetry, build step, or npm dependency. SQLite stores chats, providers, settings, approvals, usage, changes, videos, and plugin state.

Design priorities, in order: working software, local data ownership, zero dependencies, safe tool boundaries.

## 2. Operating rules

1. **Zero dependencies.** Node built-ins and browser APIs only; no packages, bundlers, or build steps without approval.
2. **Never fake behavior.** No placeholders, mock data, or buttons that only render.
3. **Preserve user data.** Never drop tables/rows, rewrite settings, delete uploads, or rotate keys in a migration.
4. **Never weaken security.** Keep sandboxing, symlink checks, approvals, auth, and key encryption intact.
5. **Keep IDs stable.** Providers/models are referenced by chats, usage, and settings.
6. **Verify, then report.** Run §16 checks and state only what passed.
7. **Minimal diffs.** No unrelated refactors or public-contract renames.
8. **Phone-first.** Web and terminal clients must work on Termux and narrow screens.

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
| `ZYCRON_IMAGE_BASE` | `https://image.pollinations.ai/prompt` | Storyboard image endpoint (tests point this at a fake server) |
| `ZYCRON_VIDEO_POLL_MS` | `5000` | Provider video job poll interval (tests use 60) |

Termux: `/tmp` may be read-only (use `$PREFIX/tmp`); `rg` may be missing (use `grep -r`); kill test servers by PID, never a pattern matching your own command line.

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
src/videos.js          Flow studio: storyboards, video providers, file storage
src/presets.js         bundled provider and free-model catalog
public/                vanilla browser client (HTML/CSS/JS, no build)
public/flow.*          Flow video studio page, styles, and renderer
src/tui/               zero-dependency terminal client
test/                  node:test suites
```

TUI modules: `ansi.js` (palette/width/grid/clipboard), `markdown.js`, `keys.js` (escape/paste parser), `api.js` (HTTP/SSE), `local.js` (health, spawn/stop), `render.js` (frames/modals), `app.js` (state/input/SSE), `main.js` (CLI), plus `bin/zycron`. Reuse the HTTP API and SQLite only; never add a second database or duplicate routing.

## 5. Chat request lifecycle

1. Client sends `POST /api/chat` with `conversationId?`, `message`, `providerId?`, `model?`, `attachments?`.
2. `startChat` in `src/app.js` creates a `requestId` and `AbortController`, registers it in the request-scoped `controllers` map, writes SSE headers, emits `ready`, and calls `runChat`.
3. `runChat` inserts the user message, auto-titles "New chat" from the first message, emits `conversation`, and checks token limits.
4. Each agent step, `candidateList` picks up to **six** ready candidates; free-first by default, explicit provider+model bypasses routing.
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
| GET/POST | `/api/videos` | List films or create a draft |
| GET/PATCH/DELETE | `/api/videos/:id` | Read, update scenes/settings, delete |
| POST | `/api/videos/:id/storyboard` | Generate scene images (`style`, `seed`) |
| POST | `/api/videos/:id/render` | Start a provider video job |
| GET/POST | `/api/videos/:id/file` | Stream (Range supported) or upload the rendered film |
| POST | `/api/videos/:id/scenes/:index/image` | Upload a frame for one scene |
| GET | `/api/videos/assets/:name` | Storyboard image |
| GET | `/api/plugins` | List plugin hooks |
| PATCH | `/api/plugins/:id` | Enable or disable a plugin |
| GET | `/uploads/*`, `/preview/*` | Stored uploads and sandboxed project previews |

## 7. SSE contract

`POST /api/chat` streams `event:` + one-line JSON `data:` frames separated by blank lines; heartbeat `: keep-alive` every 15 s.

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

Write headers once, flush with `res.write`, never buffer/compress or emit after `end`, stop on client close.

## 8. Data model and migrations

SQLite lives at `ZYCRON_DATA/zycron.db` and is opened with `node:sqlite`.

Core tables: `conversations`, `messages`, `projects`, `providers`, `models`, `settings`, `approvals`, `usage_log`, `changes`, `plugins`, `videos`.

- Messages: `role` is `user`, `assistant`, or `tool`; `attachments`, `tool_calls`, and `meta` are JSON; ordering is `created_at, rowid`.
- Conversations: `provider_id`, `model`, `mode`, `project_id`, `pinned`, `archived`, `compact_at`, timestamps.
- Approvals: JSON payload, `pending | approved | denied`; only in-memory pending entries resolve, old rows may be stale.
- Changes: before/after snapshots for undo/redo.
- Usage: `usage_log` stores day, month, provider, model, input/output tokens, and request count.
- Videos: `scenes` is JSON (`prompt`, `duration`, `motion`, `transition`, `image`, `seed`); `status` is `draft | storyboard | queued | ready | failed`; files live in `<dataDir>/videos`.
- Migrations are additive and guarded; seed with `INSERT OR IGNORE`; never delete user rows or unknown keys. Timestamps are ms since epoch.

SQLite calls are synchronous. Keep statements short; do not hold a request open for bulk work outside async tool handlers.

## 9. Settings

Defaults live in `DEFAULT_SETTINGS` (`src/db.js`) and are stored as JSON values. Only documented keys are accepted by `PATCH /api/settings`.

`systemPrompt`, `defaultProvider` (`auto`), `defaultModel` (`auto`), `routing` (`free-first`), `maxAgentSteps` (12; clamp 1–30), `contextChars` (60000; clamp 4000–400000), `approvalsRequired` (always true), `dailyTokenLimit` (0 = off), `monthlyTokenLimit` (0 = off), `temperature` (0.7; clamp 0–2), `autoTitle` (true), `theme` (`amoled|midnight`), `accent` (`violet|blue|cyan|rose`).

Per-conversation overrides live on the conversation row: provider, model, mode, project, system prompt.

## 10. Providers, models, and routing

- Catalog: **14 providers, 49 models, 44 free, 5 paid** (update these numbers when `src/presets.js` changes).
- Keyless: LLM7, Pollinations, Ollama, LM Studio. Others stay disabled until a key is saved; usable = decrypted key or keyless.
- Explicit provider+model bypasses routing; both must exist and be usable.
- Auto routing prefers free models, then free providers, then recency. `paid-first` reverses the free preference; `manual` is accepted but auto selection still uses the free-first sort.
- Failed candidates cool down for 60 seconds; the candidate list is deduplicated and capped at six.
- No usable model → clear 400 asking for a provider/key, not a 500.
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
- Sidebar/top bar: sessions, search, model, mode, project, export, workspace.
- Workspace modal: project list, explorer, tabs, highlighting, `Ctrl+S`, search, terminal.
- Flow studio lives at `/flow`: scene rail, stage player, direction panel, style chips, aspect/seed, storyboard generation, real-time canvas capture to WebM, library drawer, and provider video jobs. Linked from the sidebar and top bar (`F`).
- The welcome hero appears only when the active session has no messages and no stream.
- Escape all untrusted text. Markdown must pass through `public/markdown.js`; never inject raw HTML.
- Plain JavaScript with `$`/`$$` helpers and delegated events. No framework, bundler, inline handlers, or build step.
- Preserve the AMOLED palette, spacing, and narrow-width behavior.

## 13. Terminal UI

`src/tui/` is a zero-dependency ANSI client that talks to the same HTTP/SSE API. It must not open the database directly or duplicate provider logic.

Visual contract:

- True-black AMOLED background (`48;5;16`), thin `┃` gutter, compact spacing, no cards, gradients, or rounded panels.
- Header; optional sidebar (30/26 cols at ≥96/76); chat viewport; three-row task block; bordered composer; one-row status bar (dots, `esc interrupt`, tokens, `ctrl+p commands`).
- Streaming updates without flicker; render is coalesced and never blocks input.

Input contract:

- Enter sends; Shift+Enter inserts a newline; `Esc` interrupts a turn or closes a modal.
- `Ctrl+P` command palette, `Ctrl+N` new session, `Ctrl+K` sessions, `Ctrl+M` models, `Ctrl+R` rename, `Ctrl+F` pin, `Ctrl+E` export, `Ctrl+Y` copy, `Ctrl+T` providers, `Tab`/`Shift+Tab` cycle modes, `PgUp/PgDn` scroll.
- Leader prefix `Ctrl+X` (2 s window): `n` new, `l` sessions, `m` models, `a` providers, `s` status, `c` compact, `u` undo, `r` redo, `b` toggle sidebar, `q` quit.
- Bracketed paste must be handled atomically.
- Clipboard: `termux-clipboard-set`, then OSC 52 fallback.

Engineering rules:

- Enter the alt screen, disable autowrap, and restore cursor/wrap/paste/alt screen on every exit path, including errors and signals.
- Render into an off-screen cell grid and emit fixed-width rows; never rely on terminal wrapping.
- Approvals are an explicit allow/deny modal; never auto-approve, and a denial must resolve the server promise.
- Consume SSE asynchronously; one active turn; stop via \`POST /api/chat/:requestId/stop\`.
- Test with render/wrap/markdown assertions plus the fake-provider test; no PTY dependency.
- Termux drops execute bits on `/storage`, so `$PREFIX/bin/zycron` wraps `node .../bin/zycron "$@"`. Flags: `--url`, `--token`, `--no-spawn`, `-h`, `-v`; env `ZYCRON_URL`/`ZYCRON_TOKEN`. Auto-start spawns `server.js` and logs to `<dataDir>/tui-server.log`.
- Tests: `test/tui.test.js` and `test/tui-stream.test.js` (fake provider + spawned server). Update this section and `README.md` as modules change.

## 14. Security and sandboxing

- Project paths resolve against the real root and never escape it, symlinks included; check target and, for writes, parent.
- Reads cap at 2 MB; output/runtime capped; commands run inside the project root.
- `/uploads` and `/preview` require auth; never serve `ZYCRON_DATA` or the secret statically.
- Auth compares with `timingSafeEqual`; server sends `nosniff` and `no-referrer`.
- Never log keys, tokens, decrypted secrets, or raw auth headers; `keyHint` is the only key detail in responses.
- Treat model output, provider responses, project files, names, and attachments as untrusted.
- No shell interpolation; pass argument arrays.
- Keep `approvalsRequired` true; no bypass setting or silent write path.

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
3. Smoke-test on a non-default port (`PORT=18091 ZYCRON_DATA=... ZYCRON_WORKSPACE=... node server.js`): health, bootstrap, project create, file read/write, run, search.
4. Test provider/agent work with a **local fake OpenAI-compatible provider** that streams SSE and reports usage; never paid or rate-limited APIs.
5. Verify approvals end-to-end: allow, deny, abort, timeout, stale after restart.
6. Confirm project `AGENTS.md` reaches the prompt (`/api/projects/:id/instructions`) and catalog counts after preset changes (14/49/44/5).
7. For terminal work, run render tests plus the headless SSE test at widths 50/80/120. For Flow, fake the image/Sora/Veo/TTS servers.

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

- `src/app.js` routes on `pathname`/`segments`; specific routes before the 404.
- `POST /api/chat` owns the response. Never call `sendJson` on an SSE response, and never write after the stream closes.
- The controllers map is keyed by `requestId`, not conversation ID, and must be cleaned in `finally`.
- A chat may create the conversation; read the real ID from `ready`.
- `auto` is a routing sentinel; never pass it upstream as a model.
- Saved approvals can outlive their resolver; expect stale `pending` rows after restart.
- `approvalsRequired` is forced true; auto-title only while the title is `New chat`.
- Context assembly keeps a recent slice under `contextChars`, never starting on a `tool` message.
- Keep startup and 30-min backups with pruning.
- Malformed `decodeURIComponent(url.pathname)` is caught by the router.
- Web, TUI, and Flow share one backend; update all three on API changes.

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

## 21. Flow video studio

`/flow` is a zero-dependency storyboard-to-video studio served by the same process.

- Storyboard images come from the picked provider's `/images/generations`, else `ZYCRON_IMAGE_BASE`, or an upload. Assets live in `<dataDir>/videos/assets`; the first is `poster`.
- Rendering is client-side: canvas scenes with camera move + fade, captured via `captureStream(30)` + `MediaRecorder`, then uploaded to `POST /api/videos/:id/file`. Frame controls (`out_scale`, `fit`, `zoom`, `trim_start`, `trim_end`) drive canvas size, crop, and the rendered range.
- `imageToken` forwards a Pollinations pollen key; the free tier 429s after one image.
- Provider mode: OpenAI-style `POST {base}/videos` → poll `GET {base}/videos/:id` → `/content`; Veo `{base}/models/{model}:predictLongRunning` + `x-goog-api-key` → poll operation.
- Jobs run in-process (15-min timeout), persist progress on the row, and reject duplicates. File serving supports `Range`; uploads cap at 200 MB.
- Narration: `POST /api/videos/:id/voice` writes `${id}-voice.mp3` from the picked provider's `/audio/speech`, else Google TTS (`ZYCRON_TTS_BASE`). Render mixes it through a `MediaStreamDestination`; dictation uses the browser Speech API and preview uses device `speechSynthesis`.
- `test/videos.test.js` fakes image/Sora/Veo/TTS servers via env overrides; never call real providers in tests.
