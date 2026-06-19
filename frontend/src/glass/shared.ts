import type {
  AppMode,
  ConnectionStatus,
  NativeProjectSummary,
  NativeSessionSummary,
  NativeTurn,
  SessionSummary,
  TranscriptEvent,
} from '../types'
import type { NativeMirrorStatus } from '../store'

export interface ConfirmAction {
  kind: 'delete'
  sessionId: string
  title: string
  expiresAt: number
}

export interface PendingQuestion {
  toolUseId: string
  text: string
  options: string[]
}

export interface SidebarItem {
  kind: 'session' | 'new' | 'native'
  id?: string
  label: string
  isActive?: boolean
  busy?: boolean
}

export interface AppSnapshot {
  mode: AppMode
  sessions: SessionSummary[]
  activeSessionId: string | null
  transcript: TranscriptEvent[]
  activeBusy: boolean

  recordStartedAt: number | null
  pendingTranscript: string | null

  projects: string[]

  sessionScrollOffset: number
  error: string | null

  connection: ConnectionStatus

  confirmAction: ConfirmAction | null
  lastActivityAt: number
  confirmTranscriptFlow: 'new' | 'turn' | null
  pendingQuestion: PendingQuestion | null

  scrollingTranscript: boolean

  // Sidebar overlay: true = show session list, false = full-screen transcript
  sidebarVisible: boolean

  // ── Native sessions bridge ──────────────────────────────────────────────
  nativeProjects: NativeProjectSummary[]
  nativeSessions: NativeSessionSummary[]
  nativeSelectedProject: string | null
  nativeMirrorSid: string | null
  nativeTurns: NativeTurn[]
  nativeMirrorStatus: NativeMirrorStatus
  nativeLoading: boolean
  nativeAttention: boolean
  // Pending voice follow-ups pinned on the HUD (queued = waiting for Claude,
  // !queued = sent, awaiting SSE confirm).
  nativePending: { text: string; queued: boolean }[]
}

export interface AppActions {
  startNewRecording(): void
  cancelRecording(): void
  stopNewRecordingAndTranscribe(): void
  pickProject(projectName: string): void
  openSessionById(id: string): void
  deleteSessionById(id: string): void
  closeSession(): void
  startTurnRecording(): void
  stopTurnRecordingAndSend(): void
  scrollTranscript(delta: number): void
  showSidebar(): void
  hideSidebar(): void

  requestDeleteConfirmation(sessionId: string, title: string): void
  confirmPendingAction(): void
  cancelPendingAction(): void

  confirmTranscript(): void
  cancelTranscript(): void

  answerQuestion(answer: string): void

  // ── Native sessions bridge ──────────────────────────────────────────────
  openNativeProjects(): void                         // enter the native projects browser
  pickNativeProject(dirPath: string, project: string): void // → sessions list
  openNativeSession(sid: string, cwd: string): void  // → mirror an existing session
  startNativeNewSession(): void                       // [+] voice → new native session
  scrollNativeMirror(delta: number): void
  recordNativeFollowUp(): void                        // tap in mirror → voice follow-up
  clearNativeAttention(): void                        // dismiss the "Claude needs you" banner
  exitNative(): void                                  // back out to the main glasses UI
  nativeBack(): void                                  // mirror → sessions → projects → main

  // ── Pending voice follow-ups (busy-session queue) ───────────────────────
  addNativePending(text: string): void               // pin a message as queued
  markNativePendingSent(text: string): void          // queued → sent (awaiting SSE)
  removeNativePending(text: string): void            // SSE echoed the real turn → drop
  clearNativePending(): void
}
