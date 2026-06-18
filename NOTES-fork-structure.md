# claude-code-g2 — Fork Internals (structure notes)

Discovery/documentation only. Exact identifiers for integrating the upcoming
"native sessions bridge" (reading `~/.claude/projects/*.jsonl`) into the existing
backend (Bun + Express) and frontend (React + Vite + `even-toolkit`).

All `file:line` references are to files in this repo:
`/Users/ecollazos/EvenRealities Projects/claude-code-g2`.

> Note: `frontend/node_modules` and `backend/node_modules` are NOT installed in
> this clone, so `even-toolkit` / `@evenrealities/even_hub_sdk` internals are
> documented from their usage in this repo's source (verbatim import paths and
> call signatures), not from the published `.d.ts`.

---

## BACKEND

### Server bootstrap — `backend/src/index.ts`
- App created with plain `express()` at `backend/src/index.ts:20` (`const app = express()`). No app factory function; it is module top-level.
- **Listen host + port:** `backend/src/index.ts:213-216`
  ```ts
  const PORT = Number(process.env.PORT ?? 8787)
  const server = app.listen(PORT, '0.0.0.0', () => { ... })
  ```
  Host is **`0.0.0.0`** (NOT `127.0.0.1`). Port env var is **`PORT`**, default **`8787`**.
  (The Cloudflare tunnel in `dev.sh` deliberately targets `127.0.0.1:$BACKEND_PORT` because the backend binds IPv4 `0.0.0.0` — see `dev.sh:154-157`.)
- **Mount order** (top to bottom in `index.ts`):
  1. Request logger middleware — `index.ts:27-44` (skips `OPTIONS`; quiet paths set `QUIET_PATHS = new Set(['/api/health', '/api/events', '/api/ping'])` at `index.ts:25`).
  2. Global CORS middleware — `index.ts:50-67` (echoes `Origin`, sets `Vary: Origin`, no `Allow-Credentials`; answers `OPTIONS` with `204`).
  3. Public unauthed routes: `GET /api/health` (`index.ts:70-72`), `GET /api/ping` (plain-text `pong`, `index.ts:75-77`).
  4. Authenticated sub-router `authed` (`express.Router()`, `index.ts:80`): applies `bearerAuth(cfg.token)` then `express.json({ limit: '2mb' })`, then all `/config`, `/settings`, `/sessions*`, and `/transcribe` routes. Mounted with `app.use('/api', authed)` at `index.ts:194`.
  5. `GET /api/events` SSE endpoint registered DIRECTLY on `app` (NOT under `authed`) at `index.ts:197-206` — it does its own token check because `EventSource` can't send headers.
  6. Catch-all 404 — `index.ts:209-211` → `{ error: 'not_found', path: req.path }`.
- Singletons wired at top: `let cfg = loadConfig()` (`index.ts:16`, mutable for hot-reload), `const sse = new SseHub()` (`index.ts:17`), `const manager = new SessionManager(cfg, sse)` (`index.ts:18`).
- Graceful shutdown: `shutdown()` on `SIGINT`/`SIGTERM` (`index.ts:219-227`) → `manager.shutdown()`, `sse.close()`, `server.close()`.

### Bearer auth — `backend/src/auth.ts`
- Middleware factory: **`bearerAuth(expectedToken: string)`** — `auth.ts:35-44`. Returns an Express middleware that 401s `{ error: 'unauthorized' }` on mismatch.
- Applied **per-router, not globally**: `authed.use(bearerAuth(cfg.token))` at `index.ts:81`. Public routes (`/api/health`, `/api/ping`) are registered before the router and are NOT protected.
- Helper exports also in `auth.ts`:
  - `checkToken(expected, presented): boolean` — `auth.ts:5-15`, constant-time via `crypto.timingSafeEqual`.
  - `extractHeaderToken(req): string | null` — `auth.ts:18-23`, parses `Authorization: Bearer <token>` (regex `/^Bearer\s+(.+)$/i`).
  - `extractToken(req): string | null` — `auth.ts:27-33`, header OR `?token=` query param (the SSE path uses this).
- **Where the token comes from:** the config file `~/.cc-g2/config.json`, JSON key **`token`**. Defined in `config.ts`: `CONFIG_DIR = ~/.cc-g2` (`config.ts:36`), `CONFIG_PATH = ~/.cc-g2/config.json` (`config.ts:37`). Auto-generated on first boot via `crypto.randomBytes(32).toString('base64url')` (`config.ts:43`). The `index.ts` route uses `cfg.token` (e.g. `bearerAuth(cfg.token)` at `index.ts:81`, `checkToken(cfg.token, token)` at `index.ts:199`).

### Existing routes
Path-prefix convention: every HTTP route is under **`/api`** (public ones registered directly; authed ones mounted via `app.use('/api', authed)`, so inside the router the paths are written WITHOUT the `/api` prefix, e.g. `authed.get('/sessions', ...)` → served at `/api/sessions`).

| METHOD | Path | Handler (file:line) | Purpose |
|--------|------|---------------------|---------|
| GET | `/api/health` | `index.ts:70-72` | Unauthed liveness → `{ ok: true, service: 'cc-g2-backend' }` |
| GET | `/api/ping` | `index.ts:75-77` | Unauthed plain-text `pong` (diagnostics) |
| GET | `/api/config` | `index.ts:84-89` | Project names + `defaultProjectName` |
| GET | `/api/settings` | `index.ts:92-99` | Current `permissionMode`, `model`, `defaultProjectName`, `projects` |
| POST | `/api/settings` | `index.ts:101-116` | Save settings (`SettingsUpdate`) → `saveSettings` + `manager.applyConfig` |
| GET | `/api/sessions` | `index.ts:118-120` | List session summaries → `{ sessions: manager.list() }` |
| GET | `/api/sessions/:id` | `index.ts:122-139` | One session + truncated transcript (`truncateTranscriptForGlasses(s.transcript, 80)`) |
| POST | `/api/sessions` | `index.ts:141-160` | Create session (`{ projectName, firstPrompt, model? }`) → `manager.create` |
| POST | `/api/sessions/:id/turn` | `index.ts:162-176` | Send a follow-up turn (`{ text }`) → `manager.send(id, text)` |
| DELETE | `/api/sessions/:id` | `index.ts:178-185` | Delete session → `manager.delete(id)` |
| POST | `/api/transcribe` | `index.ts:188-192` + `transcribe.ts:51` | Whisper STT. Uses `express.raw({ type: '*/*', limit: '15mb' })` instead of JSON body parsing. |
| GET | `/api/events` | `index.ts:197-206` | SSE stream (auth via `?token=`). |

### SSE — `backend/src/events.ts`
- Endpoint: **`GET /api/events`** (`index.ts:197-206`). Auth: `extractToken(req)` → `checkToken(cfg.token, token)`; 401 if bad. Channel selection: `const sessionId = String(req.query.sessionId ?? '*')`; `const channel = sessionId === '*' ? '*' : 'session:' + sessionId`; then `sse.subscribe(channel, res)`.
- Broadcast/hub abstraction: class **`SseHub`** in `events.ts:33-109`. Methods: `subscribe(channel, res)` (`events.ts:51-68`), `publishTranscript(sessionId, event)` (`events.ts:70-82`), `publishGlobal(ev)` (`events.ts:84-96`), `close()` (`events.ts:98-108`). 15s comment heartbeat `': ping\n\n'` (`events.ts:40-48`).
- Response setup (`events.ts:52-57`): headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`; then `res.flushHeaders?.()` and `res.write('retry: 3000\n\n')`.
- **Wire format:** each event is `data: ${JSON.stringify(payload)}\n\n`. The `payload` is the discriminated union **`SseEvent`** (`events.ts:24-26`):
  ```ts
  type SseEvent =
    | { kind: 'transcript'; sessionId: string; event: TranscriptEvent }
    | { kind: 'global'; event: GlobalEvent }
  ```
  - `publishTranscript` pushes `{ kind: 'transcript', sessionId, event }` to subscribers whose channel is `session:<id>` OR `*` (`events.ts:71-81`).
  - `publishGlobal` pushes `{ kind: 'global', event }` ONLY to the `*` channel (`events.ts:85-95`).
- **`GlobalEvent`** shape (`events.ts:19-22`):
  ```ts
  | { kind: 'session_created'; sessionId: string; title: string; projectName: string; ts: number }
  | { kind: 'session_updated'; sessionId: string; title: string; lastActiveAt: number; ts: number }
  | { kind: 'session_deleted'; sessionId: string; ts: number }
  ```
- **`TranscriptEvent`** shape (`backend/src/sessions/store.ts:9-15`):
  ```ts
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant_text'; text: string; ts: number }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown; ts: number }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; ts: number }
  | { kind: 'result'; subtype: string; isError: boolean; ts: number }
  | { kind: 'error'; message: string; ts: number }
  ```
  (Frontend `types.ts:3-10` mirrors this and ADDS a 7th variant `{ kind: 'question'; toolUseId; questionText; options; ts }` not present on the backend.)

### Session manager — files + behavior
Three files under `backend/src/sessions/`:
- **`manager.ts`** — `class SessionManager` (`manager.ts:13`). Public methods: `list()`, `get(id)`, `delete(id)`, `create(opts: CreateSessionOpts)` (`manager.ts:48-86`), `send(id, text)` (`manager.ts:91-106`), `applyConfig(cfg)` (`manager.ts:136-138`, hot-reload), `shutdown()` (`manager.ts:165-169`). Private `ensureProc(session, opts)` (`manager.ts:108-131`) lazily spawns one `ClaudeCodeProc` per session, stored in `procs = new Map<string, ClaudeCodeProc>()`. After a `result` event the proc reference is dropped (`manager.ts:150-152`), so the next turn re-spawns with `--resume`.
- **`claudeProc.ts`** — `class ClaudeCodeProc` (`claudeProc.ts:52`). Spawns and parses the CLI.
- **`store.ts`** — `class SessionStore` (disk persistence) + `truncateTranscriptForGlasses`.

**Exact `claude` CLI command + flags** (`claudeProc.ts:81-98`, assembled in `start()`):
```
claude
  -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --model <model>                         // 'sonnet' default
  --add-dir <cwd>
  // permission args:
  --dangerously-skip-permissions          // when permissionMode === 'bypassPermissions'
  //   OR  --permission-mode <mode>        // for 'acceptEdits' | 'default'
  --allowedTools "Bash Read Write Edit Glob Grep WebSearch WebFetch"   // space-joined DEFAULT_ALLOWED_TOOLS (claudeProc.ts:22-31)
  --append-system-prompt "<HUD_SYSTEM_PROMPT>"   // claudeProc.ts:33-39 (576x288 monochrome green, keep replies short)
  --max-turns 30
  // session args (mutually exclusive, claudeProc.ts:97):
  --session-id <sessionId>                // first run (resume === false)
  //   OR  --resume <sessionId>           // follow-up run (resume === true)
```
- Binary name: `this.claudeBinary` (config `claudeBinary`, default `'claude'`, `config.ts:59`). Spawned with `spawn(this.claudeBinary, args, { cwd, env: { ...process.env }, stdio: ['pipe','pipe','pipe'] })` (`claudeProc.ts:104-108`). It inherits `HOME`/`process.env` so the CLI bills against the user's Claude login (no `ANTHROPIC_API_KEY`).
- **How the user turn is written:** via **stdin**, one JSON line per turn, then stdin is closed (`claudeProc.ts:154-175`):
  ```ts
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n'
  this.child!.stdin.write(line)
  this.child!.stdin.end()
  ```
  This matches `--input-format stream-json` (confirmed by the spike note below: the positional `-p "..."` prompt does NOT get persisted as a user line). The `-p` flag is present but empty (print/headless mode); the actual prompt comes via stdin.
- Stdout parsed line-by-line via `readline` (`claudeProc.ts:110-111`, `handleLine` at `claudeProc.ts:204-294`). Recognizes `system` (init logged, ignored), `assistant` (text → `assistant_text`, `tool_use`), `user` (echoed `tool_result`), `result` (sets `sawResult`, emits `result`), `rate_limit_event` (ignored). Events handed back via `onEvent` callback → `manager.handleProcEvent` (`manager.ts:140-153`).

**Where sessions persist + record shape** (`store.ts`):
- Path: **`~/.cc-g2/sessions.json`** — `SESSIONS_PATH = path.join(os.homedir(), '.cc-g2', 'sessions.json')` (`config.ts:38`), surfaced as `cfg.sessionsPath` (`config.ts:162`) and passed to `new SessionStore(cfg.sessionsPath)` (`manager.ts:20`).
- On-disk file shape: `interface StoreFile { sessions: Session[] }` (`store.ts:35-37`). Debounced atomic write (temp file + rename) every 500ms (`store.ts:111-129`).
- **`Session` record shape** (`store.ts:17-25`):
  ```ts
  interface Session {
    id: string            // randomUUID()
    title: string         // deriveTitle(firstPrompt) — first 40 chars
    projectName: string
    cwd: string           // = project.path
    createdAt: number
    lastActiveAt: number
    transcript: TranscriptEvent[]   // capped at MAX_TRANSCRIPT_EVENTS = 500 (store.ts:7)
  }
  ```
- `SessionSummary` (no transcript/cwd) at `store.ts:27-33`. `truncateTranscriptForGlasses(t, limit = 60)` tails the transcript (`store.ts:137-140`).
- NOTE for the bridge: session IDs here are server-generated `randomUUID()` and are passed to the CLI as `--session-id`. Real Claude Code sessions in `~/.claude/projects/*.jsonl` are keyed by the CLI's own session id; reconciling the two id spaces is the integration's job.

### Transcription — `backend/src/transcribe.ts`
- Route: **`POST /api/transcribe`**, handler **`transcribeHandler`** (`transcribe.ts:51-83`), wired with `express.raw({ type: '*/*', limit: '15mb' })` at `index.ts:188-192`.
- Accepts `audio/wav` (passthrough) or raw PCM (`audio/pcm` / `application/octet-stream` / empty content-type) which is wrapped with a 44-byte RIFF header by `pcmToWav(...)` (`transcribe.ts:22-49`). PCM assumed 16 kHz, mono, s16le (`SAMPLE_RATE=16000`, `CHANNELS=1`, `BITS_PER_SAMPLE=16`, `transcribe.ts:9-11`).
- **Whisper call today (this is what swaps to Groq):**
  - Client: official `openai` SDK — `import OpenAI from 'openai'` + `import { toFile } from 'openai/uploads'` (`transcribe.ts:2-3`). Singleton via `new OpenAI({ apiKey: key })` (`transcribe.ts:18`).
  - **Base URL:** default OpenAI base (NOT overridden — no `baseURL` option passed; this is what Groq needs).
  - **API-key env var:** **`OPENAI_API_KEY`** — `process.env.OPENAI_API_KEY` (`transcribe.ts:16`), throws `'OPENAI_API_KEY is not set'` if missing.
  - **Model name:** `model: 'whisper-1'` (`transcribe.ts:74`).
  - Request (`transcribe.ts:71-77`): `client().audio.transcriptions.create({ file, model: 'whisper-1', language: 'en', response_format: 'json' })`. The `file` is built via `toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' })` (the multipart field is the SDK's `file` field).
  - **Response field read:** `result.text` → returns `{ text: result.text.trim() }` (`transcribe.ts:78`). On error → 502 `{ error: 'transcription_failed' }` (`transcribe.ts:79-82`).
- Note: `config.ts` declares an optional `openaiApiKey?` field on `ConfigFile` (`config.ts:21`) but `transcribe.ts` reads the env var, NOT the config field.

### Config module — `backend/src/config.ts`
- Exports: `loadConfig(): RuntimeConfig` (`config.ts:69`), `saveSettings(cfg, update): RuntimeConfig` (`config.ts:175`), and types `ConfigFile`, `RuntimeConfig`, `ProjectEntry`, `PermissionMode`, `ModelName`, `SettingsUpdate`, plus `VALID_PERMISSION_MODES`.
- `ConfigFile` shape (`config.ts:14-22`):
  ```ts
  { token: string; projects: ProjectEntry[]; defaultProjectName: string;
    claudeBinary: string; permissionMode: PermissionMode; model: ModelName;
    openaiApiKey?: string }
  ```
  where `ProjectEntry = { name: string; path: string }` (`config.ts:6-9`), `PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default'` (`config.ts:11`).
- `RuntimeConfig extends ConfigFile` adds `configPath`, `configDir`, `sessionsPath` (`config.ts:24-28`).
- **Env vars read by config.ts:** NONE directly. (`config.ts` derives all paths from `os.homedir()`.) The only env vars in the backend are `PORT` (`index.ts:213`) and `OPENAI_API_KEY` (`transcribe.ts:16`); `import 'dotenv/config'` is loaded at `index.ts:1` so `backend/.env` populates them.
- On startup `loadConfig()` prints a banner to **stderr** including the bearer token (`config.ts:141-156`).

### Scripts / ports
- **`backend/package.json` scripts** (`backend/package.json:6-10`):
  - `dev`: `bun --watch src/index.ts`
  - `start`: `bun src/index.ts`
  - `typecheck`: `tsc --noEmit`
- **`frontend/package.json` scripts** (`frontend/package.json:6-10`):
  - `dev`: `vite --port 5173 --host`
  - `build`: `tsc -b && vite build`
  - `preview`: `vite preview`
- **`dev.sh`** (repo root, executable): one-shot launcher. It (in order): `ensure_deps` (installs `bun`, `cloudflared`, `qrencode`; requires `claude` CLI — `dev.sh:80-87`), `ensure_env` (requires `backend/.env`, `dev.sh:89-93`), `ensure_node_modules` (`bun install` if missing), frees ports + kills stale tunnels, `start_backend` (`PORT=$BACKEND_PORT bun src/index.ts`, `dev.sh:138-144`), extracts the bearer token from backend log (`dev.sh:146-149`), `start_tunnel` (**cloudflared** quick tunnel to `http://127.0.0.1:$BACKEND_PORT`, `dev.sh:151-160`), `start_frontend` (`bunx vite --port $FRONTEND_PORT --host --strictPort`, `dev.sh:166-172`), health-checks, then prints a QR (`qrencode`) of a setup URL `http://<lan-ip>:5173/?backend=<enc>&token=<token>`.
  - **Ports:** `BACKEND_PORT` default **8787** (`dev.sh:31`), `FRONTEND_PORT` default **5173** (`dev.sh:32`). Overridable via `BACKEND_PORT` / `FRONTEND_PORT` env vars.
  - **Tunnel:** Cloudflare `cloudflared tunnel --url http://127.0.0.1:$BACKEND_PORT` (`dev.sh:157`). Public URL is `https://<sub>.trycloudflare.com`.
  - Flag `--smoke` exits after the health check (`dev.sh:42-48`, `dev.sh:367-370`).

---

## FRONTEND

### Glass router / screens — how a screen is defined and registered
The glasses UI is driven by `even-toolkit` (`even-toolkit@^1.5.0`, `frontend/package.json:16`). Key wiring files:

- **`frontend/src/glass/selectors.ts`** is the screen registry. To add a new screen an implementer copies this pattern:
  1. Import the router factory + screen type:
     `import { createGlassScreenRouter, type GlassScreen } from 'even-toolkit/glass-screen-router'` (`selectors.ts:1`).
  2. Add the screen module to the `screens` record (`selectors.ts:14-22`), keyed by the routable `AppMode`:
     ```ts
     const screens: Record<RoutableMode, GlassScreen<AppSnapshot, AppActions>> = {
       'main': mainScreen,
       'recording-new': recordingScreen,
       'transcribing': recordingScreen,
       'picking-project': pickingScreen,
       'recording-turn': recordingScreen,
       'confirming-transcript': confirmingScreen,
       'answering': answeringScreen,
     }
     ```
  3. **The registration call:** `export const { toDisplayData, onGlassAction } = createGlassScreenRouter(screens, 'main')` (`selectors.ts:24`) — second arg `'main'` is the fallback screen.
- **A screen is a `GlassScreen<AppSnapshot, AppActions>` object** with two methods (see e.g. `confirmingScreen` in `glass/screens/confirming.ts:11-56`):
  - `display(snapshot, nav) => { lines: DisplayLine[] }` — builds the HUD content.
  - `action(action, nav, snapshot, ctx) => nav` — handles input; `ctx` is the `AppActions` object; returns the (possibly updated) `nav` state.
- **The router is mounted via the `useGlasses` hook** in `frontend/src/glass/AppGlasses.tsx:398-408`:
  ```ts
  useGlasses({
    getSnapshot,                 // () => AppSnapshot (ref-backed, AppGlasses.tsx:160-162)
    toDisplayData,               // from selectors.ts
    toSplit: toSplitView,        // from splitView.ts (split/sidebar layout)
    onGlassAction: handleGlassAction,  // wraps onGlassAction(action, nav, snap, actions.current)
    deriveScreen,                // (pathname) => screen name, AppGlasses.tsx:372
    appName: 'CLAUDE CODE G2',
    splash: appSplash,           // from glass/splash.ts
    getPageMode,                 // 'home' | 'text', AppGlasses.tsx:389-396
    homeImageTiles: logoTiles ...,
  })
  ```
  `useGlasses` is imported from `'even-toolkit/useGlasses'` (`AppGlasses.tsx:3`). `AppMode → URL path` mapping is `MODE_PATHS` (`AppGlasses.tsx:26-35`); `path → screen name` is `PATH_TO_SCREEN` (`AppGlasses.tsx:37-49`). `deriveScreen` feeds `pathToScreen`.

**Existing glass screens** (`frontend/src/glass/screens/`):
| Screen export | File | Purpose |
|---------------|------|---------|
| `mainScreen` | `screens/main.ts:279` | Full-screen transcript view + full-screen sidebar overlay + delete-confirm modal. The most complex screen (scroll bar, busy/done indicators). |
| `recordingScreen` | `screens/recording.ts:25` | Voice recording + transcribing (3-line minimal). Serves modes `recording-new`, `recording-turn`, `transcribing`. |
| `pickingScreen` | `screens/picking.ts:17` | Project picker fallback (uses `buildScrollableList`). |
| `confirmingScreen` | `screens/confirming.ts:11` | Whisper-result confirmation ("HEARD …"), tap=send / 2tap=cancel. |
| `answeringScreen` | `screens/answering.ts:29` | AskUserQuestion answer picker (options + voice answer + skip). |

There is also the split/sidebar renderer `toSplitView` in `glass/splitView.ts:278-303` (used by `useGlasses({ toSplit })`).

**HUD display builders available** (all from `even-toolkit`):
- **List builder:** `buildScrollableList({ items, highlightedIndex, maxVisible, formatter })` — `import { buildScrollableList } from 'even-toolkit/glass-display-builders'` (used in `picking.ts:2,30-35` and `answering.ts:2,46-51`).
- **Text/line builders:** `line(text, style?)`, `separator()`, `glassHeader(title, status)` — `import { line, separator, type DisplayLine, glassHeader } from 'even-toolkit/types'` (`glass/shared.ts:1`); `truncate` from `'even-toolkit/text-utils'` (`shared.ts:2`). The app re-exports `line`/`separator` from `glass/theme.ts:45` and adds helpers `brandedHeader`, `rule()`, `footer()`, `padTo()` (`theme.ts:22-43`). `line` styles used in code include `'meta'` (dimmed).
- **Split layout:** `SplitData` / `GlassNavState` types from `'even-toolkit/types'` (`splitView.ts:1`).
- **Splash:** `createSplash`, `TILE_PRESETS` from `'even-toolkit/splash'` (`glass/splash.ts:1`).

**Input-handler API (swipe / tap / double-tap).** Handled in each screen's `action(action, nav, snapshot, ctx)`. The `action.type` discriminants are:
- `'HIGHLIGHT_MOVE'` — **swipe up/down**. Has `action.direction` (`'up' | 'down'`). Move highlight via `moveHighlight(nav.highlightedIndex, action.direction, max)` from `'even-toolkit/glass-nav'` (e.g. `picking.ts:3,47`, `main.ts:3,309`). In transcript mode `main.ts:343-348` maps swipe to scroll (±5 lines).
- `'SELECT_HIGHLIGHTED'` — **tap**.
- `'GO_BACK'` — **double-tap (2tap)**.
Return value is the next `nav` (e.g. `{ ...nav, highlightedIndex: 0 }`). See `main.ts:294-368` for the canonical handler; `recording.ts:55-67` for the simplest.

### `frontend/src/store.ts` — shared state
- Pattern: a hand-rolled external store with `useSyncExternalStore`. Exports `store` object (`store.ts:116-271`), `useAppState()` hook (`store.ts:273-275`), `isRecordingMode(mode)` (`store.ts:100-102`), and `interface AppState` (`store.ts:11-46`). Mutation via private `set(partial)` (`store.ts:92-96`) with shallow-equal short-circuit.
- Credentials (backend URL + bearer token) live IN this store as `state.backendUrl` / `state.token` (`AppState`, `store.ts:12-13`). Set via `store.setCredentials(backendUrl, token)` (`store.ts:125-133`, strips trailing slash) and cleared via `store.clearCredentials()` (`store.ts:134-141`). They are PERSISTED separately to glasses local storage by the Connect screen (see below), not by `store.ts` itself.

### `frontend/src/api.ts` — API client + auth header
- **Auth-header helper:** **`authFetch(path, init)`** — `api.ts:22-30`. It reads creds via `getCreds()` (`api.ts:16-20`, throws `NotConfiguredError`) and sets `headers.set('Authorization', 'Bearer ' + token)`; auto-adds `Content-Type: application/json` for string bodies.
- Backend base URL + token are read from the store: `const { backendUrl, token } = store.getState()` (`getCreds`, `api.ts:17`). All calls do `fetch(url + path, ...)`.
- Endpoint wrappers: `checkHealth(backendUrl, token)` (`api.ts:46-71`, hits `/api/health` then `/api/config`), `getConfig` (`/api/config`), `getSettings` / `saveSettings` (`/api/settings`), `listSessions` (`/api/sessions`), `getSession(id)` (`/api/sessions/:id`), `createSession(projectName, firstPrompt)` (`POST /api/sessions`), `sendTurn(sessionId, text)` (`POST /api/sessions/:id/turn`), `deleteSession(id)` (`DELETE /api/sessions/:id`), `transcribeAudio(pcm)` (`POST /api/transcribe` with `Content-Type: audio/pcm`, `api.ts:148-157`), and `bootstrap()` (`api.ts:209-221`, loads config + sessions on connect).

### SSE consumption — `frontend/src/api.ts` + `AppGlasses.tsx`
- Wrapper class **`SseClient`** (`api.ts:163-207`). Uses the browser **`EventSource`** (`api.ts:181`): `new EventSource(url + '/api/events?' + qs)` where `qs = URLSearchParams({ sessionId, token })` (`api.ts:177-181`) — token passed as **query param** because EventSource can't set headers. Parses via `JSON.parse(msg.data) as SseEvent` in `es.onmessage` (`api.ts:183-190`); relies on the server `retry:` hint for reconnection (`api.ts:191-196`).
- Subscribed in `AppGlasses.tsx:89-132`: `new SseClient('*', (ev: SseEvent) => { ... })`. It dispatches `ev.kind === 'global'` to `store.upsertSession` / `store.deleteSession`, and `ev.kind === 'transcript'` to `store.pushTranscriptEvent(ev.sessionId, tevt)`. It also intercepts `tool_use` with `name === 'AskUserQuestion'` (or a `question` event) to drive the `answering` screen (`AppGlasses.tsx:110-127`). The app opens ONE global `'*'` stream; per-session channels exist on the backend but the frontend currently uses the global one for transcripts.

### `frontend/src/audio.ts` — mic capture
- Capture API (module-level singleton; only one session at a time via `active` flag):
  - **`startCapture(): Promise<void>`** (`audio.ts:41-64`) — subscribes to `bridge.onEvenHubEvent`, collects `event.audioEvent.audioPcm` chunks (normalized to `Uint8Array` by `toUint8`, `audio.ts:20-39`), then `await bridge.audioControl(true)`.
  - **`stopCapture(): Promise<Uint8Array | null>`** (`audio.ts:66-89`) — `await bridge.audioControl(false)`, concatenates all chunks into a single `Uint8Array`, returns it (or `null` if no audio).
- Bridge obtained via `waitForEvenAppBridge()` from `'@evenrealities/even_hub_sdk'` (`audio.ts:1,12-14`).
- **Audio format / mime:** raw **PCM, 16 kHz, mono, s16le** (the glasses mic format). The bytes are sent to the backend as `Content-Type: audio/pcm` (`api.ts:151`); the backend wraps them in a WAV header. There is no client-side WAV/blob encoding — `stopCapture` returns raw PCM bytes (`Uint8Array`), not a `Blob`.

### Connect screen — `frontend/src/screens/Connect.tsx`
- Where the user enters Backend URL + Bearer token: the setup form in `Connect()` (`Connect.tsx:208-235`) — `Input type="url"` (Backend URL) and `Input type="password"` (Bearer token), saved by `onSave()` (`Connect.tsx:129-141`).
- **Persistence:** glasses/host local storage via `even-toolkit/storage` (`import { storageGet, storageSet, storageRemove } from 'even-toolkit/storage'`, `Connect.tsx:3`). Keys:
  - `const LS_URL = 'cc-g2.backendUrl'` (`Connect.tsx:7`)
  - `const LS_TOK = 'cc-g2.token'` (`Connect.tsx:8`)
  Wrapped in `safeGet` / `safeSet` / `safeRemove` (`Connect.tsx:10-19`). On mount it also auto-ingests `?backend=&token=` query params (the QR setup URL) and persists them (`Connect.tsx:84-109`), then calls `store.setCredentials(...)` + `checkAndBoot(...)`.
- This screen also renders the phone-side session dashboard (list + delete modal) and gesture cheat-sheet. Settings (permission mode / model / default project) live in the sibling `frontend/src/screens/Settings.tsx` (`SettingsCard`, calls `getSettings` / `saveSettings`).

---

## TOOLING

- **Test runner:** NONE configured. No `*.test.ts` / `*.test.tsx` / `*.spec.ts` files exist anywhere in the repo (verified). Neither `package.json` defines a `test` script. `bun test` would run but find zero tests. The only "tests" are the `typecheck` (backend) and `build` (frontend) commands the README/CONTRIBUTING ask contributors to run, plus the `dev.sh --smoke` health check.
- **tsconfig targets:**
  - `backend/tsconfig.json`: `"target": "ESNext"`, `"lib": ["ESNext"]`, `"module": "Preserve"`, `"moduleResolution": "bundler"`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `noEmit`, `strict`, `noUncheckedIndexedAccess`. (Bun runs `.ts` directly; imports use explicit `.ts` extensions, e.g. `import { loadConfig } from './config.ts'`.)
  - `frontend/tsconfig.json`: `"target": "ES2022"`, `"lib": ["ES2022","DOM","DOM.Iterable"]`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, `jsx: "react-jsx"`, `strict`, `noEmit`, path alias `@/* → ./src/*`. References `frontend/tsconfig.node.json` (target ES2022, for `vite.config.ts`).

- **`.gitignore` (repo root) — full contents:**
  ```
  node_modules/
  dist/
  .vite/
  .logs/
  *.log
  .env
  .env.local
  .DS_Store
  *.tsbuildinfo
  frontend/vite.config.d.ts
  frontend/vite.config.js
  # Glasses simulator / HUD capture screenshots
  glasses_*.png
  frontend/glasses_*.png

  # Scratch files at the repo root (commonly created by Claude during voice
  # tests when the user says "make a hello.py", "create calculator.py", etc).
  # Anything you actually want to keep should live in backend/, frontend/,
  # or a dedicated subfolder.
  /*.py
  /*.txt
  /*.js
  /PONG*
  /HELLO*
  !/README.md
  .gstack/
  ```
  - `.env` IS git-ignored (root + `backend/.gitignore` also ignores `.env`).
  - **`NOTES-fork-structure.md` is NOT ignored** — it does not match any pattern (it lives at repo root but is `.md`, and only `/*.py`, `/*.txt`, `/*.js`, `/PONG*`, `/HELLO*` root-globs apply, with `!/README.md` un-ignored). So this NOTES file WILL show up in `git status`.
  - `backend/.gitignore` (separate file) ignores `node_modules`, `out`, `dist`, `coverage`, `.env*`, `.idea`, `.DS_Store`, etc.

- **Env files:** `backend/.env.example` contains exactly `OPENAI_API_KEY=sk-...` and `PORT=8787`. The real `backend/.env` is git-ignored.

---

## Spike verdict (Task 1) — RESOLVED
`claude --resume <id>` CONTINUES the same session: a create+resume pair produced exactly ONE `.jsonl` (2 assistant turns appended to the same file), NO fork into a new session dir. Verdict = Outcome A. Mechanism is sound for "continue my session". The desktop-app-generating-simultaneously edge case is mitigated by the idle-guard module we build (do not block on it). NOTE: pass the user turn via stdin with `--input-format stream-json` (the positional `-p "..."` prompt did NOT get persisted as a user text line).
