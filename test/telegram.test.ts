import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatch } from "../src/http.ts";
import { withHarness } from "./helpers.ts";

const update = JSON.stringify({
  update_id: 1,
  message: { message_id: 1, chat: { id: 42 }, text: "Sample Person" },
});

describe("telegram webhook", () => {
  it("writes nothing when the secret is missing, wrong, or the body is invalid", async () => {
    await withHarness(async (harness) => {
    const before = harness.snapshot();
    const missing = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/telegram/webhook",
      headers: {},
      body: update,
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(harness.snapshot(), before);
    assert.equal(harness.messenger.sent.length, 0);

    const wrong = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "other-secret" },
      body: update,
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(harness.snapshot(), before);

    const emptySecret = { ...harness.deps, config: { ...harness.deps.config, telegramWebhookSecret: "" } };
    const blank = await dispatch(emptySecret, {
      method: "POST",
      path: "/api/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "" },
      body: update,
    });
    assert.equal(blank.status, 401);
    assert.deepEqual(harness.snapshot(), before);

    const invalid = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(harness.snapshot(), before);
    assert.equal(harness.messenger.sent.length, 0);
    });
  });

  it("accepts a webhook that presents the secret", async () => {
    await withHarness(async (harness) => {
    const response = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: update,
    });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body) as { reply: string };
    assert.match(payload.reply, /What is your Email/);
    assert.doesNotMatch(payload.reply, /registered|approved|signed up/i);
    assert.equal(harness.messenger.sent.length, 1);
    assert.equal(harness.messenger.sent[0]?.chatId, "42");
    assert.equal(harness.messenger.sent[0]?.text, payload.reply);
    });
  });
});
