// backend/src/native/nativeSessions.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionMeta, listSessions, listProjects } from "./nativeSessions";

function sessionFile(dir: string, sid: string, cwd: string, firstPrompt: string) {
  const lines = [
    JSON.stringify({ type: "attachment", sessionId: sid, cwd, timestamp: "2026-06-18T00:00:00Z" }),
    JSON.stringify({ type: "user", sessionId: sid, uuid: "u1", cwd, timestamp: "2026-06-18T00:00:01Z",
      message: { role: "user", content: [{ type: "text", text: firstPrompt }] } }),
  ].join("\n") + "\n";
  writeFileSync(join(dir, `${sid}.jsonl`), lines);
}

test("readSessionMeta recovers cwd, project, title from content", () => {
  const dir = mkdtempSync(join(tmpdir(), "p-"));
  sessionFile(dir, "S1", "/Users/me/EvenRealities Projects", "build the bridge please");
  const meta = readSessionMeta(join(dir, "S1.jsonl"))!;
  expect(meta.sessionId).toBe("S1");
  expect(meta.cwd).toBe("/Users/me/EvenRealities Projects");
  expect(meta.project).toBe("EvenRealities Projects");
  expect(meta.title).toBe("build the bridge please");
});

test("title skips tool_result user lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "p-"));
  const sid = "S2", cwd = "/Users/me/app";
  const lines = [
    JSON.stringify({ type: "user", sessionId: sid, uuid: "u0", cwd,
      message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", sessionId: sid, uuid: "u1", cwd,
      message: { role: "user", content: [{ type: "text", text: "the real prompt" }] } }),
  ].join("\n") + "\n";
  writeFileSync(join(dir, `${sid}.jsonl`), lines);
  expect(readSessionMeta(join(dir, `${sid}.jsonl`))!.title).toBe("the real prompt");
});

test("listSessions sorts by updatedAt desc", () => {
  const dir = mkdtempSync(join(tmpdir(), "p-"));
  sessionFile(dir, "old", "/Users/me/app", "old one");
  sessionFile(dir, "new", "/Users/me/app", "new one");
  // touch "new" to be most recent
  writeFileSync(join(dir, "new.jsonl"),
    JSON.stringify({ type: "user", sessionId: "new", uuid: "u", cwd: "/Users/me/app",
      message: { role: "user", content: [{ type: "text", text: "new one" }] } }) + "\n");
  const ids = listSessions(dir).map((s) => s.sessionId);
  expect(ids[0]).toBe("new");
});

test("listProjects aggregates a root of project dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  const d1 = join(root, "-Users-me-app"); mkdirSync(d1);
  sessionFile(d1, "S1", "/Users/me/app", "hi");
  const projects = listProjects(root);
  expect(projects.length).toBe(1);
  expect(projects[0].project).toBe("app");
  expect(projects[0].sessionCount).toBe(1);
});
