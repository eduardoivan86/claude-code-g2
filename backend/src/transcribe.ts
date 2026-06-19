import type { Request, Response } from 'express'
import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import { transcribeConfigFromEnv } from './transcribeConfig.ts'

// POST /api/transcribe. Accepts `audio/wav` or `audio/pcm` (raw 16 kHz s16le
// mono — the glasses format). Raw PCM gets a 44-byte RIFF header prepended
// so Whisper accepts it without an ffmpeg hop.

const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

let clientSingleton: OpenAI | null = null
let modelSingleton: string | null = null
let languageSingleton: string | undefined
function client(): OpenAI {
  if (clientSingleton) return clientSingleton
  const cfg = transcribeConfigFromEnv()
  // The openai SDK throws on an empty apiKey, even against a custom baseURL
  // (e.g. a local Whisper server that ignores auth). Pass a dummy non-empty
  // key in that case so the client still constructs.
  clientSingleton = new OpenAI({ apiKey: cfg.apiKey || 'none', baseURL: cfg.baseURL })
  modelSingleton = cfg.model
  languageSingleton = cfg.language
  return clientSingleton
}

export function pcmToWav(
  pcm: Buffer,
  sampleRate = SAMPLE_RATE,
  channels = CHANNELS,
  bitsPerSample = BITS_PER_SAMPLE,
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const dataSize = pcm.length
  const chunkSize = 36 + dataSize

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(chunkSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // subchunk1 size
  header.writeUInt16LE(1, 20)  // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

export async function transcribeHandler(req: Request, res: Response): Promise<void> {
  const body = req.body
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: 'empty audio body' })
    return
  }

  const contentType = (req.header('content-type') ?? '').toLowerCase().split(';')[0]!.trim()
  let wavBuffer: Buffer
  if (contentType === 'audio/wav' || contentType === 'audio/wave' || contentType === 'audio/x-wav') {
    wavBuffer = body
  } else if (contentType === 'audio/pcm' || contentType === 'application/octet-stream' || contentType === '') {
    // Glasses mic audio is raw PCM. Wrap in a WAV header.
    wavBuffer = pcmToWav(body)
  } else {
    res.status(400).json({ error: `unsupported content-type: ${contentType}` })
    return
  }

  try {
    const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' })
    const openai = client()
    const result = await openai.audio.transcriptions.create({
      file,
      model: modelSingleton ?? 'whisper-1',
      // Language from TRANSCRIBE_LANGUAGE (e.g. 'es'). Unset → auto-detect.
      // A hint improves accuracy on short/noisy glasses-mic clips.
      ...(languageSingleton ? { language: languageSingleton } : {}),
      response_format: 'json',
    })
    const text = result.text.trim()
    console.log(`[transcribe] lang=${languageSingleton ?? 'auto'} model=${modelSingleton} -> ${JSON.stringify(text.slice(0, 80))}`)
    res.json({ text })
  } catch (err) {
    console.error('[transcribe] openai error:', err)
    res.status(502).json({ error: 'transcription_failed' })
  }
}
