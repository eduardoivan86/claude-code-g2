import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Router, type Request, type Response } from 'express'
import type { RuntimeConfig } from '../config.ts'
import { ClaudeCodeProc } from '../sessions/claudeProc.ts'
import { claudeProjectsDir, findSessionFile } from '../native/paths'
import { listProjects, listSessions, readSessionMeta } from '../native/nativeSessions'
import { tailSession } from '../native/tailer'
import { isSessionIdle } from '../native/idleGuard'
import { emitAttention, onAttention } from '../native/bus'

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

export function makeNativeRouter(deps: NativeRouterDeps): Router {
  const router = Router()
  const root = deps.projectsRoot ?? claudeProjectsDir()

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
    if (!isSessionIdle(file)) {
      res.status(409).json({ error: 'session_busy' })
      return
    }
    const cfg = deps.getConfig()
    const proc = new ClaudeCodeProc(
      {
        sessionId: sid,
        cwd: meta.cwd,
        claudeBinary: cfg.claudeBinary,
        model: cfg.model,
        permissionMode: cfg.permissionMode,
        resume: true,
      },
      (ev) => {
        console.log('[native:resume]', sid.slice(0, 8), ev.kind)
        // A `result` event means the turn completed → Claude is now waiting on
        // the user. Surface a visual "needs you" alert on the HUD.
        if (ev.kind === 'result') {
          emitAttention(sid, { reason: 'turn_complete' })
        }
      },
    )
    proc.send(prompt)
    res.status(202).json({ ok: true })
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
