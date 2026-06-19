import { basename } from 'node:path'
import { ClaudeCodeProc } from '../sessions/claudeProc.ts'
import { emitAttention } from './bus'
import { notifyTelegram } from './telegram'
import type { RuntimeConfig, VoiceSettings, EffortLevel } from '../config.ts'

// -----------------------------------------------------------------------------
// deliverToSession — the single place that spawns a resumed `claude` CLI run for
// a native session and feeds it one user prompt. Shared by BOTH the immediate
// send path (POST /sessions/:sid/message when idle) and the queue drain loop, so
// the spawn options + the attention-on-`result` wiring live in exactly one spot.
//
// Spawning makes the session busy again (the .jsonl mtime bumps), which is what
// the mtime-based idle guard keys off — so the drain loop naturally delivers one
// queued message at a time as the session frees up between turns.
// -----------------------------------------------------------------------------

// Structural slice of the runtime config this helper needs (mirrors the route's
// NativeConfig so callers can pass the same getConfig()).
export interface DeliverConfig {
  claudeBinary: string
  model: RuntimeConfig['model']
  permissionMode: RuntimeConfig['permissionMode']
  voice?: VoiceSettings
  effort?: EffortLevel
  ultracode?: boolean
}

export function deliverToSession(
  sid: string,
  cwd: string,
  prompt: string,
  cfg: DeliverConfig,
): void {
  const proc = new ClaudeCodeProc(
    {
      sessionId: sid,
      cwd,
      claudeBinary: cfg.claudeBinary,
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      effort: cfg.effort,
      ...(cfg.ultracode ? { settings: JSON.stringify({ ultracode: true }) } : {}),
      resume: true,
    },
    (ev) => {
      console.log('[native:resume]', sid.slice(0, 8), ev.kind)
      // A `result` event means the turn completed → Claude is now waiting on
      // the user. Surface a visual "needs you" alert on the HUD, AND fire an
      // out-of-band Telegram ping (works even if the glasses app is CLOSED).
      // ONLY on `result` (one per turn), never on every streamed event.
      if (ev.kind === 'result') {
        emitAttention(sid, { reason: 'turn_complete' })
        void notifyTelegram(`🔔 Claude terminó en ${basename(cwd)} — te espera.`)
      }
    },
  )
  proc.send(prompt)
}
