// backend/src/native/transcript.ts
import type { Turn } from "./types";

interface Block { type: string; text?: string; thinking?: string; name?: string; input?: any; id?: string; }

function summarizeToolUse(b: Block): string {
  const i = b.input ?? {};
  return i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? b.name ?? "";
}

// Defensively parse an AskUserQuestion tool_use input into the shape the glasses
// consume. The real shape is { questions: [{ question, header?, multiSelect?,
// options: [{ label, description? }] }] }. Everything is checked because native
// transcripts are user-authored and may be malformed. Returns null if nothing
// usable is found.
function parseAskQuestion(b: Block): NonNullable<Turn["askQuestion"]> | null {
  const input = b.input;
  if (!input || typeof input !== "object") return null;
  const rawQuestions = (input as any).questions;
  if (!Array.isArray(rawQuestions)) return null;

  const questions = rawQuestions
    .map((rq: any) => {
      if (!rq || typeof rq !== "object") return null;
      const question = typeof rq.question === "string" ? rq.question : "";
      const rawOptions = Array.isArray(rq.options) ? rq.options : [];
      const options = rawOptions
        .map((o: any) => {
          if (o && typeof o === "object" && typeof o.label === "string") {
            return typeof o.description === "string"
              ? { label: o.label, description: o.description }
              : { label: o.label };
          }
          if (typeof o === "string") return { label: o };
          return null;
        })
        .filter((o: any): o is { label: string; description?: string } => o !== null);
      if (!question && options.length === 0) return null;
      return {
        question,
        ...(typeof rq.header === "string" ? { header: rq.header } : {}),
        ...(typeof rq.multiSelect === "boolean" ? { multiSelect: rq.multiSelect } : {}),
        options,
      };
    })
    .filter((q: any): q is NonNullable<Turn["askQuestion"]>["questions"][number] => q !== null);

  if (questions.length === 0) return null;
  return { toolUseId: b.id ?? "", questions };
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
  let askQuestion: Turn["askQuestion"];

  for (const b of content) {
    if (b.type === "text" && b.text) texts.push(b.text);
    else if (b.type === "thinking" && b.thinking) thinks.push(b.thinking);
    else if (b.type === "tool_use") {
      toolUses.push({ name: b.name ?? "tool", summary: summarizeToolUse(b) });
      // Surface AskUserQuestion so the glasses can show the option picker.
      // Keep only the first AskUserQuestion if a turn somehow has several.
      if (b.name === "AskUserQuestion" && !askQuestion) {
        const parsed = parseAskQuestion(b);
        if (parsed) askQuestion = parsed;
      }
    } else if (b.type === "tool_result") isToolResult = true;
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
    ...(askQuestion ? { askQuestion } : {}),
  };
}
