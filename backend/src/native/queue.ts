import { findSessionFile } from './paths'
import { isSessionIdle } from './idleGuard'
import { deliverToSession, type DeliverConfig } from './deliver'

// -----------------------------------------------------------------------------
// Backend-side pending-message queue for native sessions.
//
// When a voice follow-up arrives while a session is mid-turn (busy), the route
// enqueues it here instead of rejecting with 409. A per-sid drain loop then
// delivers queued messages ONE AT A TIME as the session frees up between turns,
// so a backgrounded phone no longer has to babysit retries — delivery survives
// the app being suspended because it's the backend doing the work.
//
// Design notes (see brief):
//   - One drain loop per sid (guarded by a Map of active timers) so we never run
//     overlapping loops for the same session.
//   - Idle detection is mtime-based (isSessionIdle). Delivering a message bumps
//     the .jsonl mtime → the session reads busy again → the loop waits for the
//     NEXT idle window before delivering the next item. That's what stops us from
//     "blasting" every queued message into a busy session at once.
//   - The loop stops itself (clearInterval) the moment the queue for that sid is
//     empty, so there's no idle busy-spin once everything is delivered.
//   - A deliver failure drops THAT item (console.warn) rather than stalling the
//     whole loop on a poison message.
//
// CAVEAT: this is in-memory only. A backend restart loses any queued-but-not-yet-
// delivered messages. Acceptable for now; the durable transcript is the source
// of truth once a message is actually delivered.
// -----------------------------------------------------------------------------

export interface QueueItem {
  cwd: string
  prompt: string
}

// Context the drain loop needs to deliver: how to resolve session files and the
// runtime config to spawn the CLI with. Injected so tests can pass fakes.
export interface QueueContext {
  getConfig: () => DeliverConfig
  projectsRoot?: string
}

// How often the drain loop wakes to check whether the session is idle.
const DRAIN_INTERVAL_MS = 2000

const queues = new Map<string, QueueItem[]>()
const timers = new Map<string, ReturnType<typeof setInterval>>()

// Push an item and ensure a drain loop is running for that sid.
export function enqueue(sid: string, item: QueueItem, ctx: QueueContext): void {
  const q = queues.get(sid)
  if (q) {
    q.push(item)
  } else {
    queues.set(sid, [item])
  }
  ensureDrain(sid, ctx)
}

function ensureDrain(sid: string, ctx: QueueContext): void {
  if (timers.has(sid)) return // a loop is already running for this sid
  const timer = setInterval(() => drainTick(sid, ctx), DRAIN_INTERVAL_MS)
  timers.set(sid, timer)
}

function stopDrain(sid: string): void {
  const timer = timers.get(sid)
  if (timer) {
    clearInterval(timer)
    timers.delete(sid)
  }
  queues.delete(sid)
}

function drainTick(sid: string, ctx: QueueContext): void {
  const q = queues.get(sid)
  // Nothing left → tear the loop down (no idle busy-spin).
  if (!q || q.length === 0) {
    stopDrain(sid)
    return
  }
  const file = findSessionFile(sid, ctx.projectsRoot)
  // If the session file vanished, we can never deliver — drop everything so the
  // loop doesn't spin forever on items that can't land.
  if (!file) {
    console.warn(`[native:queue] ${sid.slice(0, 8)} session file gone; dropping ${q.length} queued`)
    stopDrain(sid)
    return
  }
  // Only deliver into an idle session. Delivering makes it busy again, so the
  // next item waits for the following idle window → one-at-a-time, no blast.
  if (!isSessionIdle(file)) return

  const item = q.shift()! // oldest-first
  try {
    deliverToSession(sid, item.cwd, item.prompt, ctx.getConfig())
  } catch (err) {
    // Drop this item rather than stalling the loop on a poison message.
    console.warn(`[native:queue] ${sid.slice(0, 8)} deliver failed; dropping item:`, err)
  }
  // If that was the last item, stop on the next tick (drainTick will see empty).
  if (q.length === 0) stopDrain(sid)
}

// Test/diagnostic helper: number of items currently queued for a sid.
export function queueLength(sid: string): number {
  return queues.get(sid)?.length ?? 0
}
