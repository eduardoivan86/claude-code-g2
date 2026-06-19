// frontend/src/voice.ts
//
// Text-to-speech for the brain's voice: spoken HUD replies + the attention
// banner read-aloud.
//
// Two-tier: when the backend has a cloud TTS provider configured (ElevenLabs /
// OpenAI), speak() plays the natural mp3 it returns. Otherwise it falls back to
// the free-but-robotic Web Speech API (window.speechSynthesis).
//
// iOS WKWebView caveat: BOTH paths need a prior USER GESTURE before they will
// actually produce audio — speechSynthesis is gated, and `new Audio().play()`
// autoplay is gated too. The tap that starts a recording satisfies that gesture
// for brain replies (speak() is called shortly after the tap, within the same
// interaction context), so those should speak. The attention-speak fires with
// NO gesture (Claude finished while the phone is pocketed) and may be blocked by
// iOS until the user has interacted with the page. That's acceptable: the HUD
// banner is the guaranteed channel; speech is a best-effort enhancement.

import { ttsSynthesize } from './api'

const synth: SpeechSynthesis | null =
  typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null

// Track the currently-playing cloud-audio element + its object URL so
// cancelSpeak() can stop it and we don't leak blob URLs.
let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null

function stopAudio(): void {
  if (currentAudio) {
    try {
      currentAudio.pause()
      currentAudio.src = ''
    } catch {
      /* ignore */
    }
    currentAudio = null
  }
  if (currentUrl) {
    try {
      URL.revokeObjectURL(currentUrl)
    } catch {
      /* ignore */
    }
    currentUrl = null
  }
}

// Resolve a preferred Spanish voice. getVoices() is often empty on first call
// (voices load async), so we also listen for `voiceschanged` and re-resolve.
function pickSpanishVoice(): SpeechSynthesisVoice | null {
  if (!synth) return null
  const voices = synth.getVoices()
  if (!voices.length) return null
  return voices.find((v) => v.lang?.toLowerCase().startsWith('es')) ?? null
}

// The browser (speechSynthesis) speech path. Prefers a Spanish voice; falls
// back to the browser default. No-op when speechSynthesis is unavailable.
function speakBrowser(text: string): void {
  if (!synth) return
  const clean = (text ?? '').trim()
  if (!clean) return

  // Cancel any current/queued utterance so replies don't pile up.
  try {
    synth.cancel()
  } catch {
    /* ignore */
  }

  const utter = new SpeechSynthesisUtterance(clean)
  utter.lang = 'es-ES'

  const apply = () => {
    const voice = pickSpanishVoice()
    if (voice) {
      utter.voice = voice
      utter.lang = voice.lang
    }
    try {
      synth.speak(utter)
    } catch {
      /* ignore — best-effort */
    }
  }

  // If voices aren't loaded yet, wait for them once, then speak.
  if (!synth.getVoices().length && 'onvoiceschanged' in synth) {
    const handler = () => {
      synth.removeEventListener('voiceschanged', handler)
      apply()
    }
    synth.addEventListener('voiceschanged', handler)
    // Safety net: some engines never fire voiceschanged — speak anyway shortly.
    setTimeout(() => {
      synth.removeEventListener('voiceschanged', handler)
      apply()
    }, 250)
  } else {
    apply()
  }
}

// Speak `text` aloud, cancelling any in-flight speech first. Tries the natural
// cloud voice (backend mp3); if none is configured, or playback/synthesis
// fails, falls back to speechSynthesis. No-op for empty text. Caller must gate
// on `voiceEnabled`. Callers `void speak(...)` (don't await); this never throws.
export async function speak(text: string): Promise<void> {
  const clean = (text ?? '').trim()
  if (!clean) return

  // Stop whatever is currently speaking (both channels).
  cancelSpeak()

  let blob: Blob | null = null
  try {
    blob = await ttsSynthesize(clean)
  } catch {
    blob = null
  }

  if (!blob) {
    // No cloud provider (or it errored) → free browser voice.
    speakBrowser(clean)
    return
  }

  try {
    stopAudio() // revoke any leftover URL before creating a new one
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    currentUrl = url
    audio.onended = () => {
      if (currentUrl === url) {
        URL.revokeObjectURL(url)
        currentUrl = null
      }
      if (currentAudio === audio) currentAudio = null
    }
    await audio.play().catch(() => {
      // Autoplay blocked / playback failed → fall back to the browser voice.
      stopAudio()
      speakBrowser(clean)
    })
  } catch {
    stopAudio()
    speakBrowser(clean)
  }
}

// Stop any in-flight or queued speech immediately — BOTH the cloud <audio> and
// the speechSynthesis utterance.
export function cancelSpeak(): void {
  stopAudio()
  if (!synth) return
  try {
    synth.cancel()
  } catch {
    /* ignore */
  }
}
