// backend/src/routes/native.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { makeNativeRouter, type NativeConfig } from "./native.ts";

// A minimal but realistic native session .jsonl: a metadata line carrying cwd,
// then one human prompt that becomes the title.
const SID = "11111111-2222-3333-4444-555555555555";
const FAKE_CWD = "/Users/me/app";

function writeFakeSession(projectDir: string): void {
  const lines = [
    JSON.stringify({ type: "summary", cwd: FAKE_CWD, sessionId: SID }),
    JSON.stringify({
      type: "user",
      sessionId: SID,
      message: { role: "user", content: [{ type: "text", text: "hello there" }] },
    }),
  ];
  writeFileSync(join(projectDir, `${SID}.jsonl`), lines.join("\n") + "\n");
}

const fakeCfg: NativeConfig = {
  claudeBinary: "claude",
  model: "sonnet",
  permissionMode: "bypassPermissions",
};

let tmpRoot: string;
let server: Server;
let port: number;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "native-routes-"));
  const projectDir = join(tmpRoot, "-Users-me-app");
  mkdirSync(projectDir);
  writeFakeSession(projectDir);

  const app = express();
  app.use(express.json());
  app.use(
    "/native",
    makeNativeRouter({ getConfig: () => fakeCfg, projectsRoot: tmpRoot }),
  );
  server = app.listen(0);
  port = (server.address() as any).port;
});

afterAll(() => {
  server.close();
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

test("GET /native/projects lists the fake project", async () => {
  const res = await fetch(url("/native/projects"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any[];
  expect(body.length).toBe(1);
  expect(body[0].project).toBe("app");
  expect(body[0].sessionCount).toBe(1);
});

test("GET /native/projects/:dir/sessions returns the session", async () => {
  const res = await fetch(url("/native/projects/-Users-me-app/sessions"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any[];
  expect(body.length).toBe(1);
  expect(body[0].sessionId).toBe(SID);
  expect(body[0].title).toBe("hello there");
});

test("GET /native/projects/:dir/sessions rejects traversal", async () => {
  const res = await fetch(url("/native/projects/" + encodeURIComponent("../escape") + "/sessions"));
  expect(res.status).toBe(400);
});

test("GET /native/sessions/<unknown>/stream returns 404", async () => {
  const res = await fetch(url("/native/sessions/does-not-exist/stream"));
  expect(res.status).toBe(404);
  const body = (await res.json()) as any;
  expect(body.error).toBe("not_found");
});

test("POST /native/sessions/<unknown>/message returns 404", async () => {
  const res = await fetch(url("/native/sessions/does-not-exist/message"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  expect(res.status).toBe(404);
});

test("POST /native/sessions/:sid/message rejects empty prompt with 400", async () => {
  const res = await fetch(url(`/native/sessions/${SID}/message`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "  " }),
  });
  expect(res.status).toBe(400);
});

test("POST /native/sessions rejects missing cwd/prompt with 400", async () => {
  const res = await fetch(url("/native/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  expect(res.status).toBe(400);
});
