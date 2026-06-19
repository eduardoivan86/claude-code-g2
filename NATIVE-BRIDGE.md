# Native Sessions Bridge (fork addition)

This fork extends [claude-code-g2](https://github.com/sam-siavoshian/claude-code-g2) so the G2 glasses become a **window + microphone into your REAL Claude Code sessions** — the ones in the Claude desktop app / terminal, stored at `~/.claude/projects/*.jsonl` — instead of the upstream's isolated session store (`~/.cc-g2/sessions.json`).

## What it adds

| Capability | Upstream | This fork |
|---|---|---|
| See the live session you have open in the Claude app on the glasses | ❌ | ✅ live mirror (tails the real `.jsonl`) |
| Voice → text → continue **that** development on your Mac | ❌ (creates a new one) | ✅ `claude --resume <id>` (same thread) |
| Browse your real previous sessions | ❌ | ✅ real per-project history |
| Start a new session | ✅ (isolated) | ✅ (also shows up in your Claude app) |

**Read is always safe** (read-only file tail — works even while the desktop app has the session open). **Write is a handoff**: a voice follow-up resumes the session only when it's idle; if it's mid-generation the API returns `409 session_busy` and the glasses stay read-only.

## Architecture

```
G2 glasses ──BLE──> phone (WebView) ──HTTPS+Bearer──> Mac backend (Bun + Express)
                                                          │
                  ┌────────────────────────────────────────┤
              [READ / mirror]                        [WRITE / voice]
   tail ~/.claude/projects/<cwd>/<sid>.jsonl   ClaudeCodeProc --resume <sid> | new
                  │                                        │
                  └──────────────► SSE ──────► HUD ◄───────┘
```

- New backend modules: `backend/src/native/` (`paths`, `transcript`, `nativeSessions`, `tailer`, `idleGuard`, `types`) — pure, unit-tested (`bun test backend/src/`).
- Driver: **reuses** the fork's `backend/src/sessions/claudeProc.ts` (`ClaudeCodeProc`, `--resume`/`--session-id` + stdin stream-json).
- Routes: `backend/src/routes/native.ts`, mounted under the existing bearer-authed `/api`.
- Frontend: `NativeProjects` / `NativeSessions` / `NativeMirror` screens registered in `frontend/src/glass/selectors.ts`.

## API (all under `/api`, bearer via header or `?token=`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/native/projects` | list real projects (`~/.claude/projects`) by recency |
| GET | `/api/native/projects/:dir/sessions` | list sessions in a project |
| GET | `/api/native/sessions/:sid/stream` | SSE: replay + live-tail turns (`data: <Turn>`) |
| POST | `/api/native/sessions/:sid/message` | `{prompt}` → resume & continue (409 if busy) |
| POST | `/api/native/sessions` | `{cwd, prompt}` → start a new real session |
| POST | `/api/native/handoff` | `{sessionId: string\|null}` → pin/clear the active session |
| GET | `/api/native/handoff` | read the pinned session (`{sessionId, cwd, project, title}` or `{sessionId:null}`) |

## Active-session handoff (▶ Continuar + background reconnect)

The backend is the source of truth for **"the session you're actively working on"** — a tiny `~/.cc-g2/handoff.json` (`{ "sessionId": "<id>" }`, or `{}` when cleared). It's SET when the glasses open a session (or you run `g2 handoff`), and CLEARED when you back out of the mirror.

On app init the glasses `GET /api/native/handoff`; if it resolves to a real transcript they auto-open that session's mirror. This delivers three things:

1. **▶ Continuar** — a foreground launch resumes your active session.
2. **`g2 handoff`** — pin from the Mac the session you're at the keyboard with, so the glasses pick it up.
3. **Background notifications** — the headless background WebView's fresh load runs the same GET → reconnects the mirror SSE → the existing "Claude te espera" attention banner fires even with the phone pocketed.

### `scripts/g2-handoff.sh` — pin from the Mac

Run this **before you leave the desk** to pin the session you're working on:

```bash
./scripts/g2-handoff.sh             # auto-detect: newest ~/.claude/projects/*.jsonl (excl. /subagents/)
./scripts/g2-handoff.sh <sessionId> # or pin an explicit session id
PORT=9000 ./scripts/g2-handoff.sh   # non-default backend port
```

It reads the bearer token from `~/.cc-g2/config.json` and POSTs the session id to `http://127.0.0.1:${PORT:-8787}/api/native/handoff`. Requires `python3` + `curl`; the backend must be running.

## Transcription (pluggable, default Groq)

Voice is transcribed via an OpenAI-compatible `/audio/transcriptions` endpoint. Configure in `backend/.env`:

```
TRANSCRIBE_PROVIDER=groq           # default
GROQ_API_KEY=gsk_...               # from https://console.groq.com/keys
# fallbacks:
# TRANSCRIBE_PROVIDER=openai + OPENAI_API_KEY=sk-...
# TRANSCRIBE_PROVIDER=local  + WHISPER_BASE_URL=http://127.0.0.1:8080/v1
```

Groq `whisper-large-v3-turbo`: ~$0.04/h, ~200× real-time, large-v3 quality. The key stays server-side on the Mac.

## Run & test on the glasses

```bash
# 1. deps + Claude auth (uses your Max/Pro subscription, no API key)
bun install
claude auth login

# 2. transcription key
#    edit backend/.env and set GROQ_API_KEY=...

# 3. launch everything (backend :8787 + frontend :5173 + cloudflared tunnel + QR),
#    keeping the Mac awake:
caffeinate -dimsu ./dev.sh

# 4. bearer token for the connect screen:
cat ~/.cc-g2/config.json     # the "token" field
```

5. Scan the QR (printed by `dev.sh`) with the **Even Realities** app to sideload the WebView.
6. On the connect screen: Backend URL = the `https://…trycloudflare.com` tunnel URL, paste the token, **Connect**.
7. On the glasses: **2-tap → sidebar → `⌂ native` → project → session → mirror**. **Tap to talk.**

### Remote access (outside your Wi-Fi)
- **cloudflared** (default, zero setup): `dev.sh` opens a public `trycloudflare.com` tunnel, gated by the bearer token. URL is ephemeral (changes each run).
- **Tailscale** (private + stable, optional): `brew install tailscale` → log in on Mac + phone → point the connect screen at `http://<mac-tailscale-name>:8787`.

## Security note (single-user posture)

`POST /api/native/sessions` accepts an arbitrary `cwd` and spawns `claude` with `--dangerously-skip-permissions` (hands-free has no way to approve tool prompts). The bearer token on a trusted/private network is the security boundary. This is intentional for single-user use; do not expose the backend without the token.

## Status

Code complete and verified: 30 backend unit tests pass, `vite build` succeeds. Pending on-device tuning: HUD wrap widths, SSE reconnection window for freshly-created sessions, and voice/transcription latency timers.
