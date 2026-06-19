// backend/src/native/telegram.ts
//
// Out-of-band "Claude te espera" notification via Telegram.
//
// The glasses app is a WebView and can't do iOS native push, so when it's fully
// CLOSED the user gets no alert that a Claude turn finished. The backend (which
// runs continuously on the Mac) closes that gap: on turn-complete it fires a
// Telegram message to the user's own bot chat — delivered even with the app shut.
//
// PLUGGABLE + OFF BY DEFAULT: a no-op unless BOTH TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are set. Errors are swallowed/logged, never thrown into the
// caller (the attention path must not break because Telegram is down).

type Env = Record<string, string | undefined>

interface TelegramConfig {
  token: string
  chatId: string
}

/**
 * Resolve the Telegram config from env. Returns `null` (→ no-op) unless BOTH
 * the bot token and chat id are present. PURE / unit-testable.
 */
export function telegramConfigFromEnv(env: Env = process.env): TelegramConfig | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim()
  const chatId = (env.TELEGRAM_CHAT_ID ?? '').trim()
  if (!token || !chatId) return null
  return { token, chatId }
}

/** Build the sendMessage endpoint URL for a bot token. PURE. */
export function telegramSendUrl(token: string): string {
  return `https://api.telegram.org/bot${token}/sendMessage`
}

/**
 * Send `text` to the configured Telegram chat. No-op when the env isn't fully
 * configured. Never throws — provider/network errors are logged and swallowed so
 * a failed notification can't break the turn-complete attention path.
 *
 * `env` and `fetchImpl` are injectable for testing.
 */
export async function notifyTelegram(
  text: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const cfg = telegramConfigFromEnv(env)
  if (!cfg) return // not configured → no-op

  try {
    const res = await fetchImpl(telegramSendUrl(cfg.token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[native:telegram] sendMessage failed: ${res.status} ${detail.slice(0, 200)}`)
    }
  } catch (err) {
    console.error('[native:telegram] sendMessage error:', err)
  }
}
