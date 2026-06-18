// backend/src/native/paths.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function listProjectDirs(root = claudeProjectsDir()): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  return entries
    .map((name) => join(root, name))
    .filter((p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    });
}

export function sessionFilesIn(dir: string): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }) as any; } catch { return []; }
  return (entries as any[])
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => join(dir, d.name));
}
