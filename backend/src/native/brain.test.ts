// backend/src/native/brain.test.ts
import { test, expect } from "bun:test";
import { cleanReplyText, parseBrainDecision } from "./brain";

// ── cleanReplyText: the user-facing reply must never contain `<function` ──────

test("cleanReplyText strips an unclosed leaked tool call from the tail", () => {
  const input =
    'Esa zona está restringida. <function=relay_to_claude{"message":"abrí el archivo"}>';
  const out = cleanReplyText(input);
  expect(out).toBe("Esa zona está restringida.");
  expect(out.includes("<function")).toBe(false);
});

test("cleanReplyText removes a fully-closed <function>…</function> block", () => {
  const input =
    'Listo. <function=relay_to_claude>{"message":"corré los tests"}</function> Gracias.';
  const out = cleanReplyText(input);
  expect(out.includes("<function")).toBe(false);
  // The block is removed in place; surrounding text (incl. its spacing) is kept,
  // only the ends are trimmed.
  expect(out).toBe("Listo.  Gracias.");
});

test("cleanReplyText leaves clean text untouched (just trimmed)", () => {
  expect(cleanReplyText("  Todo bien por acá.  ")).toBe("Todo bien por acá.");
});

test("cleanReplyText handles empty / undefined-ish input", () => {
  expect(cleanReplyText("")).toBe("");
});

// ── parseBrainDecision: strict JSON structured-output parsing ─────────────────

test("parseBrainDecision parses a plain answer object", () => {
  const d = parseBrainDecision('{"action":"answer","reply":"hola"}');
  expect(d.action).toBe("answer");
  expect(d.reply).toBe("hola");
  expect(d.message).toBe("");
});

test("parseBrainDecision parses a relay object with a message", () => {
  const d = parseBrainDecision(
    '{"action":"relay","reply":"ok","message":"add a test"}',
  );
  expect(d.action).toBe("relay");
  expect(d.reply).toBe("ok");
  expect(d.message).toBe("add a test");
});

test("parseBrainDecision strips ```json fences before parsing", () => {
  const d = parseBrainDecision(
    '```json\n{"action":"answer","reply":"con fence"}\n```',
  );
  expect(d.action).toBe("answer");
  expect(d.reply).toBe("con fence");
});

test("parseBrainDecision strips a bare ``` fence before parsing", () => {
  const d = parseBrainDecision('```\n{"action":"relay","message":"haz X","reply":"dale"}\n```');
  expect(d.action).toBe("relay");
  expect(d.message).toBe("haz X");
});

test("parseBrainDecision falls back to answer on invalid JSON (no relay)", () => {
  const d = parseBrainDecision("esto no es json");
  expect(d.action).toBe("answer");
  expect(d.reply).toBe("esto no es json");
  expect(d.message).toBe("");
});

test("parseBrainDecision falls back to answer when action is missing", () => {
  const d = parseBrainDecision('{"reply":"sin action"}');
  // No valid `action` → defensive answer using the cleaned raw text.
  expect(d.action).toBe("answer");
  expect(d.message).toBe("");
});

test("parseBrainDecision falls back to answer on an unknown action", () => {
  const d = parseBrainDecision('{"action":"explode","reply":"boom"}');
  expect(d.action).toBe("answer");
  expect(d.message).toBe("");
});

test("parseBrainDecision scrubs leaked <function> from the fallback reply", () => {
  const d = parseBrainDecision(
    'texto suelto <function=relay_to_claude{"message":"x"}>',
  );
  expect(d.action).toBe("answer");
  expect(d.reply).toBe("texto suelto");
  expect(d.reply.includes("<function")).toBe(false);
});

test("parseBrainDecision handles empty input as an empty answer", () => {
  const d = parseBrainDecision("");
  expect(d.action).toBe("answer");
  expect(d.reply).toBe("");
  expect(d.message).toBe("");
});
