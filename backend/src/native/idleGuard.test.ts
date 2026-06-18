// backend/src/native/idleGuard.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionIdle } from "./idleGuard";

test("busy when modified within quiet window", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ig-")), "S.jsonl");
  writeFileSync(f, "x");
  expect(isSessionIdle(f, { quietMs: 4000, now: Date.now() })).toBe(false);
});

test("idle when last modified long ago", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ig-")), "S.jsonl");
  writeFileSync(f, "x");
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(f, old, old);
  expect(isSessionIdle(f, { quietMs: 4000, now: Date.now() })).toBe(true);
});

test("missing file counts as idle (nothing to collide with)", () => {
  expect(isSessionIdle("/no/such/file.jsonl")).toBe(true);
});
