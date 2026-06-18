// backend/src/native/transcript.test.ts
import { test, expect } from "bun:test";
import { parseLine } from "./transcript";

const base = { sessionId: "S1", uuid: "U1", timestamp: "2026-06-18T00:00:00Z" };

test("parses a human user prompt", () => {
  const line = JSON.stringify({ ...base, type: "user",
    message: { role: "user", content: [{ type: "text", text: "fix the bug" }] } });
  const t = parseLine(line)!;
  expect(t.role).toBe("user");
  expect(t.text).toBe("fix the bug");
  expect(t.isToolResult).toBe(false);
});

test("flags a tool_result user line", () => {
  const line = JSON.stringify({ ...base, type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
  const t = parseLine(line)!;
  expect(t.isToolResult).toBe(true);
  expect(t.text).toBe("");
});

test("parses assistant text + thinking + tool_use", () => {
  const line = JSON.stringify({ ...base, type: "assistant",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "let me look" },
      { type: "text", text: "Here is the fix" },
      { type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } },
    ] } });
  const t = parseLine(line)!;
  expect(t.role).toBe("assistant");
  expect(t.text).toBe("Here is the fix");
  expect(t.thinking).toBe("let me look");
  expect(t.toolUses).toEqual([{ name: "Edit", summary: "/a/b.ts" }]);
});

test("ignores bookkeeping types", () => {
  for (const type of ["queue-operation", "attachment", "system", "last-prompt", "summary"]) {
    expect(parseLine(JSON.stringify({ ...base, type }))).toBeNull();
  }
});

test("returns null on malformed json", () => {
  expect(parseLine("{not json")).toBeNull();
});
