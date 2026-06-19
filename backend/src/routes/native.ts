import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { Router, type Request, type Response } from 'express'
import type { RuntimeConfig } from '../config.ts'
import { ClaudeCodeProc } from '../sessions/claudeProc.ts'
import { claudeProjectsDir, findSessionFile } from '../native/paths'
import { listProjects, listSessions, readSessionMeta, readRecentTurns } from '../native/nativeSessions'
import { tailSession } from '../native/tailer'
import { isSessionIdle } from '../native/idleGuard'
import { emitAttention, onAttention } from '../native/bus'
import { deliverToSession } from '../native/deliver'
import { enqueue } from '../native/queue'
import { runBrain } from '../native/brain'
import { appendBrainLog, readBrainLog } from '../native/brainLog'
import { ttsConfigFromEnv } from '../native/ttsConfig.ts'
import { synthesize } from '../native/tts.ts'

// -----------------------------------------------------------------------------
// "Native sessions" HTTP API.
//
// Exposes the user's own ~/.claude/projects/*.jsonl transcripts (written by the
// regular `claude` CLI) for browsing + mirroring on the glasses, and lets the
// HUD append a turn to one (resume) or start a brand-new native session.
//
// Mounted at /native inside the already-bearer-authed router, so the final
// paths are /api/native/*. bearerAuth is applied by the parent router; this
// router adds none of its own auth.
//
// Appended turns surface to clients via the per-session mirror SSE
// (GET /sessions/:sid/stream), NOT inline in the message/new responses — those
// just acknowledge that the CLI was spawned.
// -----------------------------------------------------------------------------

// Structural slice of the runtime config this router needs. Using a structural
// type (rather than importing only RuntimeConfig) keeps the dependency surface
// honest and lets tests pass a tiny fake.
export interface NativeConfig {
  claudeBinary: string
  model: RuntimeConfig['model']
  permissionMode: RuntimeConfig['permissionMode']
}

export interface NativeRouterDeps {
  getConfig: () => NativeConfig
  projectsRoot?: string
}

// Guard a single path segment supplied by the client. Reject anything that
// could escape the projects root.
function isUnsafeSegment(seg: string): boolean {
  return seg.includes('/') || seg.includes('\\') || seg.includes('..')
}

// -----------------------------------------------------------------------------
// Active-session handoff record. The server is the source of truth for "the
// session the user is actively working on". It's a tiny JSON file beside
// config.json (~/.cc-g2/handoff.json) with shape `{ "sessionId": "<id>" }`, or
// `{}` when cleared. It's SET when (a) the glasses open a session, or (b) the
// Mac `g2 handoff` command runs; CLEARED when the user backs out of the mirror.
//
// On app init the glasses GET it and, if it resolves to a real session,
// auto-open that session's mirror — which (foreground) gives ▶ Continuar and
// (headless background) reconnects the mirror SSE so the attention banner can
// still fire with the phone pocketed.
// -----------------------------------------------------------------------------

// Mirror config.ts: the config dir lives at ~/.cc-g2.
function handoffDir(): string {
  return join(homedir(), '.cc-g2')
}
function handoffPath(): string {
  return join(handoffDir(), 'handoff.json')
}

function readHandoffSid(): string | null {
  const p = handoffPath()
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, 'utf8')
    const obj = JSON.parse(raw) as { sessionId?: unknown }
    const sid = obj?.sessionId
    return typeof sid === 'string' && sid.length > 0 ? sid : null
  } catch {
    // Corrupt/unparseable handoff file behaves like "no handoff set".
    return null
  }
}

function writeHandoffSid(sid: string | null): void {
  const dir = handoffDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const body = sid ? JSON.stringify({ sessionId: sid }) : JSON.stringify({})
  // 0600 like the token-bearing config file — it points at a working session.
  writeFileSync(handoffPath(), body, { mode: 0o600 })
}

export function makeNativeRouter(deps: NativeRouterDeps): Router {
  const router = Router()
  const root = deps.projectsRoot ?? claudeProjectsDir()

  // ----- active-session handoff (set/clear) ----------------------------------
  // Body `{ sessionId: string | null }`. null/empty clears the pin.
  router.post('/handoff', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: unknown }
    const raw = body?.sessionId
    const sid = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
    // Reject ids that could escape the projects root (same guard as findSessionFile).
    if (sid && (sid.includes('/') || sid.includes('\\') || sid.includes('..'))) {
      res.status(400).json({ error: 'bad_session_id' })
      return
    }
    try {
      writeHandoffSid(sid)
    } catch (err) {
      console.error('[native:handoff] write failed:', err)
      res.status(500).json({ error: 'write_failed' })
      return
    }
    res.json({ ok: true })
  })

  // ----- active-session handoff (read) ---------------------------------------
  // Returns the pinned session enriched with cwd/project/title IFF it still
  // resolves to a real transcript; otherwise `{ sessionId: null }`.
  router.get('/handoff', (_req: Request, res: Response) => {
    const sid = readHandoffSid()
    if (!sid) {
      res.json({ sessionId: null })
      return
    }
    const file = findSessionFile(sid, root)
    if (!file) {
      res.json({ sessionId: null })
      return
    }
    const meta = readSessionMeta(file)
    if (!meta) {
      res.json({ sessionId: null })
      return
    }
    res.json({
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      project: meta.project,
      title: meta.title,
    })
  })

  // ----- list projects -------------------------------------------------------
  router.get('/projects', (_req: Request, res: Response) => {
    res.json(listProjects(root))
  })

  // ----- list sessions in a project dir --------------------------------------
  router.get('/projects/:dir/sessions', (req: Request, res: Response) => {
    const dir = decodeURIComponent(String(req.params.dir))
    if (isUnsafeSegment(dir)) {
      res.status(400).json({ error: 'bad_dir' })
      return
    }
    res.json(listSessions(join(root, dir)))
  })

  // ----- mirror an existing session via SSE ----------------------------------
  router.get('/sessions/:sid/stream', (req: Request, res: Response) => {
    const sid = String(req.params.sid)
    const file = findSessionFile(sid, root)
    if (!file) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // SSE headers — same pattern as events.ts.
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    res.write('retry: 3000\n\n')

    // tailSession replays current content first, then streams appended turns.
    const stop = tailSession(file, (turn) => {
      try {
        res.write('data: ' + JSON.stringify(turn) + '\n\n')
      } catch {
        /* connection gone; cleaned up by the close handler */
      }
    })
    // Also forward "Claude needs you" attention events for this session. These
    // ride the same SSE channel but are tagged `{ type: 'attention' }` so the
    // HUD can tell them apart from NativeTurn frames.
    const off = onAttention(sid, (p) => {
      try {
        res.write('data: ' + JSON.stringify({ type: 'attention', ...p }) + '\n\n')
      } catch {
        /* connection gone; cleaned up by the close handler */
      }
    })
    req.on('close', () => {
      stop()
      off()
    })
  })

  // ----- append a turn to an existing session (resume) -----------------------
  router.post('/sessions/:sid/message', (req: Request, res: Response) => {
    const sid = String(req.params.sid)
    const body = req.body as { prompt?: string }
    const prompt = String(body?.prompt ?? '').trim()
    if (!prompt) {
      res.status(400).json({ error: 'prompt required' })
      return
    }
    const file = findSessionFile(sid, root)
    if (!file) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const meta = readSessionMeta(file)
    if (!meta) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Robust delivery: if the session is idle, deliver immediately. If it's busy
    // (mid-turn), DON'T reject — queue the message and let the backend drain it
    // one-at-a-time as the session frees up. This survives the phone going to the
    // background because the backend, not the client, owns delivery timing.
    //
    // The delivered message lands in the real transcript, so the mirror SSE
    // echoes the user turn → the client uses that to clear its pending pin.
    if (isSessionIdle(file)) {
      deliverToSession(sid, meta.cwd, prompt, deps.getConfig())
      res.status(200).json({ ok: true, queued: false })
      return
    }
    enqueue(
      sid,
      { cwd: meta.cwd, prompt },
      { getConfig: deps.getConfig, projectsRoot: root },
    )
    res.status(202).json({ ok: true, queued: true })
  })

  // ----- conversational "brain" ----------------------------------------------
  // Body `{ sessionId, text }`. A fast Groq LLM decides whether to answer the
  // user directly from the session's recent context, or relay a well-formulated
  // dev request to the real Claude Code session (via the same idle→deliver /
  // busy→queue path the message route uses). Returns the spoken reply for the HUD.
  router.post('/brain', async (req: Request, res: Response) => {
    const body = req.body as { sessionId?: unknown; text?: unknown }
    const sid = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) {
      res.status(400).json({ error: 'text required' })
      return
    }
    const file = findSessionFile(sid, root)
    if (!file) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const meta = readSessionMeta(file)
    if (!meta) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const recent = readRecentTurns(file, 30)
    try {
      const out = await runBrain({
        sessionId: sid,
        cwd: meta.cwd,
        userText: text,
        recent,
        getConfig: deps.getConfig,
      })
      // Persist the exchange to a per-session sidecar log so it can be MERGED
      // into the mirror timeline (Option A) and survive for later reading. We do
      // NOT touch Claude's real transcript. A single timestamp keys both halves
      // of the exchange; +1ms on the reply keeps a stable user→brain ordering.
      const ts = Date.now()
      try {
        appendBrainLog(sid, [
          { ts, role: 'brain-user', text },
          { ts: ts + 1, role: 'brain', text: out.reply, relayed: out.relayed },
        ])
      } catch (logErr) {
        // The sidecar log is best-effort — a write failure must not fail the
        // brain reply the user is waiting on.
        console.error('[native:brain] sidecar log write failed:', logErr)
      }
      res.status(200).json({ reply: out.reply, relayed: out.relayed })
    } catch (err) {
      console.error('[native:brain] failed:', err)
      res.status(502).json({ error: 'brain_failed' })
    }
  })

  // ----- brain conversation sidecar log (read) -------------------------------
  // Returns the persisted brain exchanges for a session (oldest first) so the
  // mirror can merge them into the session timeline. Bad/unsafe sids resolve to
  // an empty array via readBrainLog's own guard.
  router.get('/brain-log/:sid', (req: Request, res: Response) => {
    const sid = String(req.params.sid)
    res.json(readBrainLog(sid))
  })

  // ----- text-to-speech (natural cloud voice with browser fallback) ----------
  // Body `{ text }`. Resolves the TTS provider from env. When no cloud provider
  // is configured (or its key is missing) → `{ browser: true }`, telling the
  // frontend to use the free speechSynthesis voice. Otherwise returns mp3 bytes.
  // On a synth error → 502 so the frontend can still fall back to the browser.
  router.post('/tts', async (req: Request, res: Response) => {
    const body = req.body as { text?: unknown }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) {
      res.status(400).json({ error: 'text required' })
      return
    }
    const cfg = ttsConfigFromEnv()
    if (cfg.provider === 'browser') {
      res.json({ browser: true })
      return
    }
    try {
      const buf = await synthesize(text, cfg)
      if (!buf) {
        res.json({ browser: true })
        return
      }
      res.set('Content-Type', 'audio/mpeg').send(buf)
    } catch (err) {
      console.error('[native:tts] synth failed:', err)
      res.status(502).json({ error: 'tts_failed' })
    }
  })

  // ----- start a brand-new native session ------------------------------------
  router.post('/sessions', (req: Request, res: Response) => {
    const body = req.body as { cwd?: string; prompt?: string; model?: string }
    const cwd = String(body?.cwd ?? '').trim()
    const prompt = String(body?.prompt ?? '').trim()
    if (!cwd || !prompt) {
      res.status(400).json({ error: 'cwd and prompt required' })
      return
    }
    const cfg = deps.getConfig()
    const sid = randomUUID()
    const proc = new ClaudeCodeProc(
      {
        sessionId: sid,
        cwd,
        claudeBinary: cfg.claudeBinary,
        model: body.model ?? cfg.model,
        permissionMode: cfg.permissionMode,
        resume: false,
      },
      (ev) => {
        console.log('[native:new]', sid.slice(0, 8), ev.kind)
        if (ev.kind === 'result') {
          emitAttention(sid, { reason: 'turn_complete' })
        }
      },
    )
    proc.send(prompt)
    res.json({ sessionId: sid })
  })

  return router
}
