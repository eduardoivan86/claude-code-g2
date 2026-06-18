import { useSyncExternalStore } from 'react'
import type {
  AppMode,
  BackendConfig,
  ConnectionStatus,
  NativeProjectSummary,
  NativeSessionSummary,
  NativeTurn,
  SessionSummary,
  TranscriptEvent,
} from './types'
import type { ConfirmAction, PendingQuestion } from './glass/shared'

// Transient HUD status shown while a native voice follow-up is in flight.
export type NativeMirrorStatus =
  | null
  | 'transcribing' // capturing → whisper
  | 'sending'      // POST message in flight
  | 'busy'         // 409 session_busy
  | 'connecting'   // opening the mirror stream (esp. new sessions)

export interface AppState {
  backendUrl: string | null
  token: string | null
  connection: ConnectionStatus
  connectionError: string | null

  projects: string[]
  defaultProjectName: string | null

  sessions: SessionSummary[]

  activeSessionId: string | null
  activeTranscript: TranscriptEvent[]

  mode: AppMode

  recordStartedAt: number | null
  pendingTranscript: string | null

  error: string | null

  navIndex: number
  sessionScrollOffset: number

  // Phase 2
  confirmAction: ConfirmAction | null
  lastActivityAt: number
  transcriptCache: Record<string, TranscriptEvent[]>

  // Phase 3
  confirmTranscriptFlow: 'new' | 'turn' | null
  pendingQuestion: PendingQuestion | null

  scrollingTranscript: boolean
  sidebarVisible: boolean

  // ── Native sessions bridge ──────────────────────────────────────────────
  nativeProjects: NativeProjectSummary[]
  nativeSessions: NativeSessionSummary[]
  nativeSelectedDir: string | null     // dirPath basename feeding the sessions list
  nativeSelectedProject: string | null // human project name for the header
  nativeMirrorSid: string | null
  nativeMirrorCwd: string | null        // cwd of the mirrored session (for follow-ups → new isn't used here)
  nativeTurns: NativeTurn[]
  nativeMirrorStatus: NativeMirrorStatus
  nativeLoading: boolean
}

const initialState: AppState = {
  backendUrl: null,
  token: null,
  connection: 'unknown',
  connectionError: null,

  projects: [],
  defaultProjectName: null,

  sessions: [],

  activeSessionId: null,
  activeTranscript: [],

  mode: 'unconfigured',

  recordStartedAt: null,
  pendingTranscript: null,

  error: null,

  navIndex: 0,
  sessionScrollOffset: 0,

  confirmAction: null,
  lastActivityAt: Date.now(),
  transcriptCache: {},

  confirmTranscriptFlow: null,
  pendingQuestion: null,
  scrollingTranscript: false,
  sidebarVisible: false,

  nativeProjects: [],
  nativeSessions: [],
  nativeSelectedDir: null,
  nativeSelectedProject: null,
  nativeMirrorSid: null,
  nativeMirrorCwd: null,
  nativeTurns: [],
  nativeMirrorStatus: null,
  nativeLoading: false,
}

let state: AppState = initialState
const listeners = new Set<() => void>()

function shallowEqual<T extends object>(a: T, partial: Partial<T>): boolean {
  for (const k in partial) {
    if (!Object.is(a[k], partial[k])) return false
  }
  return true
}

function set(partial: Partial<AppState>): void {
  if (shallowEqual(state, partial)) return
  state = { ...state, ...partial }
  for (const l of listeners) l()
}

const RECORDING_MODES: ReadonlySet<AppMode> = new Set(['recording-new', 'recording-turn'])

export function isRecordingMode(mode: AppMode): boolean {
  return RECORDING_MODES.has(mode)
}

function isSameEvent(a: TranscriptEvent, b: TranscriptEvent): boolean {
  if (a.kind !== b.kind || a.ts !== b.ts) return false
  if (a.kind === 'tool_use' && b.kind === 'tool_use') return a.toolUseId === b.toolUseId
  if (a.kind === 'tool_result' && b.kind === 'tool_result') return a.toolUseId === b.toolUseId
  if (a.kind === 'assistant_text' && b.kind === 'assistant_text') return a.text === b.text
  if (a.kind === 'user' && b.kind === 'user') return a.text === b.text
  return true
}

// Max number of session transcripts to cache for quick-switch.
const CACHE_MAX = 5

export const store = {
  getState(): AppState {
    return state
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  setCredentials(backendUrl: string, token: string): void {
    set({
      backendUrl: backendUrl.replace(/\/$/, ''),
      token,
      mode: 'main',
      connection: 'unknown',
      connectionError: null,
    })
  },
  clearCredentials(): void {
    set({
      backendUrl: null,
      token: null,
      connection: 'unknown',
      mode: 'unconfigured',
    })
  },
  setConnection(status: ConnectionStatus, err?: string | null): void {
    set({ connection: status, connectionError: err ?? null })
  },
  setBackendConfig(cfg: BackendConfig): void {
    set({
      projects: cfg.projects.map((p) => p.name),
      defaultProjectName: cfg.defaultProjectName,
    })
  },

  setSessions(sessions: SessionSummary[]): void {
    set({ sessions })
  },
  upsertSession(s: SessionSummary): void {
    const rest = state.sessions.filter((x) => x.id !== s.id)
    set({ sessions: [s, ...rest] })
  },
  deleteSession(id: string): void {
    set({ sessions: state.sessions.filter((s) => s.id !== id) })
    if (state.activeSessionId === id) {
      set({ activeSessionId: null, activeTranscript: [] })
    }
    // Remove from cache
    if (state.transcriptCache[id]) {
      const { [id]: _, ...rest } = state.transcriptCache
      set({ transcriptCache: rest })
    }
  },
  openSession(id: string, transcript: TranscriptEvent[]): void {
    // Cache the transcript for quick-switch.
    const cache = { ...state.transcriptCache, [id]: transcript }
    // Evict oldest if over limit.
    const keys = Object.keys(cache)
    if (keys.length > CACHE_MAX) {
      delete cache[keys[0]!]
    }
    set({
      activeSessionId: id,
      activeTranscript: transcript,
      mode: 'main',
      sessionScrollOffset: 0,
      transcriptCache: cache,
      lastActivityAt: Date.now(),
    })
  },
  closeSession(): void {
    set({
      activeSessionId: null,
      activeTranscript: [],
      mode: 'main',
    })
  },
  pushTranscriptEvent(sessionId: string, ev: TranscriptEvent): void {
    if (sessionId !== state.activeSessionId) return
    const last = state.activeTranscript[state.activeTranscript.length - 1]
    if (last && isSameEvent(last, ev)) return
    const newTranscript = [...state.activeTranscript, ev]
    // Auto-scroll: if user is at the bottom (offset 0), stay there.
    // If user manually scrolled up (offset > 0), preserve their position.
    const update: Partial<AppState> = {
      activeTranscript: newTranscript,
      lastActivityAt: Date.now(),
    }
    if (state.sessionScrollOffset === 0) {
      update.sessionScrollOffset = 0
    }
    set(update)
    // Update cache too.
    if (state.transcriptCache[sessionId]) {
      set({ transcriptCache: { ...state.transcriptCache, [sessionId]: newTranscript } })
    }
  },

  enterMode(mode: AppMode): void {
    const next: Partial<AppState> = {
      mode,
      navIndex: 0,
      error: null,
      lastActivityAt: Date.now(),
    }
    if (isRecordingMode(mode)) {
      next.recordStartedAt = Date.now()
    } else if (mode !== 'transcribing') {
      next.recordStartedAt = null
    }
    set(next)
  },
  setNavIndex(i: number): void {
    set({ navIndex: Math.max(0, i), lastActivityAt: Date.now() })
  },
  setSessionScrollOffset(n: number): void {
    // Clamp to [0, scrollable lines]. Exactly one source is populated at a time:
    //   - activeTranscript → managed (cc-g2) session
    //   - nativeTurns      → native ~/.claude mirror
    // The native mirror's `activeTranscript` is empty, so without the nativeTurns
    // term the offset was forced to 0 (scroll appeared dead — only the tail showed).
    // The mirror screen re-clamps to the exact wrapped-line count; this estimate
    // (~text/36 + thinking + tools + 1 per turn) is a generous upper bound.
    const nativeLines = state.nativeTurns.reduce(
      (s, t) =>
        s + Math.ceil((t.text?.length ?? 0) / 36) + (t.thinking ? 1 : 0) + t.toolUses.length + 1,
      0,
    )
    const maxOffset = Math.max(0, state.activeTranscript.length, nativeLines)
    set({ sessionScrollOffset: Math.max(0, Math.min(n, maxOffset)), lastActivityAt: Date.now() })
  },

  setPendingTranscript(text: string | null): void {
    set({ pendingTranscript: text })
  },

  setError(msg: string | null): void {
    set({ error: msg })
  },

  // Phase 2: Confirmation modal
  setConfirmAction(action: ConfirmAction | null): void {
    set({ confirmAction: action })
  },

  // Phase 3
  setConfirmTranscriptFlow(flow: 'new' | 'turn' | null): void {
    set({ confirmTranscriptFlow: flow })
  },
  setPendingQuestion(q: PendingQuestion | null): void {
    set({ pendingQuestion: q })
  },

  setScrollingTranscript(v: boolean): void {
    set({ scrollingTranscript: v })
  },

  setSidebarVisible(v: boolean): void {
    set({ sidebarVisible: v, lastActivityAt: Date.now() })
  },

  getCachedTranscript(sessionId: string): TranscriptEvent[] | null {
    return state.transcriptCache[sessionId] ?? null
  },

  // ── Native sessions bridge ────────────────────────────────────────────────
  setNativeLoading(v: boolean): void {
    set({ nativeLoading: v })
  },
  setNativeProjects(projects: NativeProjectSummary[]): void {
    set({ nativeProjects: projects, nativeLoading: false })
  },
  setNativeSessions(dir: string, project: string, sessions: NativeSessionSummary[]): void {
    set({
      nativeSelectedDir: dir,
      nativeSelectedProject: project,
      nativeSessions: sessions,
      nativeLoading: false,
    })
  },
  // Open a mirror: reset turns + cursor, mark which session/cwd we're watching.
  openNativeMirror(sid: string, cwd: string | null): void {
    set({
      nativeMirrorSid: sid,
      nativeMirrorCwd: cwd,
      nativeTurns: [],
      nativeMirrorStatus: null,
      sessionScrollOffset: 0,
      lastActivityAt: Date.now(),
    })
  },
  // Append/replace a turn from the mirror SSE. tailSession replays existing
  // turns then streams new ones; turns are keyed by uuid so replays of the
  // same turn (e.g. assistant text growing) overwrite rather than duplicate.
  pushNativeTurn(turn: NativeTurn): void {
    // When a REAL turn arrives over SSE, drop any optimistic echo we rendered
    // for it (same role + text) so the user's follow-up isn't shown twice.
    const base = turn.uuid.startsWith('optimistic-')
      ? state.nativeTurns
      : state.nativeTurns.filter(
          (t) =>
            !(t.uuid.startsWith('optimistic-') && t.role === turn.role && t.text.trim() === turn.text.trim()),
        )
    const idx = base.findIndex((t) => t.uuid === turn.uuid)
    let next: NativeTurn[]
    if (idx >= 0) {
      next = [...base]
      next[idx] = turn
    } else {
      next = [...base, turn]
    }
    set({ nativeTurns: next, lastActivityAt: Date.now() })
  },
  setNativeMirrorStatus(status: NativeMirrorStatus): void {
    set({ nativeMirrorStatus: status })
  },
  clearNativeMirror(): void {
    set({
      nativeMirrorSid: null,
      nativeMirrorCwd: null,
      nativeTurns: [],
      nativeMirrorStatus: null,
    })
  },
}

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
