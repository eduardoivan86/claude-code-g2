import { EventEmitter } from 'node:events'

// -----------------------------------------------------------------------------
// Attention bus.
//
// A tiny singleton pub/sub used to surface "Claude needs you" moments for a
// native session: when a resumed/new ClaudeCodeProc emits a `result` event the
// turn is COMPLETE and Claude is now waiting on the user. The message route
// publishes here; the per-session mirror SSE (GET /sessions/:sid/stream)
// subscribes and forwards an `{ type: 'attention', ... }` frame to the HUD.
//
// Channel naming: `attention:<sessionId>` so listeners are isolated per session
// and we never cross-deliver. Process-local only (no persistence) — that is
// fine because the SSE connection it feeds is itself process-local.
// -----------------------------------------------------------------------------

export interface AttentionPayload {
  reason: string
}

const emitter = new EventEmitter()
// A session can have several concurrent mirror streams (e.g. phone + a debug
// tab). Lift the default 10-listener cap so we don't log spurious warnings.
emitter.setMaxListeners(0)

function channel(sessionId: string): string {
  return `attention:${sessionId}`
}

// Subscribe to attention events for one session. Returns an unsubscribe fn the
// caller MUST invoke on teardown (e.g. in the SSE `req.on('close')` handler) to
// avoid leaking listeners across reconnects.
export function onAttention(
  sessionId: string,
  cb: (payload: AttentionPayload) => void,
): () => void {
  const ch = channel(sessionId)
  emitter.on(ch, cb)
  return () => {
    emitter.off(ch, cb)
  }
}

// Publish an attention event for one session. No-op if nobody is listening.
export function emitAttention(sessionId: string, payload: AttentionPayload): void {
  emitter.emit(channel(sessionId), payload)
}
