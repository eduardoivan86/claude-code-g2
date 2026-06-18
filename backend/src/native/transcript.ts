// backend/src/native/transcript.ts
import type { Turn } from "./types";

interface Block { type: string; text?: string; thinking?: string; name?: string; input?: any; }

function summarizeToolUse(b: Block): string {
  const i = b.input ?? {};
  return i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? b.name ?? "";
}

export function parseLine(line: string): Turn | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  if (o?.type !== "user" && o?.type !== "assistant") return null;
  const msg = o.message;
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;

  const content: Block[] = Array.isArray(msg.content)
    ? msg.content
    : typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : [];

  const texts: string[] = [];
  const thinks: string[] = [];
  const toolUses: { name: string; summary: string }[] = [];
  let isToolResult = false;

  for (const b of content) {
    if (b.type === "text" && b.text) texts.push(b.text);
    else if (b.type === "thinking" && b.thinking) thinks.push(b.thinking);
    else if (b.type === "tool_use") toolUses.push({ name: b.name ?? "tool", summary: summarizeToolUse(b) });
    else if (b.type === "tool_result") isToolResult = true;
  }

  return {
    uuid: o.uuid ?? "",
    sessionId: o.sessionId ?? "",
    role: msg.role,
    text: texts.join("\n").trim(),
    thinking: thinks.length ? thinks.join("\n").trim() : undefined,
    toolUses,
    isToolResult,
    timestamp: o.timestamp ?? "",
  };
}
