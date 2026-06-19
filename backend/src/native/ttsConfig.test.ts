// backend/src/native/ttsConfig.test.ts
import { test, expect } from "bun:test";
import { ttsConfigFromEnv } from "./ttsConfig";

test("default (no env) → browser", () => {
  const cfg = ttsConfigFromEnv({});
  expect(cfg.provider).toBe("browser");
  expect(cfg.apiKey).toBe("");
});

test("elevenlabs with key → provider elevenlabs + voice/model defaults", () => {
  const cfg = ttsConfigFromEnv({
    TTS_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "el-key",
  });
  expect(cfg.provider).toBe("elevenlabs");
  expect(cfg.apiKey).toBe("el-key");
  expect(cfg.voiceId).toBe("21m00Tcm4TlvDq8ikWAM");
  expect(cfg.modelId).toBe("eleven_flash_v2_5");
});

test("elevenlabs honours custom voice/model overrides", () => {
  const cfg = ttsConfigFromEnv({
    TTS_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "el-key",
    ELEVENLABS_VOICE_ID: "my-voice",
    ELEVENLABS_MODEL: "eleven_multilingual_v2",
  });
  expect(cfg.voiceId).toBe("my-voice");
  expect(cfg.modelId).toBe("eleven_multilingual_v2");
});

test("provider=elevenlabs but no key → graceful browser", () => {
  const cfg = ttsConfigFromEnv({ TTS_PROVIDER: "elevenlabs" });
  expect(cfg.provider).toBe("browser");
});

test("openai with key → provider openai + model/voice defaults", () => {
  const cfg = ttsConfigFromEnv({
    TTS_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-key",
  });
  expect(cfg.provider).toBe("openai");
  expect(cfg.apiKey).toBe("sk-key");
  expect(cfg.model).toBe("tts-1");
  expect(cfg.voice).toBe("nova");
});

test("provider=openai but no key → graceful browser", () => {
  const cfg = ttsConfigFromEnv({ TTS_PROVIDER: "openai" });
  expect(cfg.provider).toBe("browser");
});

test("unknown provider → browser", () => {
  const cfg = ttsConfigFromEnv({ TTS_PROVIDER: "bogus" });
  expect(cfg.provider).toBe("browser");
});
