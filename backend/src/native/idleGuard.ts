// backend/src/native/idleGuard.ts
import { statSync } from "node:fs";

export function isSessionIdle(filePath: string, opts?: { quietMs?: number; now?: number }): boolean {
  const quietMs = opts?.quietMs ?? 4000;
  const now = opts?.now ?? Date.now();
  try {
    const { mtimeMs } = statSync(filePath);
    return now - mtimeMs >= quietMs;
  } catch {
    return true;
  }
}
