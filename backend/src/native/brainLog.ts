// backend/src/native/brainLog.ts
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'

// -----------------------------------------------------------------------------
// Brain conversation SIDECAR log.
//
// The conversational "brain" (see brain.ts) replies to the user from session
// context, but those exchanges are EPHEMERAL — they never land in Claude's real
// transcript. The user wants them MERGED into the session mirror on the glasses
// (and surviving for later reading).
//
// We deliberately DO NOT write into Claude Code's real
// ~/.claude/projects/*.jsonl transcripts (corrupting them would break the CLI).
// Instead each session gets its own append-only sidecar JSONL under
// ~/.cc-g2/brain-log/<sid>.jsonl. The mirror MERGES this with the live session
// turns by timestamp so brain exchanges appear inline in the timeline.
//
// File layout mirrors config.ts / native.ts handoff: the config dir is
// ~/.cc-g2 (mode 0700); the log dir + files are 0600 like the token-bearing
// config (they contain the user's spoken conversation).
// -----------------------------------------------------------------------------

export interface BrainLogEntry {
  ts: number // epoch ms
  role: 'brain-user' | 'brain'
  text: string
  relayed?: boolean
}

// Mirror config.ts: the config dir lives at ~/.cc-g2; the brain log is a
// subdirectory beside config.json / handoff.json. The optional `baseDir`
// override exists ONLY so tests can point at a throwaway dir (Bun's
// os.homedir() ignores $HOME, so env-based redirection isn't reliable). In
// production callers never pass it → the real ~/.cc-g2/brain-log is used.
function brainLogDir(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.cc-g2', 'brain-log')
}

// Reject session ids that could escape the log dir (same guard family the
// native router uses for findSessionFile). Empty ids are also rejected.
function isUnsafeSid(sid: string): boolean {
  return (
    !sid ||
    sid.includes('/') ||
    sid.includes('\\') ||
    sid.includes('..')
  )
}

function logPath(sid: string, baseDir?: string): string {
  return join(brainLogDir(baseDir), `${sid}.jsonl`)
}

// Append brain-conversation entries for a session. Creates the log dir on first
// use (mode 0700 for the dir, 0600 for the file). A bad/unsafe sid is a no-op
// (defensive — callers should pass a validated sid). Each entry is one JSON line.
// `baseDir` is a test-only override (see brainLogDir).
export function appendBrainLog(
  sid: string,
  entries: BrainLogEntry[],
  baseDir?: string,
): void {
  if (isUnsafeSid(sid)) return
  if (!entries.length) return
  const dir = brainLogDir(baseDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  appendFileSync(logPath(sid, baseDir), body, { mode: 0o600 })
}

// Read all brain-conversation entries for a session, oldest first. Returns []
// for an unsafe sid, a missing file, or any read error. Malformed lines are
// skipped individually so one corrupt line doesn't lose the whole log.
// `baseDir` is a test-only override (see brainLogDir).
export function readBrainLog(sid: string, baseDir?: string): BrainLogEntry[] {
  if (isUnsafeSid(sid)) return []
  const p = logPath(sid, baseDir)
  if (!existsSync(p)) return []
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    return []
  }
  const out: BrainLogEntry[] = []
  for (const lineRaw of raw.split('\n')) {
    const lineStr = lineRaw.trim()
    if (!lineStr) continue
    try {
      const obj = JSON.parse(lineStr) as Partial<BrainLogEntry>
      if (
        typeof obj?.ts === 'number' &&
        (obj.role === 'brain-user' || obj.role === 'brain') &&
        typeof obj.text === 'string'
      ) {
        const entry: BrainLogEntry = { ts: obj.ts, role: obj.role, text: obj.text }
        if (typeof obj.relayed === 'boolean') entry.relayed = obj.relayed
        out.push(entry)
      }
    } catch {
      // Skip a malformed line; keep the rest of the log.
    }
  }
  return out
}
