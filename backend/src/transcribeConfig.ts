// Pluggable, OpenAI-compatible speech-to-text provider resolution.
//
// Transcription hits an OpenAI-compatible `/audio/transcriptions` endpoint
// chosen by env. The default provider is Groq (`whisper-large-v3-turbo`),
// which is fast and cheap; OpenAI Whisper and a local Whisper server are also
// supported. The official `openai` SDK talks to all three via `baseURL`.
//
// This module is PURE and unit-testable: it derives everything from the passed
// `env` map (default `process.env`), so the resolver has no I/O side effects.

export type TranscribeProvider = 'groq' | 'openai' | 'local'

export interface TranscribeConfig {
  provider: TranscribeProvider
  baseURL: string
  apiKey: string
  model: string
}

type Env = Record<string, string | undefined>

/**
 * Resolve the active transcription provider from environment variables.
 *
 * Provider is chosen by `TRANSCRIBE_PROVIDER` (default `groq`). Each provider
 * has its own base-URL / api-key / model env vars with sane defaults:
 *
 * - groq   → GROQ_BASE_URL || https://api.groq.com/openai/v1, GROQ_API_KEY,
 *            GROQ_STT_MODEL || whisper-large-v3-turbo
 * - openai → OPENAI_BASE_URL || https://api.openai.com/v1, OPENAI_API_KEY,
 *            OPENAI_STT_MODEL || whisper-1
 * - local  → WHISPER_BASE_URL || http://127.0.0.1:8080/v1, WHISPER_API_KEY,
 *            WHISPER_MODEL || whisper-1
 *
 * An unknown `TRANSCRIBE_PROVIDER` value falls back to `groq`.
 */
export function transcribeConfigFromEnv(env: Env = process.env): TranscribeConfig {
  const raw = (env.TRANSCRIBE_PROVIDER ?? 'groq').trim().toLowerCase()
  const provider: TranscribeProvider =
    raw === 'openai' || raw === 'local' ? raw : 'groq'

  switch (provider) {
    case 'openai':
      return {
        provider,
        baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: env.OPENAI_API_KEY || '',
        model: env.OPENAI_STT_MODEL || 'whisper-1',
      }
    case 'local':
      return {
        provider,
        baseURL: env.WHISPER_BASE_URL || 'http://127.0.0.1:8080/v1',
        apiKey: env.WHISPER_API_KEY || '',
        model: env.WHISPER_MODEL || 'whisper-1',
      }
    case 'groq':
    default:
      return {
        provider: 'groq',
        baseURL: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY || '',
        model: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
      }
  }
}
