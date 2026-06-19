import { useSyncExternalStore } from 'react'
import type {
  AppMode,
  BackendConfig,
  BrainLogEntry,
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
  // When the pending question came from a NATIVE mirror session, this holds that
  // session id so answerQuestion relays the picked option to it via the direct
  // native message endpoint (not the managed sendTurn). null = managed question.
  nativePendingQuestionSid: string | null

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
  // "Claude needs you": set when a native turn completes (result event) and
  // Claude is now waiting on the user. Drives a prominent HUD banner; cleared
  // when the user taps to answer or re-opens the mirror.
  nativeAttention: boolean
  // 3-tap HUD hide: when true the glasses render a near-blank/dim screen while
  // the app + SSE stay alive. Cleared by a manual double-tap (GO_BACK) or
  // auto-unhidden on the next nativeAttention false→true edge.
  hudHidden: boolean
  // Pending voice follow-ups awaiting delivery to Claude. `queued:true` = got a
  // 409 (session busy), retrying until Claude frees up; `queued:false` = accepted
  // (200), waiting for the mirror SSE to echo the real user turn. Either way the
  // text stays pinned on the HUD (dim) so the user never loses their message.
  nativePending: { text: string; queued: boolean }[]

  // Whether spoken TTS output is enabled (the brain's "voice"). Persisted to
  // localStorage so it survives reloads / background WebView restarts.
  voiceEnabled: boolean
  // Mirror scroll direction. false (default): swipe DOWN = older history.
  // true: swipe UP = older. Persisted to localStorage.
  scrollInverted: boolean
  // The brain's spoken reply to the latest voice turn, pinned on the HUD near
  // the top (🧠 …). '…' is a thinking placeholder; null = nothing to show.
  // Cleared on the next user action (new recording) or on a timer.
  nativeBrainReply: string | null
  // Persisted brain-conversation exchanges for the open session (oldest first).
  // Loaded from the backend sidecar on mirror open and appended optimistically
  // after each exchange; merged with nativeTurns by timestamp in the mirror.
  nativeBrainLog: BrainLogEntry[]
}

// ── voiceEnabled persistence (localStorage) ──────────────────────────────────
const LS_VOICE = 'cc-g2:voiceEnabled'

function readVoiceEnabled(): boolean {
  try {
    return localStorage.getItem(LS_VOICE) === '1'
  } catch {
    return false
  }
}

function persistVoiceEnabled(v: boolean): void {
  try {
    localStorage.setItem(LS_VOICE, v ? '1' : '0')
  } catch {
    /* sandboxed / unavailable — in-memory only */
  }
}

// ── scrollInverted persistence (localStorage) ────────────────────────────────
const LS_SCROLL_INVERTED = 'cc-g2:scrollInverted'

function readScrollInverted(): boolean {
  try {
    return localStorage.getItem(LS_SCROLL_INVERTED) === '1'
  } catch {
    return false
  }
}

function persistScrollInverted(v: boolean): void {
  try {
    localStorage.setItem(LS_SCROLL_INVERTED, v ? '1' : '0')
  } catch {
    /* sandboxed / unavailable — in-memory only */
  }
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
  nativePendingQuestionSid: null,
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
  nativeAttention: false,
  hudHidden: false,
  nativePending: [],

  voiceEnabled: readVoiceEnabled(),
  scrollInverted: readScrollInverted(),
  nativeBrainReply: null,
  nativeBrainLog: [],
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
    // Merged brain-log lines also occupy the transcript window, so include a
    // generous estimate (~text/36 + 1 per entry) or the offset would clamp short
    // and merged brain exchanges past the turn estimate wouldn't scroll into view.
    const brainLogLines = state.nativeBrainLog.reduce(
      (s, e) => s + Math.ceil((e.text?.length ?? 0) / 36) + 1,
      0,
    )
    const maxOffset = Math.max(
      0,
      state.activeTranscript.length,
      nativeLines + brainLogLines,
    )
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
  setNativePendingQuestionSid(sid: string | null): void {
    set({ nativePendingQuestionSid: sid })
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
      nativeAttention: false,
      nativePending: [],
      nativeBrainReply: null,
      nativeBrainLog: [],
      sessionScrollOffset: 0,
      lastActivityAt: Date.now(),
    })
  },
  // Toggle the "Claude needs you" banner. Set true when an attention frame
  // arrives over the mirror SSE; cleared when the user taps to answer.
  setNativeAttention(v: boolean): void {
    set({ nativeAttention: v })
  },
  // ── 3-tap HUD hide ─────────────────────────────────────────────────────────
  // Render a near-blank/dim screen while keeping the app + SSE alive.
  setHudHidden(v: boolean): void {
    set({ hudHidden: v })
  },
  toggleHudHidden(): void {
    set({ hudHidden: !state.hudHidden })
  },
  // Append/replace a turn from the mirror SSE. tailSession replays existing
  // turns then streams new ones; turns are keyed by uuid so replays of the
  // same turn (e.g. assistant text growing) overwrite rather than duplicate.
  pushNativeTurn(turn: NativeTurn): void {
    const idx = state.nativeTurns.findIndex((t) => t.uuid === turn.uuid)
    let next: NativeTurn[]
    if (idx >= 0) {
      next = [...state.nativeTurns]
      next[idx] = turn
    } else {
      next = [...state.nativeTurns, turn]
    }
    set({ nativeTurns: next, lastActivityAt: Date.now() })
  },
  // ── Pending voice follow-ups (busy-session queue) ─────────────────────────
  // Push a new pending entry as queued (waiting for Claude to free up). Dedupes
  // an exact-duplicate consecutive text (e.g. a double-tap re-send).
  addNativePending(text: string): void {
    const t = text.trim()
    if (!t) return
    const last = state.nativePending[state.nativePending.length - 1]
    if (last && last.text.trim() === t) return
    set({
      nativePending: [...state.nativePending, { text, queued: true }],
      lastActivityAt: Date.now(),
    })
  },
  // Mark the matching entry as accepted (200) — now awaiting the SSE echo.
  markNativePendingSent(text: string): void {
    const t = text.trim()
    let changed = false
    const next = state.nativePending.map((e) => {
      if (!changed && e.queued && e.text.trim() === t) {
        changed = true
        return { ...e, queued: false }
      }
      return e
    })
    if (changed) set({ nativePending: next })
  },
  // Drop the entry whose text matches (the real turn landed over SSE).
  removeNativePending(text: string): void {
    const t = text.trim()
    const idx = state.nativePending.findIndex((e) => e.text.trim() === t)
    if (idx < 0) return
    const next = [...state.nativePending]
    next.splice(idx, 1)
    set({ nativePending: next })
  },
  clearNativePending(): void {
    if (state.nativePending.length === 0) return
    set({ nativePending: [] })
  },
  setNativeMirrorStatus(status: NativeMirrorStatus): void {
    set({ nativeMirrorStatus: status })
  },
  // ── Brain voice / reply ───────────────────────────────────────────────────
  // Toggle spoken TTS output. Persists to localStorage so it survives reloads.
  setVoiceEnabled(v: boolean): void {
    persistVoiceEnabled(v)
    set({ voiceEnabled: v })
  },
  // Toggle mirror scroll direction. Persists to localStorage.
  setScrollInverted(v: boolean): void {
    persistScrollInverted(v)
    set({ scrollInverted: v })
  },
  // Pin / clear the brain's spoken reply on the HUD (🧠 …).
  setNativeBrainReply(v: string | null): void {
    set({ nativeBrainReply: v, lastActivityAt: Date.now() })
  },
  // ── Brain conversation sidecar log ────────────────────────────────────────
  // Replace the whole brain log (loaded from the backend on mirror open).
  setNativeBrainLog(entries: BrainLogEntry[]): void {
    set({ nativeBrainLog: entries })
  },
  // Optimistically append exchange entries right after a brain reply resolves so
  // they show inline in the timeline immediately (the server also persisted
  // them). Skips an exact ts+role+text duplicate so a later reload/merge can't
  // double-render the same entry.
  appendNativeBrainLog(entries: BrainLogEntry[]): void {
    if (entries.length === 0) return
    const existing = state.nativeBrainLog
    const fresh = entries.filter(
      (e) =>
        !existing.some(
          (x) => x.ts === e.ts && x.role === e.role && x.text === e.text,
        ),
    )
    if (fresh.length === 0) return
    set({ nativeBrainLog: [...existing, ...fresh], lastActivityAt: Date.now() })
  },
  clearNativeMirror(): void {
    set({
      nativeMirrorSid: null,
      nativeMirrorCwd: null,
      nativeTurns: [],
      nativeMirrorStatus: null,
      nativePending: [],
      nativeBrainLog: [],
      pendingQuestion: null,
      nativePendingQuestionSid: null,
    })
  },
}

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
