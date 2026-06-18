// backend/src/native/nativeSessions.ts
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { basename } from "node:path";
import { parseLine } from "./transcript";
import { listProjectDirs, sessionFilesIn } from "./paths";
import type { SessionSummary, ProjectSummary } from "./types";

const MAX_SCAN_BYTES = 256 * 1024; // cwd + first human prompt always appear early

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
