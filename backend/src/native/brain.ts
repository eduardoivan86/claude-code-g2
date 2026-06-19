// backend/src/native/brain.ts
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Turn } from "./types";
import { findSessionFile } from "./paths";
import { isSessionIdle } from "./idleGuard";
import { deliverToSession, type DeliverConfig } from "./deliver";
import { enqueue } from "./queue";

// -----------------------------------------------------------------------------
// The conversational "brain".
//
// A fast LLM on Groq sits between the user's transcribed voice and the real
// Claude Code session. Given the user's spoken text + the session's recent
// context, it either:
//   (a) ANSWERS the user directly from context (e.g. "¿qué hizo Claude?"), or
//   (b) RELAYS a well-formulated dev request to Claude Code via the SAME
//       resume/queue path the message route uses (so busy→queue still works).
//
// Decision + payload are produced via STRICT JSON structured output (Groq JSON
// mode) instead of OpenAI tool-calling. The llama-3.3-70b model is unreliable
// with tool-calling on Groq — it leaks `<function=relay_to_claude…>` into the
// text even for plain context questions, which caused false relays that woke
// Claude unnecessarily. JSON mode is deterministic and avoids that failure mode.
//
// Runs server-side: the Groq key never leaves the backend.
// -----------------------------------------------------------------------------

// System prompt tuned for the glasses HUD (small screen) + Spanish.
// NOTE: Groq JSON mode requires the literal word "JSON" somewhere in the
// prompt — it is present below. Verbatim.
const SYSTEM_PROMPT = `Sos "el cerebro", una interfaz de voz para Claude Code en gafas AR. Tenés el contexto de la sesión de desarrollo del usuario.
Respondé SIEMPRE con UN ÚNICO objeto JSON válido, sin texto fuera del JSON, con esta forma:
{"action":"answer"|"relay","reply":"<lo que le decís al usuario, en SU idioma, 1-2 frases cortas, sin markdown>","message":"<solo si action=relay: el pedido de desarrollo bien formulado para Claude Code>"}
Reglas:
- action="relay" SOLO para acciones de desarrollo (escribir/editar código, correr algo, investigar el repo). En "message" poné el pedido claro para Claude; en "reply" confirmá en 1 frase qué le pediste.
- action="answer" para preguntas que podés responder con el contexto de la sesión (qué hizo, en qué está, un resumen). NO uses relay para esto.
- Si es ambiguo, action="answer" y pedí UNA aclaración corta.
- Nunca incluyas IDs internos de sesión.`;

// Per-turn text cap, and how many recent turns to feed as context.
const MAX_TURN_CHARS = 400;
const MAX_CONTEXT_TURNS = 20;

// Structural slice of the runtime config the relay path needs. Matches the
// route's NativeConfig / DeliverConfig so callers pass the same getConfig().
type BrainConfig = DeliverConfig;

export interface RunBrainOpts {
  sessionId: string;
  cwd: string;
  userText: string;
  recent: Turn[];
  getConfig: () => BrainConfig;
}

export interface RunBrainResult {
  reply: string;
  relayed: boolean;
  relayedMessage?: string;
}

// The strict shape the brain emits as JSON. All fields optional at parse time
// since the model is the source of truth and we defend against malformed output.
export interface BrainDecision {
  action: "answer" | "relay";
  reply: string;
  message: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// -----------------------------------------------------------------------------
// Reply text hardening.
//
// With JSON mode the model should never emit a native tool-call artifact, but
// keep a small defensive scrub on the FINAL user-facing reply just in case the
// model echoes a stray `<function…>` token inside the JSON `reply` string.
// -----------------------------------------------------------------------------

// Pure function: strip any leaked `<function=…>` tool-call artifact from the
// user-facing reply text. Removes fully-closed `<function=…>…</function>` blocks,
// then truncates from the first remaining `<function=` onward (covers the common
// unclosed/streaming-cutoff case), and trims. Exported for unit testing.
export function cleanReplyText(text: string): string {
  if (!text) return "";
  // 1) Drop any complete <function=…>…</function> blocks anywhere in the text.
  let out = text.replace(/<function=[\s\S]*?<\/function>/gi, "");
  // 2) Truncate from the first surviving `<function=` (unclosed leak) onward.
  const idx = out.indexOf("<function=");
  if (idx >= 0) out = out.slice(0, idx);
  return out.trim();
}

// -----------------------------------------------------------------------------
// JSON parsing.
//
// Strip ```json fences if the model wrapped the object, then JSON.parse. If the
// parse fails or `action` is missing, treat the whole thing as an "answer" whose
// reply is the cleaned raw text — defensive so we never accidentally relay.
// Exported for unit testing.
// -----------------------------------------------------------------------------
export function parseBrainDecision(raw: string): BrainDecision {
  const text = (raw ?? "").trim();

  // Strip a ```json … ``` or ``` … ``` fence if present.
  let body = text;
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1] !== undefined) body = fence[1].trim();

  try {
    const parsed = JSON.parse(body) as Partial<BrainDecision> & {
      action?: unknown;
    };
    if (parsed && (parsed.action === "answer" || parsed.action === "relay")) {
      const reply =
        typeof parsed.reply === "string" ? parsed.reply : "";
      const message =
        typeof parsed.message === "string" ? parsed.message : "";
      return { action: parsed.action, reply, message };
    }
  } catch {
    // Fall through to the defensive answer below.
  }

  // Parse failed or `action` missing/invalid → defensively answer with the
  // cleaned raw text so we never relay on malformed output.
  return { action: "answer", reply: cleanReplyText(text), message: "" };
}

// Relay a message to the session using the SAME logic as the message route:
// deliver immediately if idle, otherwise enqueue for the backend drain loop.
function relayToSession(
  sessionId: string,
  cwd: string,
  message: string,
  cfg: BrainConfig,
): void {
  const file = findSessionFile(sessionId);
  if (file && isSessionIdle(file)) {
    deliverToSession(sessionId, cwd, message, cfg);
  } else {
    enqueue(sessionId, { cwd, prompt: message }, { getConfig: () => cfg });
  }
}

export async function runBrain(opts: RunBrainOpts): Promise<RunBrainResult> {
  const env = process.env;
  const client = new OpenAI({
    apiKey: env.GROQ_API_KEY || "none",
    baseURL: env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });
  const model = env.GROQ_BRAIN_MODEL || "llama-3.3-70b-versatile";

  // SYSTEM + last ~20 recent turns (each truncated) + the final user text.
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const t of opts.recent.slice(-MAX_CONTEXT_TURNS)) {
    messages.push({
      role: t.role,
      content: truncate(t.text, MAX_TURN_CHARS),
    });
  }
  messages.push({ role: "user", content: opts.userText });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 400,
    });
  } catch (err) {
    // Surface a clear error so the route can return 502.
    throw new Error(
      `groq brain call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawContent = completion.choices[0]?.message?.content ?? "";
  const decision = parseBrainDecision(rawContent);

  // Defensive scrub on the FINAL user-facing reply.
  const reply = cleanReplyText(decision.reply);
  const message = decision.message.trim();

  if (decision.action === "relay" && message) {
    relayToSession(opts.sessionId, opts.cwd, message, opts.getConfig());
    return {
      reply: reply || "Listo, se lo pasé a Claude.",
      relayed: true,
      relayedMessage: message,
    };
  }

  return { reply, relayed: false };
}
