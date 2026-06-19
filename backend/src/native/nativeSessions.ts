// backend/src/native/nativeSessions.ts
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { basename } from "node:path";
import { parseLine } from "./transcript";
import { listProjectDirs, sessionFilesIn } from "./paths";
import type { SessionSummary, ProjectSummary, Turn } from "./types";

const MAX_SCAN_BYTES = 256 * 1024; // cwd + first human prompt always appear early
const MAX_TAIL_BYTES = 200 * 1024; // last ~200KB holds plenty of recent turns

function readHead(filePath: string): string[] {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(MAX_SCAN_BYTES);
    const n = readSync(fd, buf, 0, MAX_SCAN_BYTES, 0);
    return buf.toString("utf8", 0, n).split("\n").filter(Boolean);
  } finally { closeSync(fd); }
}

export function readSessionMeta(filePath: string): SessionSummary | null {
  let cwd = "";
  let title = "";
  let sessionId = basename(filePath, ".jsonl");
  let lines: string[];
  try { lines = readHead(filePath); } catch { return null; }

  for (const line of lines) {
    if (!cwd) {
      try { const o = JSON.parse(line); if (o?.cwd) cwd = o.cwd; if (o?.sessionId) sessionId = o.sessionId; } catch {}
    }
    if (!title) {
      const t = parseLine(line);
      if (t && t.role === "user" && !t.isToolResult && t.text) title = t.text;
    }
    if (cwd && title) break;
  }
  if (!cwd) return null;

  const updatedAt = statSync(filePath).mtimeMs;
  return {
    sessionId, filePath, cwd,
    project: basename(cwd) || cwd,
    title: title.length > 80 ? title.slice(0, 77) + "…" : (title || "(sin título)"),
    updatedAt,
  };
}

export function listSessions(projectDir: string): SessionSummary[] {
  return sessionFilesIn(projectDir)
    .map(readSessionMeta)
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Read the most recent human/assistant turns from a session transcript, for
// feeding the conversational "brain" recent context. Reads only the TAIL of the
// .jsonl (last ~200KB) so it stays cheap on long sessions. Keeps user/assistant
// turns that are NOT machine tool_results and have non-empty text, and returns
// the last `n` in chronological (oldest→newest) order.
export function readRecentTurns(filePath: string, n = 30): Turn[] {
  let fd: number;
  try { fd = openSync(filePath, "r"); } catch { return []; }
  let raw: string;
  try {
    const size = statSync(filePath).size;
    const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, start);
    raw = buf.toString("utf8", 0, got);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }

  // If we started mid-file the first line is likely a partial record; drop it.
  const lines = raw.split("\n").filter(Boolean);
  if (raw.length === MAX_TAIL_BYTES && lines.length) lines.shift();

  const turns: Turn[] = [];
  for (const line of lines) {
    const t = parseLine(line);
    if (!t) continue;
    if (t.isToolResult) continue;
    if (!t.text) continue;
    turns.push(t);
  }
  return turns.slice(-n);
}

export function listProjects(root?: string): ProjectSummary[] {
  const dirs = root ? listProjectDirs(root) : listProjectDirs();
  const out: ProjectSummary[] = [];
  for (const dir of dirs) {
    const sessions = listSessions(dir);
    if (!sessions.length) continue;
    out.push({
      dirPath: dir,
      cwd: sessions[0].cwd,
      project: sessions[0].project,
      sessionCount: sessions.length,
      updatedAt: sessions[0].updatedAt,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
