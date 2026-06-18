// backend/src/native/tailer.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailSession } from "./tailer";
import type { Turn } from "./types";

const userLine = (text: string) =>
  JSON.stringify({ type: "user", sessionId: "S", uuid: text, cwd: "/x",
    message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

test("emits existing turns then new ones, then stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const file = join(dir, "S.jsonl");
  writeFileSync(file, userLine("first"));
  const got: Turn[] = [];
  const stop = tailSession(file, (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 50));
  appendFileSync(file, userLine("second"));
  await new Promise((r) => setTimeout(r, 150));
  stop();
  appendFileSync(file, userLine("third")); // after stop -> ignored
  await new Promise((r) => setTimeout(r, 100));
  expect(got.map((t) => t.text)).toEqual(["first", "second"]);
});

test("buffers a partial line until newline arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const file = join(dir, "S.jsonl");
  writeFileSync(file, "");
  const got: Turn[] = [];
  const stop = tailSession(file, (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 30));
  const line = userLine("whole");
  appendFileSync(file, line.slice(0, 20));       // partial, no newline
  await new Promise((r) => setTimeout(r, 80));
  appendFileSync(file, line.slice(20));          // completes the line
  await new Promise((r) => setTimeout(r, 120));
  stop();
  expect(got.map((t) => t.text)).toEqual(["whole"]);
});
