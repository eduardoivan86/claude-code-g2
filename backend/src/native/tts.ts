// backend/src/native/tts.ts
//
// Cloud text-to-speech synthesis. Turns a string of spoken HUD text into mp3
// audio via the provider resolved by ttsConfigFromEnv. Returns `null` for the
// `browser` provider — the signal for the frontend to use speechSynthesis.

import OpenAI from 'openai'
import type { TtsConfig } from './ttsConfig.ts'

/**
 * Synthesize `text` to an mp3 Buffer using the configured cloud provider.
 *
 * Returns `null` when `cfg.provider === 'browser'` (no cloud key configured) —
 * the route turns that into `{ browser: true }` so the frontend falls back to
 * the free speechSynthesis voice. Throws on a provider error (non-ok HTTP /
 * SDK failure) so the route can answer 502 and the frontend can still fall back.
 *
 * `fetchImpl` is injectable for testing the ElevenLabs path.
 */
export async function synthesize(
  text: string,
  cfg: TtsConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
  if (cfg.provider === 'browser') return null

  if (cfg.provider === 'elevenlabs') {
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}` +
      `?output_format=mp3_44100_128`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: cfg.modelId }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`elevenlabs tts failed: ${res.status} ${detail.slice(0, 200)}`)
    }
    const arr = await res.arrayBuffer()
    return Buffer.from(arr)
  }

  // openai
  const client = new OpenAI({ apiKey: cfg.apiKey })
  const res = await client.audio.speech.create({
    model: cfg.model,
    voice: cfg.voice as never,
    input: text,
  })
  return Buffer.from(await res.arrayBuffer())
}
