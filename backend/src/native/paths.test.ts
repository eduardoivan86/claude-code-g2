// backend/src/native/paths.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectDirs, sessionFilesIn, findSessionFile } from "./paths";

test("listProjectDirs returns child dirs of the projects root", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(root, "-Users-me-app"));
  mkdirSync(join(root, "-Users-me-other"));
  writeFileSync(join(root, "not-a-dir.txt"), "x");
  const dirs = listProjectDirs(root).map((p) => p.split("/").pop()).sort();
  expect(dirs).toEqual(["-Users-me-app", "-Users-me-other"]);
});

test("sessionFilesIn returns only top-level .jsonl files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-"));
  writeFileSync(join(dir, "a.jsonl"), "");
  writeFileSync(join(dir, "b.jsonl"), "");
  writeFileSync(join(dir, "notes.md"), "");
  mkdirSync(join(dir, "subagents"));
  writeFileSync(join(dir, "subagents", "c.jsonl"), "");
  const files = sessionFilesIn(dir).map((p) => p.split("/").pop()).sort();
  expect(files).toEqual(["a.jsonl", "b.jsonl"]);
});

test("findSessionFile returns the full path of a matching session", () => {
  const root = mkdtempSync(join(tmpdir(), "find-"));
  const projDir = join(root, "-Users-me-app");
  mkdirSync(projDir);
  const sid = "11111111-2222-3333-4444-555555555555";
  const file = join(projDir, `${sid}.jsonl`);
  writeFileSync(file, "");
  expect(findSessionFile(sid, root)).toBe(file);
});

test("findSessionFile returns null for an unknown sid", () => {
  const root = mkdtempSync(join(tmpdir(), "find-"));
  mkdirSync(join(root, "-Users-me-app"));
  expect(findSessionFile("does-not-exist", root)).toBeNull();
});

test("findSessionFile rejects path-traversal in sid", () => {
  const root = mkdtempSync(join(tmpdir(), "find-"));
  mkdirSync(join(root, "-Users-me-app"));
  expect(findSessionFile("../escape", root)).toBeNull();
  expect(findSessionFile("a/b", root)).toBeNull();
  expect(findSessionFile("a\\b", root)).toBeNull();
});
