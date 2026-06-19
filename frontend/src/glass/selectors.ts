import { createGlassScreenRouter, type GlassScreen } from 'even-toolkit/glass-screen-router'
import type { GlassNavState, DisplayData } from 'even-toolkit/types'
import { line } from './theme'
import type { AppMode } from '../types'
import type { AppSnapshot, AppActions } from './shared'
import { mainScreen } from './screens/main'
import { recordingScreen } from './screens/recording'
import { pickingScreen } from './screens/picking'
import { confirmingScreen } from './screens/confirming'
import { answeringScreen } from './screens/answering'
import { nativeProjectsScreen } from './screens/nativeProjects'
import { nativeSessionsScreen } from './screens/nativeSessions'
import { nativeMirrorScreen } from './screens/nativeMirror'

export type { AppSnapshot, AppActions }

type RoutableMode = Exclude<AppMode, 'unconfigured'>

const screens: Record<RoutableMode, GlassScreen<AppSnapshot, AppActions>> = {
  'main': mainScreen,
  'recording-new': recordingScreen,
  'transcribing': recordingScreen,
  'picking-project': pickingScreen,
  'recording-turn': recordingScreen,
  'confirming-transcript': confirmingScreen,
  'answering': answeringScreen,
  'native-projects': nativeProjectsScreen,
  'native-sessions': nativeSessionsScreen,
  'native-mirror': nativeMirrorScreen,
}

const router = createGlassScreenRouter(screens, 'main')

export const { onGlassAction } = router

// 3-tap HUD hide: when hidden, render a near-blank/dim screen (one faint dot)
// for EVERY screen, before delegating to the per-screen display. This keeps the
// app + SSE alive while the glasses go dark, with no per-screen edits.
export function toDisplayData(snapshot: AppSnapshot, nav: GlassNavState): DisplayData {
  if (snapshot.hudHidden) {
    return {
      lines: [
        line(''),
        line(''),
        line(''),
        line(''),
        line('              ·', 'meta'),
        line(''),
        line(''),
        line(''),
        line(''),
        line(''),
      ],
    }
  }
  return router.toDisplayData(snapshot, nav)
}
