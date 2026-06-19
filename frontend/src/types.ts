// Shared app types. Keep in lock-step with backend/src/sessions/store.ts.

export type TranscriptEvent =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant_text'; text: string; ts: number }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown; ts: number }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; ts: number }
  | { kind: 'result'; subtype: string; isError: boolean; ts: number }
  | { kind: 'error'; message: string; ts: number }
  | { kind: 'question'; toolUseId: string; questionText: string; options: string[]; ts: number }

export interface SessionSummary {
  id: string
  title: string
  projectName: string
  createdAt: number
  lastActiveAt: number
  busy?: boolean
}

export interface Session extends SessionSummary {
  cwd: string
  transcript: TranscriptEvent[]
}

export interface ProjectInfo {
  name: string
}

// ── Native sessions bridge (reads ~/.claude/projects/*.jsonl) ──────────────
// These mirror backend/src/native/types.ts. Kept separate from the
// TranscriptEvent stream above — native turns are pre-assembled by the backend.

export interface NativeTurn {
  uuid: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  toolUses: { name: string; summary: string }[]
  isToolResult: boolean
  timestamp: string
  // Present on an assistant turn carrying an AskUserQuestion tool_use. The
  // glasses show the option picker and relay the chosen label as a follow-up.
  askQuestion?: {
    toolUseId: string
    questions: {
      question: string
      header?: string
      multiSelect?: boolean
      options: { label: string; description?: string }[]
    }[]
  }
}

// One persisted brain-conversation exchange half. The backend writes a sidecar
// JSONL (~/.cc-g2/brain-log/<sid>.jsonl) so ephemeral brain replies survive and
// can be merged into the mirror timeline. ts is epoch ms (unlike NativeTurn's
// ISO `timestamp`).
export interface BrainLogEntry {
  ts: number
  role: 'brain-user' | 'brain'
  text: string
  relayed?: boolean
}

export interface NativeSessionSummary {
  sessionId: string
  filePath: string
  cwd: string
  project: string
  title: string
  updatedAt: number
}

export interface NativeProjectSummary {
  dirPath: string
  cwd: string
  project: string
  sessionCount: number
  updatedAt: number
}

export interface BackendConfig {
  projects: ProjectInfo[]
  defaultProjectName: string
}

export type GlobalEvent =
  | { kind: 'session_created'; sessionId: string; title: string; projectName: string; ts: number }
  | { kind: 'session_updated'; sessionId: string; title: string; lastActiveAt: number; busy?: boolean; ts: number }
  | { kind: 'session_deleted'; sessionId: string; ts: number }

export type SseEvent =
  | { kind: 'transcript'; sessionId: string; event: TranscriptEvent }
  | { kind: 'global'; event: GlobalEvent }

export type AppMode =
  | 'unconfigured'
  | 'main'
  | 'recording-new'
  | 'transcribing'
  | 'picking-project'
  | 'recording-turn'
  | 'confirming-transcript'  // Phase 3: voice feedback confirmation
  | 'answering'              // Phase 3: AskUserQuestion answer picker
  | 'native-projects'        // Native bridge: browse ~/.claude/projects
  | 'native-sessions'        // Native bridge: sessions within a project
  | 'native-mirror'          // Native bridge: live mirror of one session

export type ConnectionStatus = 'unknown' | 'ok' | 'error'
