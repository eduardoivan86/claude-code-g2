// backend/src/native/tailer.ts
import { openSync, readSync, closeSync, statSync, watch } from "node:fs";
import { parseLine } from "./transcript";
import type { Turn } from "./types";

export function tailSession(filePath: string, onTurn: (t: Turn) => void): () => void {
  let pos = 0;
  let buffer = "";
  let stopped = false;

  const drain = () => {
    if (stopped) return;
    let size: number;
    try { size = statSync(filePath).size; } catch { return; }
    if (size < pos) { pos = 0; buffer = ""; }      // file truncated/rotated
    if (size === pos) return;
    const fd = openSync(filePath, "r");
    try {
      const len = size - pos;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      pos += n;
      buffer += buf.toString("utf8", 0, n);
    } finally { closeSync(fd); }

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) { const t = parseLine(line); if (t) onTurn(t); }
    }
  };

  drain(); // existing content first
  const watcher = watch(filePath, { persistent: false }, () => drain());
  // safety poll in case fs.watch misses events on some FS
  const poll = setInterval(drain, 250);

  return () => {
    stopped = true;
    watcher.close();
    clearInterval(poll);
  };
}
