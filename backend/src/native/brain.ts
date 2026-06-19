// backend/src/native/brain.ts
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
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
// Runs server-side: the Groq key never leaves the backend.
// -----------------------------------------------------------------------------

// System prompt tuned for the glasses HUD (small screen, ~10 lines). Verbatim.
const SYSTEM_PROMPT = `Sos "el cerebro", una interfaz de voz para Claude Code en gafas AR (pantalla chica, ~10 líneas). Tenés el contexto de la sesión de desarrollo del usuario.
Reglas:
- Respondé SIEMPRE en el idioma del usuario, MUY corto (1-2 frases, sin markdown, sin listas).
- Si el usuario pide una acción de desarrollo (escribir/editar código, correr algo, investigar el repo, etc.), usá la tool relay_to_claude con el mensaje bien formulado para Claude Code, y confirmá en 1 frase qué le pediste.
- Si el usuario pregunta algo que podés responder con el contexto de la sesión (qué hizo Claude, en qué está, un resumen), respondé vos directo, SIN usar la tool.
- Si es ambiguo, preferí UNA pregunta corta antes de mandar a Claude.
- Nunca leas en voz alta IDs internos de sesión.`;

// Per-turn text cap, and how many recent turns to feed as context.
const MAX_TURN_CHARS = 400;
const MAX_CONTEXT_TURNS = 20;

const RELAY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "relay_to_claude",
    description:
      "Send a well-formulated development request to the Claude Code agent that is working in this project. Use for any coding/file/run/research task.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The well-formulated request to send to Claude Code, in the user's language.",
        },
      },
      required: ["message"],
    },
  },
};

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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// -----------------------------------------------------------------------------
// Tool-call artifact hardening.
//
// The Groq llama-3.3-70b model sometimes leaks a native-format tool call into
// the TEXT content instead of (or in addition to) returning a proper OpenAI
// `tool_calls` entry, e.g. the reply ends with:
//   ...restringida. <function=relay_to_claude{"message":"…"}>
// or a fully closed block:
//   <function=relay_to_claude>{"message":"…"}</function>
// The user-facing `reply` must NEVER contain a `<function` artifact, and a relay
// intent expressed this way must not be silently dropped.
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

// Best-effort: extract the relay `message` from a leaked native-format tool call
// embedded in the raw text. Handles both:
//   <function=relay_to_claude{"message":"…"}>
//   <function=relay_to_claude>{"message":"…"}</function>
// Tries to JSON-parse the first `{…}` after the tag for a `message` field; if
// that fails, falls back to the plain text after the tag up to `>`/`</function>`.
// Returns null when no `relay_to_claude` artifact is present.
export function extractLeakedRelayMessage(text: string): string | null {
  if (!text) return null;
  const tag = "<function=relay_to_claude";
  const tagIdx = text.indexOf(tag);
  if (tagIdx < 0) return null;
  const after = text.slice(tagIdx + tag.length);

  // Try to find a balanced {…} object after the tag and JSON-parse it.
  const braceStart = after.indexOf("{");
  if (braceStart >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < after.length; i++) {
      const ch = after[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) {
      const objText = after.slice(braceStart, end + 1);
      try {
        const parsed = JSON.parse(objText) as { message?: unknown };
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          return parsed.message.trim();
        }
      } catch {
        // Fall through to the plain-text fallback below.
      }
    }
  }

  // Fallback: take the text after the tag up to the first `>` or `</function>`.
  let rest = after;
  const closeFn = rest.indexOf("</function>");
  if (closeFn >= 0) rest = rest.slice(0, closeFn);
  const gt = rest.indexOf(">");
  if (gt >= 0) rest = rest.slice(0, gt);
  const cleaned = rest.replace(/^[>\s{]+/, "").trim();
  return cleaned || null;
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
      tools: [RELAY_TOOL],
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 300,
    });
  } catch (err) {
    // Surface a clear error so the route can return 502.
    throw new Error(
      `groq brain call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const choice = completion.choices[0];
  const msg = choice?.message;
  const rawContent = msg?.content ?? "";
  // The user-facing reply must NEVER contain a `<function` artifact.
  const content = cleanReplyText(rawContent);
  const toolCall = msg?.tool_calls?.find(
    (c) => c.type === "function" && c.function?.name === "relay_to_claude",
  );

  // PRIMARY path: a proper OpenAI tool_calls entry.
  if (toolCall && toolCall.type === "function") {
    let relayMessage = "";
    try {
      const args = JSON.parse(toolCall.function.arguments || "{}") as {
        message?: unknown;
      };
      if (typeof args.message === "string") relayMessage = args.message.trim();
    } catch {
      // Malformed tool args — fall back to the user's own text so we still relay
      // something coherent rather than dropping the request.
      relayMessage = opts.userText.trim();
    }
    if (!relayMessage) relayMessage = opts.userText.trim();

    relayToSession(opts.sessionId, opts.cwd, relayMessage, opts.getConfig());

    return {
      reply: content || "Listo, se lo pasé a Claude.",
      relayed: true,
      relayedMessage: relayMessage,
    };
  }

  // FALLBACK path: no proper tool_call, but the model leaked a native-format
  // `<function=relay_to_claude …>` into the text. Best-effort extract the
  // message and relay it via the SAME idle→deliver / busy→queue path so the
  // user's relay intent isn't lost just because the model mis-formatted it.
  const leaked = extractLeakedRelayMessage(rawContent);
  if (leaked) {
    relayToSession(opts.sessionId, opts.cwd, leaked, opts.getConfig());
    return {
      reply: content || "Listo, se lo pasé a Claude.",
      relayed: true,
      relayedMessage: leaked,
    };
  }

  return { reply: content, relayed: false };
}
