// backend/src/native/readRecentTurns.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecentTurns } from "./nativeSessions";

const cwd = "/Users/me/app";

function userLine(sid: string, uuid: string, text: string): string {
  return JSON.stringify({
    type: "user", sessionId: sid, uuid, cwd, timestamp: "2026-06-18T00:00:00Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}
function assistantLine(sid: string, uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant", sessionId: sid, uuid, cwd, timestamp: "2026-06-18T00:00:01Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}
function toolResultLine(sid: string, uuid: string): string {
  return JSON.stringify({
    type: "user", sessionId: sid, uuid, cwd, timestamp: "2026-06-18T00:00:02Z",
    message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
  });
}

function writeSession(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rrt-"));
  const file = join(dir, "S1.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("returns user/assistant turns in chronological order", () => {
  const file = writeSession([
    userLine("S1", "u1", "hola, arrancá"),
    assistantLine("S1", "a1", "dale, ya veo el repo"),
    userLine("S1", "u2", "¿en qué estás?"),
    assistantLine("S1", "a2", "armando el endpoint"),
  ]);
  const turns = readRecentTurns(file, 30);
  expect(turns.map((t) => t.text)).toEqual([
    "hola, arrancá",
    "dale, ya veo el repo",
    "¿en qué estás?",
    "armando el endpoint",
  ]);
});

test("skips tool_result lines and empty-text turns", () => {
  const file = writeSession([
    userLine("S1", "u1", "primer prompt"),
    toolResultLine("S1", "u2"),
    assistantLine("S1", "a1", "respuesta"),
  ]);
  const turns = readRecentTurns(file, 30);
  expect(turns.length).toBe(2);
  expect(turns.every((t) => !t.isToolResult)).toBe(true);
  expect(turns.map((t) => t.text)).toEqual(["primer prompt", "respuesta"]);
});

test("caps to the last n turns", () => {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) lines.push(userLine("S1", `u${i}`, `turn ${i}`));
  const file = writeSession(lines);
  const turns = readRecentTurns(file, 3);
  expect(turns.map((t) => t.text)).toEqual(["turn 7", "turn 8", "turn 9"]);
});

test("returns empty array for a missing file", () => {
  expect(readRecentTurns("/nope/does-not-exist.jsonl")).toEqual([]);
});
