// frontend/src/voice.ts
//
// Tiny text-to-speech helper over the Web Speech API (window.speechSynthesis).
// The brain's voice: spoken HUD replies + the attention banner read-aloud.
//
// iOS WKWebView caveat: speechSynthesis requires a prior USER GESTURE before it
// will actually produce audio. The tap that starts a recording satisfies that
// gesture for brain replies (speak() is called shortly after the tap, within the
// same interaction context), so those should speak. The attention-speak fires
// with NO gesture (Claude finished while the phone is pocketed) and may be
// blocked by iOS until the user has interacted with the page. That's acceptable:
// the HUD banner is the guaranteed channel; speech is a best-effort enhancement.

const synth: SpeechSynthesis | null =
  typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null

// Resolve a preferred Spanish voice. getVoices() is often empty on first call
// (voices load async), so we also listen for `voiceschanged` and re-resolve.
function pickSpanishVoice(): SpeechSynthesisVoice | null {
  if (!synth) return null
  const voices = synth.getVoices()
  if (!voices.length) return null
  return voices.find((v) => v.lang?.toLowerCase().startsWith('es')) ?? null
}

// Speak `text` aloud, cancelling any in-flight utterance first. Prefers a
// Spanish voice; falls back to the browser default. No-op when speechSynthesis
// is unavailable or the text is empty. Caller must gate on `voiceEnabled`.
export function speak(text: string): void {
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

// Stop any in-flight or queued speech immediately.
export function cancelSpeak(): void {
  if (!synth) return
  try {
    synth.cancel()
  } catch {
    /* ignore */
  }
}
