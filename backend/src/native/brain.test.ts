// backend/src/native/brain.test.ts
import { test, expect } from "bun:test";
import { cleanReplyText, extractLeakedRelayMessage } from "./brain";

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

// ── extractLeakedRelayMessage: best-effort recover a leaked relay intent ──────

test("extractLeakedRelayMessage parses JSON message from inline form", () => {
  const input =
    'ok <function=relay_to_claude{"message":"editá el README"}>';
  expect(extractLeakedRelayMessage(input)).toBe("editá el README");
});

test("extractLeakedRelayMessage parses JSON message from closed-block form", () => {
  const input =
    '<function=relay_to_claude>{"message":"corré bun test"}</function>';
  expect(extractLeakedRelayMessage(input)).toBe("corré bun test");
});

test("extractLeakedRelayMessage falls back to plain text after the tag", () => {
  const input = "<function=relay_to_claude arreglá el bug del login>";
  expect(extractLeakedRelayMessage(input)).toBe("arreglá el bug del login");
});

test("extractLeakedRelayMessage returns null when no relay artifact present", () => {
  expect(extractLeakedRelayMessage("Todo en orden, nada que hacer.")).toBeNull();
  expect(extractLeakedRelayMessage("")).toBeNull();
});
