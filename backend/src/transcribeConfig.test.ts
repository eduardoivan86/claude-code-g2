import { describe, expect, test } from 'bun:test'
import { transcribeConfigFromEnv } from './transcribeConfig.ts'

describe('transcribeConfigFromEnv', () => {
  test('defaults to groq when TRANSCRIBE_PROVIDER is unset', () => {
    const cfg = transcribeConfigFromEnv({})
    expect(cfg.provider).toBe('groq')
    expect(cfg.baseURL).toBe('https://api.groq.com/openai/v1')
    expect(cfg.model).toBe('whisper-large-v3-turbo')
    expect(cfg.apiKey).toBe('')
  })

  test('groq picks up GROQ_API_KEY', () => {
    const cfg = transcribeConfigFromEnv({ TRANSCRIBE_PROVIDER: 'groq', GROQ_API_KEY: 'gk' })
    expect(cfg.provider).toBe('groq')
    expect(cfg.apiKey).toBe('gk')
    expect(cfg.baseURL).toBe('https://api.groq.com/openai/v1')
    expect(cfg.model).toBe('whisper-large-v3-turbo')
  })

  test('openai uses openai base, whisper-1 model, and OPENAI_API_KEY', () => {
    const cfg = transcribeConfigFromEnv({ TRANSCRIBE_PROVIDER: 'openai', OPENAI_API_KEY: 'ok' })
    expect(cfg.provider).toBe('openai')
    expect(cfg.baseURL).toBe('https://api.openai.com/v1')
    expect(cfg.model).toBe('whisper-1')
    expect(cfg.apiKey).toBe('ok')
  })

  test('local respects WHISPER_BASE_URL override', () => {
    const cfg = transcribeConfigFromEnv({
      TRANSCRIBE_PROVIDER: 'local',
      WHISPER_BASE_URL: 'http://127.0.0.1:9000/v1',
    })
    expect(cfg.provider).toBe('local')
    expect(cfg.baseURL).toBe('http://127.0.0.1:9000/v1')
  })
})
