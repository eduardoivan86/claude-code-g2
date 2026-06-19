// Pluggable, env-driven text-to-speech provider resolution.
//
// Spoken HUD replies (the brain's voice + the "Claude terminó" attention speak)
// default to the browser's robotic `speechSynthesis`. When a cloud key is
// configured, the backend instead synthesizes natural mp3 audio via ElevenLabs
// (default, multilingual incl. Spanish) or OpenAI. Keys stay server-side.
//
// This module is PURE and unit-testable: it derives everything from the passed
// `env` map (default `process.env`), so the resolver has no I/O side effects.

import type { VoiceSettings } from '../config.ts'

export type TtsProvider = 'browser' | 'elevenlabs' | 'openai'

export interface TtsConfig {
  provider: TtsProvider
  /** ElevenLabs / OpenAI API key. Empty for `browser`. */
  apiKey: string
  /** ElevenLabs voice id. */
  voiceId: string
  /** ElevenLabs model id. */
  modelId: string
  /** OpenAI TTS model (e.g. `tts-1`). */
  model: string
  /** OpenAI voice (e.g. `nova`). */
  voice: string
}

type Env = Record<string, string | undefined>

/**
 * Resolve the active TTS provider from environment variables.
 *
 * Provider is chosen by `TTS_PROVIDER` (default `browser`). If a cloud provider
 * is selected but its API key is empty, we gracefully fall back to `browser`
 * (so a half-configured env doesn't break speech — it just stays robotic):
 *
 * - browser    → no cloud synthesis; the frontend uses speechSynthesis.
 * - elevenlabs → ELEVENLABS_API_KEY,
 *                ELEVENLABS_VOICE_ID || 21m00Tcm4TlvDq8ikWAM (Rachel),
 *                ELEVENLABS_MODEL    || eleven_flash_v2_5
 * - openai     → OPENAI_API_KEY,
 *                OPENAI_TTS_MODEL || tts-1,
 *                OPENAI_TTS_VOICE || nova
 *
 * An unknown `TTS_PROVIDER` value falls back to `browser`.
 *
 * The optional `voice` param holds the persisted app settings (from
 * config.json). When present, its fields take precedence over the matching env
 * vars, so the user can configure TTS entirely from the app. Env stays as the
 * fallback. The graceful "no key → browser" behavior is preserved regardless of
 * source.
 */
export function ttsConfigFromEnv(env: Env = process.env, voice?: VoiceSettings): TtsConfig {
  const rawSource = voice?.ttsProvider ?? env.TTS_PROVIDER ?? 'browser'
  const raw = rawSource.trim().toLowerCase()

  // Defaults shared across the union so the shape is always complete. Voice
  // settings win over env; env wins over the hard-coded default.
  const voiceId = voice?.elevenlabsVoiceId || env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'
  const modelId = env.ELEVENLABS_MODEL || 'eleven_flash_v2_5'
  const model = env.OPENAI_TTS_MODEL || 'tts-1'
  const voiceName = voice?.openaiVoice || env.OPENAI_TTS_VOICE || 'nova'

  if (raw === 'elevenlabs') {
    const apiKey = voice?.elevenlabsApiKey || env.ELEVENLABS_API_KEY || ''
    // No key → graceful fallback to the free browser voice.
    if (!apiKey) {
      return { provider: 'browser', apiKey: '', voiceId, modelId, model, voice: voiceName }
    }
    return { provider: 'elevenlabs', apiKey, voiceId, modelId, model, voice: voiceName }
  }

  if (raw === 'openai') {
    const apiKey = voice?.openaiApiKey || env.OPENAI_API_KEY || ''
    if (!apiKey) {
      return { provider: 'browser', apiKey: '', voiceId, modelId, model, voice: voiceName }
    }
    return { provider: 'openai', apiKey, voiceId, modelId, model, voice: voiceName }
  }

  return { provider: 'browser', apiKey: '', voiceId, modelId, model, voice: voiceName }
}
