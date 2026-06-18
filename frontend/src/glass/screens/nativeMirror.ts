import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import type { AppSnapshot, AppActions } from '../shared'
import type { NativeTurn } from '../../types'
import { line, separator } from '../theme'

// Live mirror of one native ~/.claude session.
//   - assistant text: prominent, "│ " prefix (same vocabulary as main.ts)
//   - user prompts:   light, "> " prefix
//   - toolUses:       compact one-line "· <name> <summary>"
//   - thinking:       dimmed, "~ " prefix (kept short; mostly skipped)
//   - tool_result user turns (isToolResult): skipped
// Tap = record a voice follow-up. Transient status overlays the header.

const FULL_COLS = 44
const VISIBLE = 7

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return text.slice(0, maxLen)
  return text.slice(0, maxLen - 1) + '…'
}

function wrapText(text: string, width: number, prefix = ''): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  if (words.length === 0 || (words.length === 1 && words[0] === '')) return []
  const indent = ' '.repeat(prefix.length)
  const out: string[] = []
  let cur = ''
  let isFirst = true
  for (const w of words) {
    const pfx = isFirst ? prefix : indent
    const room = width - pfx.length
    if (cur.length === 0) {
      cur = w.length <= room ? w : w.slice(0, room)
      continue
    }
    if (cur.length + 1 + w.length <= room) {
      cur += ' ' + w
    } else {
      out.push(pfx + cur)
      isFirst = false
      cur = w.length <= width - indent.length ? w : w.slice(0, width - indent.length)
    }
  }
  if (cur) out.push((isFirst ? prefix : indent) + cur)
  return out
}

// Flatten turns into display strings. Each entry carries a style hint so the
// renderer can dim user/tool/thinking lines.
interface MLine { text: string; style: 'normal' | 'meta' }

function turnsToLines(turns: NativeTurn[]): MLine[] {
  const out: MLine[] = []
  let first = true
  for (const t of turns) {
    // Skip machine tool_result user turns entirely.
    if (t.role === 'user' && t.isToolResult) continue

    if (t.role === 'user') {
      if (!first) out.push({ text: '───', style: 'meta' })
      for (const l of wrapText(t.text, FULL_COLS, '> ')) out.push({ text: l, style: 'meta' })
      first = false
      continue
    }

    // assistant
    // thinking: dimmed, 1 short line at most (keep the HUD readable).
    if (t.thinking && t.thinking.trim()) {
      const tline = wrapText(t.thinking, FULL_COLS, '~ ')[0]
      if (tline) out.push({ text: tline, style: 'meta' })
    }
    // assistant text: prominent.
    if (t.text && t.text.trim()) {
      for (const l of wrapText(t.text, FULL_COLS, '│ ')) out.push({ text: l, style: 'normal' })
    }
    // tool uses: compact one-liners.
    for (const tu of t.toolUses) {
      const summary = tu.summary ? ' ' + truncate(tu.summary, 30) : ''
      out.push({ text: truncate(`· ${tu.name}${summary}`, FULL_COLS), style: 'meta' })
    }
    first = false
  }
  return out
}

function scrollBar(totalLines: number, visibleLines: number, offset: number): string {
  if (totalLines <= visibleLines) return ''
  const barLen = 7
  const maxOffset = totalLines - visibleLines
  const clampedOffset = Math.min(offset, maxOffset)
  const ratio = maxOffset > 0 ? clampedOffset / maxOffset : 0
  const thumbSize = Math.max(1, Math.round((visibleLines / totalLines) * barLen))
  const thumbStart = Math.round((1 - ratio) * (barLen - thumbSize))
  let bar = ''
  for (let i = 0; i < barLen; i++) {
    bar += i >= thumbStart && i < thumbStart + thumbSize ? '▓' : '░'
  }
  const canUp = clampedOffset < maxOffset
  const canDown = clampedOffset > 0
  const arrows = (canUp ? '▲' : ' ') + (canDown ? '▼' : ' ')
  return `${arrows} ${bar}`
}

function statusLabel(snapshot: AppSnapshot): string | null {
  switch (snapshot.nativeMirrorStatus) {
    case 'transcribing': return '◐ transcribiendo…'
    case 'sending': return '◐ enviando…'
    case 'busy': return '! sesión ocupada'
    case 'connecting': return '◐ conectando…'
    default: return null
  }
}

export const nativeMirrorScreen: GlassScreen<AppSnapshot, AppActions> = {
  display(snapshot) {
    const allLines = turnsToLines(snapshot.nativeTurns)
    const totalLines = allLines.length
    const maxOffset = Math.max(0, totalLines - VISIBLE)
    const offset = Math.min(snapshot.sessionScrollOffset, maxOffset)
    const startLine = Math.max(0, totalLines - VISIBLE - offset)
    const visible = allLines.slice(startLine, startLine + VISIBLE)
    const bar = scrollBar(totalLines, VISIBLE, offset)

    const lines = []
    const status = statusLabel(snapshot)
    if (status) {
      lines.push(line(status))
    } else if (totalLines === 0) {
      lines.push(line(`◆ MIRROR ${bar}`))
    } else {
      const sid = snapshot.nativeMirrorSid ?? ''
      lines.push(line(`◆ ${truncate(sid.slice(0, 8), 16)} ${bar}`))
    }
    lines.push(separator())

    if (totalLines === 0 && !status) {
      lines.push(line('waiting for transcript…', 'meta'))
    } else {
      for (const l of visible) lines.push(line(l.text, l.style))
    }

    while (lines.length < 9) lines.push(line(''))

    // Footer: status-aware.
    let hint: string
    if (snapshot.nativeMirrorStatus === 'busy') {
      hint = 'sesión ocupada · 2tap: back'
    } else if (snapshot.nativeMirrorStatus) {
      hint = '2tap: back'
    } else {
      hint = 'tap: talk · swipe: scroll · 2tap: back'
    }
    lines.push(line(hint, 'meta'))

    return { lines: lines.slice(0, 10) }
  },

  action(action, nav, snapshot, ctx) {
    if (action.type === 'HIGHLIGHT_MOVE') {
      const delta = action.direction === 'down' ? 5 : -5
      ctx.scrollNativeMirror(delta)
      return nav
    }
    if (action.type === 'SELECT_HIGHLIGHTED') {
      // Don't start a new recording while a follow-up is mid-flight.
      if (!snapshot.nativeMirrorStatus) ctx.recordNativeFollowUp()
      return nav
    }
    if (action.type === 'GO_BACK') {
      // Scrolled up → jump to bottom first; otherwise back to sessions list.
      if (snapshot.sessionScrollOffset > 0) {
        ctx.scrollNativeMirror(-snapshot.sessionScrollOffset)
        return nav
      }
      ctx.nativeBack()
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
