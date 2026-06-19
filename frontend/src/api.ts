import type {
  BackendConfig,
  NativeProjectSummary,
  NativeSessionSummary,
  Session,
  SessionSummary,
  SseEvent,
} from './types'
import { store } from './store'

export class NotConfiguredError extends Error {
  constructor() {
    super('Backend URL and token are not configured yet')
    this.name = 'NotConfiguredError'
  }
}

function getCreds(): { url: string; token: string } {
  const { backendUrl, token } = store.getState()
  if (!backendUrl || !token) throw new NotConfiguredError()
  return { url: backendUrl, token }
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, token } = getCreds()
  const headers = new Headers(init.headers ?? {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type') && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(url + path, { ...init, headers })
}

export interface HealthResult {
  ok: boolean
  reason?: string
  failedUrl?: string
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== 'Error' ? `${err.name}: ` : ''
    return `${name}${err.message || String(err)}`
  }
  return String(err)
}

export async function checkHealth(backendUrl: string, token: string): Promise<HealthResult> {
  const base = backendUrl.replace(/\/$/, '')
  // 1) Reachability check: /api/health is unauthed, so no CORS preflight.
  const healthUrl = base + '/api/health'
  try {
    const res = await fetch(healthUrl, { method: 'GET' })
    if (!res.ok) return { ok: false, reason: `health HTTP ${res.status}`, failedUrl: healthUrl }
  } catch (err) {
    return { ok: false, reason: `can't reach backend: ${describeError(err)}`, failedUrl: healthUrl }
  }
  // 2) Auth check: /api/config needs the bearer token. This triggers a CORS
  //    preflight; if the token is wrong we'll see 401, if CORS is broken
  //    we'll see a network error.
  const cfgUrl = base + '/api/config'
  try {
    const res = await fetch(cfgUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return { ok: false, reason: 'wrong bearer token (401)', failedUrl: cfgUrl }
    if (!res.ok) return { ok: false, reason: `config HTTP ${res.status}`, failedUrl: cfgUrl }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `auth request blocked: ${describeError(err)}`, failedUrl: cfgUrl }
  }
}

export async function getConfig(): Promise<BackendConfig> {
  const res = await authFetch('/api/config')
  if (!res.ok) throw new Error(`getConfig: ${res.status}`)
  return res.json()
}

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default'

export interface Settings {
  permissionMode: PermissionMode
  model: string
  defaultProjectName: string
  projects: { name: string }[]
}

export async function getSettings(): Promise<Settings> {
  const res = await authFetch('/api/settings')
  if (!res.ok) throw new Error(`getSettings: ${res.status}`)
  return res.json()
}

export async function saveSettings(update: Partial<Settings>): Promise<Settings> {
  const res = await authFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify(update),
  })
  if (!res.ok) throw new Error(`saveSettings: ${res.status}`)
  return res.json()
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await authFetch('/api/sessions')
  if (!res.ok) throw new Error(`listSessions: ${res.status}`)
  const body = await res.json() as { sessions: SessionSummary[] }
  return body.sessions
}

export async function getSession(id: string): Promise<Session> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`getSession: ${res.status}`)
  const body = await res.json() as { session: Session }
  return body.session
}

export async function createSession(
  projectName: string,
  firstPrompt: string,
): Promise<SessionSummary> {
  const res = await authFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ projectName, firstPrompt }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`createSession: ${res.status} ${err}`)
  }
  const body = await res.json() as { session: SessionSummary }
  return body.session
}

export async function sendTurn(sessionId: string, text: string): Promise<void> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`sendTurn: ${res.status}`)
}

export async function deleteSession(id: string): Promise<void> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`deleteSession: ${res.status}`)
}

export async function transcribeAudio(pcm: Uint8Array): Promise<string> {
  const res = await authFetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/pcm' },
    body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
  })
  if (!res.ok) throw new Error(`transcribe: ${res.status}`)
  const body = await res.json() as { text: string }
  return body.text
}

// ── Native sessions bridge ───────────────────────────────────────────────
// Reads the user's own ~/.claude/projects/*.jsonl transcripts via the backend
// /api/native/* routes. Reuses authFetch (header bearer) for plain HTTP; the
// mirror stream uses EventSource with ?token= (see nativeMirrorUrl below).

export async function listNativeProjects(): Promise<NativeProjectSummary[]> {
  const res = await authFetch('/api/native/projects')
  if (!res.ok) throw new Error(`listNativeProjects: ${res.status}`)
  return res.json() as Promise<NativeProjectSummary[]>
}

export async function listNativeSessions(dir: string): Promise<NativeSessionSummary[]> {
  const res = await authFetch(`/api/native/projects/${encodeURIComponent(dir)}/sessions`)
  if (!res.ok) throw new Error(`listNativeSessions: ${res.status}`)
  return res.json() as Promise<NativeSessionSummary[]>
}

// Start a brand-new native session in `cwd`. Returns the server-chosen sid.
// The .jsonl appears a moment later, so the mirror stream may 404 briefly —
// callers should retry opening the mirror.
export async function newNativeSession(cwd: string, prompt: string): Promise<string> {
  const res = await authFetch('/api/native/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd, prompt }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`newNativeSession: ${res.status} ${err}`)
  }
  const body = await res.json() as { sessionId: string }
  return body.sessionId
}

// Append a turn to an existing native session (resume). The backend never
// rejects on a busy session anymore: it either delivers immediately (200,
// queued:false) or queues the message for backend-driven delivery once the
// session frees up (202, queued:true). Either way the reply (and the echoed
// user turn) arrive via the mirror SSE. Throws only on a real error.
export async function sendNativeMessage(
  sid: string,
  prompt: string,
): Promise<{ queued: boolean }> {
  const res = await authFetch(`/api/native/sessions/${encodeURIComponent(sid)}/message`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error(`sendNativeMessage: ${res.status}`)
  // 202 → queued for later delivery; 200 → delivered immediately. Read the flag
  // from the body, falling back to the status code if the JSON is unexpected.
  const body = (await res.json().catch(() => null)) as { queued?: boolean } | null
  const queued = body?.queued ?? res.status === 202
  return { queued }
}

// ── Conversational "brain" ───────────────────────────────────────────────
// Route a transcribed voice turn through the fast Groq brain. The backend
// decides whether to answer the user directly from session context (returns a
// spoken `reply`, `relayed:false`) or relay a well-formulated dev request to the
// real Claude Code session via the idle→deliver / busy→queue path
// (`relayed:true`). Claude's own response still streams in over the mirror SSE.
export async function brainMessage(
  sid: string,
  text: string,
): Promise<{ reply: string; relayed: boolean }> {
  const res = await authFetch('/api/native/brain', {
    method: 'POST',
    body: JSON.stringify({ sessionId: sid, text }),
  })
  if (!res.ok) throw new Error(`brainMessage: ${res.status}`)
  const body = (await res.json()) as { reply?: string; relayed?: boolean }
  return { reply: body.reply ?? '', relayed: body.relayed ?? false }
}

// ── Active-session handoff ───────────────────────────────────────────────
// The backend persists the "session you're actively working on" (set by the
// glasses opening a session or the Mac `g2 handoff` command; cleared when the
// user backs out of the mirror). On init the glasses GET it and auto-resume.

export interface HandoffInfo {
  sessionId: string | null
  cwd?: string
  project?: string
  title?: string
}

// Read the pinned active session. Returns `{ sessionId: null }` when none is
// set or the pinned id no longer resolves to a real transcript.
export async function getHandoff(): Promise<HandoffInfo> {
  const res = await authFetch('/api/native/handoff')
  if (!res.ok) throw new Error(`getHandoff: ${res.status}`)
  return res.json() as Promise<HandoffInfo>
}

// Pin (or, with null, clear) the active session server-side. Fire-and-forget
// at call sites — failures shouldn't block navigation.
export async function setHandoff(sessionId: string | null): Promise<void> {
  const res = await authFetch('/api/native/handoff', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
  if (!res.ok) throw new Error(`setHandoff: ${res.status}`)
}

// Build the mirror SSE URL with the bearer token as a query param
// (EventSource can't set headers). Returns null if not configured.
export function nativeMirrorUrl(sid: string): string | null {
  const { backendUrl, token } = store.getState()
  if (!backendUrl || !token) return null
  const qs = new URLSearchParams({ token })
  return `${backendUrl}/api/native/sessions/${encodeURIComponent(sid)}/stream?${qs.toString()}`
}

// Server-Sent Events — single reconnecting connection per channel.

export type SseHandler = (ev: SseEvent) => void

export class SseClient {
  private es: EventSource | null = null
  private closed = false
  constructor(
    private channelSessionId: string, // '*' for global or a real session id
    private onEvent: SseHandler,
  ) {
    this.open()
  }

  private open(): void {
    if (this.closed) return
    try {
      const { url, token } = getCreds()
      const qs = new URLSearchParams({
        sessionId: this.channelSessionId,
        token,
      })
      const es = new EventSource(`${url}/api/events?${qs.toString()}`)
      this.es = es
      es.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data) as SseEvent
          this.onEvent(parsed)
        } catch (err) {
          console.warn('[sse] parse error', err)
        }
      }
      es.onerror = () => {
        // Let the browser auto-reconnect via the `retry:` hint from the server.
        // If the connection is permanently gone, we'll retry on a delay.
        if (this.closed) return
        console.warn('[sse] connection lost, will retry')
      }
    } catch (err) {
      console.warn('[sse] cannot open (not configured):', err)
    }
  }

  close(): void {
    this.closed = true
    this.es?.close()
    this.es = null
  }
}

export async function bootstrap(): Promise<void> {
  const { backendUrl, token } = store.getState()
  if (!backendUrl || !token) return
  try {
    const [cfg, sessions] = await Promise.all([getConfig(), listSessions()])
    store.setBackendConfig(cfg)
    store.setSessions(sessions)
    store.setConnection('ok')
  } catch (err) {
    console.error('[bootstrap] failed:', err)
    store.setConnection('error', (err as Error).message)
  }
}
