import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { moveHighlight } from 'even-toolkit/glass-nav'
import type { AppSnapshot, AppActions } from '../shared'
import { line } from '../theme'

// Native sessions list for one project. The first row is the [+] new-session
// affordance (voice → new native session), mirroring the [+ new] idiom in the
// main sidebar. Remaining rows are existing sessions: title + relative time.
//
//   claude-code-g2  3 sessions
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   [+ new session]
//    fix the pong test          2m
//    add native bridge          1h
//   tap: open · [+]: new · 2tap: back

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return text.slice(0, maxLen)
  return text.slice(0, maxLen - 1) + '…'
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return 'now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

// Pad a label so the trailing time lands right-aligned within the HUD width.
// Widened alongside nativeMirror.FULL_COLS (44→52) to use more of the 576px
// display; ~46 leaves a small safety margin under the ~52-col reading width.
function rowWithTime(label: string, time: string): string {
  const WIDTH = 46
  const t = time
  const room = WIDTH - t.length - 1
  const head = truncate(label, Math.max(1, room))
  const pad = Math.max(1, WIDTH - head.length - t.length)
  return head + ' '.repeat(pad) + t
}

// Index 0 = [+ new session]. Indices 1..N = sessions.
function itemCount(snapshot: AppSnapshot): number {
  return snapshot.nativeSessions.length + 1
}

export const nativeSessionsScreen: GlassScreen<AppSnapshot, AppActions> = {
  display(snapshot, nav) {
    const sessions = snapshot.nativeSessions
    const project = snapshot.nativeSelectedProject ?? 'project'
    const max = itemCount(snapshot) - 1

    const lines = [
      line(`${truncate(project, 36)}  ${sessions.length} session${sessions.length === 1 ? '' : 's'}`, 'meta'),
      line('━'.repeat(46), 'meta'),
    ]

    if (snapshot.nativeLoading && sessions.length === 0) {
      lines.push(line('[+ new session]'))
      lines.push(line('loading…', 'meta'))
      while (lines.length < 9) lines.push(line(''))
      lines.push(line('[+]: new · 2tap: back', 'meta'))
      return { lines }
    }

    const items: string[] = ['+ new session']
    for (const s of sessions) {
      items.push(rowWithTime(s.title || s.sessionId.slice(0, 8), timeAgo(s.updatedAt)))
    }

    lines.push(...buildScrollableList({
      items,
      highlightedIndex: Math.min(nav.highlightedIndex, max),
      maxVisible: 6,
      // Highlight is rendered via the inverted flag (same as picking/answering).
      formatter: (item) => item,
    }))

    while (lines.length < 9) lines.push(line(''))
    lines.push(line('tap: open · [+]: new · 2tap: back', 'meta'))
    return { lines }
  },

  action(action, nav, snapshot, ctx) {
    const sessions = snapshot.nativeSessions
    const max = itemCount(snapshot) - 1

    if (action.type === 'HIGHLIGHT_MOVE') {
      return { ...nav, highlightedIndex: moveHighlight(nav.highlightedIndex, action.direction, max) }
    }
    if (action.type === 'SELECT_HIGHLIGHTED') {
      const idx = Math.min(nav.highlightedIndex, max)
      if (idx === 0) {
        // [+ new session] → voice → new native session in this project's cwd.
        ctx.startNativeNewSession()
        return { ...nav, highlightedIndex: 0 }
      }
      const s = sessions[idx - 1]
      if (s) ctx.openNativeSession(s.sessionId, s.cwd)
      return { ...nav, highlightedIndex: 0 }
    }
    if (action.type === 'GO_BACK') {
      ctx.nativeBack() // → projects
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
