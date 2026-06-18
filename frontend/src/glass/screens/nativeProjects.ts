import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { moveHighlight } from 'even-toolkit/glass-nav'
import type { AppSnapshot, AppActions } from '../shared'
import { line } from '../theme'

// Native projects browser — lists ~/.claude/projects (sorted by recency).
// There can be hundreds; buildScrollableList windows them so only ~6 render.
//
//   NATIVE  12 projects
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//    claude-code-g2  4
//   [my-other-app  2]
//    × back
//   swipe: scroll · tap: open · 2tap: back

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return text.slice(0, maxLen)
  return text.slice(0, maxLen - 1) + '…'
}

// One synthetic trailing row so the user can always back out via tap, too.
const BACK_ITEM = '× back'

function itemCount(snapshot: AppSnapshot): number {
  return snapshot.nativeProjects.length + 1 // + back
}

export const nativeProjectsScreen: GlassScreen<AppSnapshot, AppActions> = {
  display(snapshot, nav) {
    const projects = snapshot.nativeProjects
    const max = itemCount(snapshot) - 1

    const lines = [
      line(`NATIVE  ${projects.length} project${projects.length === 1 ? '' : 's'}`, 'meta'),
      line('━'.repeat(40), 'meta'),
    ]

    if (snapshot.nativeLoading && projects.length === 0) {
      lines.push(line('loading…'))
      while (lines.length < 9) lines.push(line(''))
      lines.push(line('2tap: back', 'meta'))
      return { lines }
    }

    if (projects.length === 0) {
      lines.push(line('no projects found'))
      while (lines.length < 9) lines.push(line(''))
      lines.push(line('2tap: back', 'meta'))
      return { lines }
    }

    // Build display strings: "<project>  <sessionCount>" then the back row.
    const items: string[] = projects.map(
      (p) => `${truncate(p.project, 34)}  ${p.sessionCount}`,
    )
    items.push(BACK_ITEM)

    lines.push(...buildScrollableList({
      items,
      highlightedIndex: Math.min(nav.highlightedIndex, max),
      maxVisible: 6,
      formatter: (item) => item,
    }))

    while (lines.length < 9) lines.push(line(''))
    lines.push(line('tap: open · 2tap: back', 'meta'))
    return { lines }
  },

  action(action, nav, snapshot, ctx) {
    const projects = snapshot.nativeProjects
    const max = itemCount(snapshot) - 1

    if (action.type === 'HIGHLIGHT_MOVE') {
      return { ...nav, highlightedIndex: moveHighlight(nav.highlightedIndex, action.direction, max) }
    }
    if (action.type === 'SELECT_HIGHLIGHTED') {
      const idx = Math.min(nav.highlightedIndex, max)
      // Last row is the back affordance.
      if (idx >= projects.length) {
        ctx.exitNative()
        return { ...nav, highlightedIndex: 0 }
      }
      const p = projects[idx]
      if (p) {
        // :dir is the dirPath basename, URL-encoded by the API client.
        const dirBasename = p.dirPath.split('/').pop() ?? p.dirPath
        ctx.pickNativeProject(dirBasename, p.project)
      }
      return { ...nav, highlightedIndex: 0 }
    }
    if (action.type === 'GO_BACK') {
      ctx.exitNative()
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
