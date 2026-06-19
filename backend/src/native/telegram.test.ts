// backend/src/native/telegram.test.ts
import { test, expect } from "bun:test";
import {
  notifyTelegram,
  telegramConfigFromEnv,
  telegramSendUrl,
} from "./telegram";

test("telegramConfigFromEnv → null when env unset", () => {
  expect(telegramConfigFromEnv({})).toBeNull();
});

test("telegramConfigFromEnv → null when only token set", () => {
  expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "t" })).toBeNull();
});

test("telegramConfigFromEnv → null when only chat id set", () => {
  expect(telegramConfigFromEnv({ TELEGRAM_CHAT_ID: "c" })).toBeNull();
});

test("telegramConfigFromEnv → config when both set (trimmed)", () => {
  const cfg = telegramConfigFromEnv({
    TELEGRAM_BOT_TOKEN: "  123:abc  ",
    TELEGRAM_CHAT_ID: "  4242  ",
  });
  expect(cfg).toEqual({ token: "123:abc", chatId: "4242" });
});

test("telegramSendUrl builds the bot sendMessage endpoint", () => {
  expect(telegramSendUrl("123:abc")).toBe(
    "https://api.telegram.org/bot123:abc/sendMessage",
  );
});

test("notifyTelegram with env unset is a no-op (no fetch)", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  await notifyTelegram("hi", {}, fakeFetch);
  expect(called).toBe(false);
});

test("notifyTelegram with env set POSTs the right URL + chat_id/text", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  await notifyTelegram(
    "🔔 done",
    { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "4242" },
    fakeFetch,
  );

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe(
    "https://api.telegram.org/bot123:abc/sendMessage",
  );
  expect(calls[0].init.method).toBe("POST");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.chat_id).toBe("4242");
  expect(body.text).toBe("🔔 done");
});

test("notifyTelegram never throws on a non-ok response", async () => {
  const fakeFetch = (async () =>
    new Response("nope", { status: 400 })) as unknown as typeof fetch;
  // Should resolve without throwing.
  await notifyTelegram(
    "x",
    { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" },
    fakeFetch,
  );
  expect(true).toBe(true);
});

test("notifyTelegram never throws when fetch rejects", async () => {
  const fakeFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  await notifyTelegram(
    "x",
    { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" },
    fakeFetch,
  );
  expect(true).toBe(true);
});
