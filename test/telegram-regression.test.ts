import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { openDatabase } from "../src/db.ts";
import { dispatch, type HttpRequest } from "../src/http.ts";
import { listRecords } from "../src/recordStore.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

function update(id: number, text: string, chatId = 42, userId = 42): HttpRequest {
  return {
    method: "POST", path: "/api/telegram/webhook",
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    body: JSON.stringify({ update_id: id, message: {
      message_id: id, chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
      from: { id: userId }, text,
    } }),
  };
}

for (const separateConnection of [false, true]) {
  it(`claims concurrent consent before applying it (${separateConnection ? "two database connections" : "one connection"})`, { timeout: 5000 }, async () => {
    await withHarness(async (h) => {
      for (const [i, message] of INTAKE_BEFORE_CONFIRM.slice(0, 5).entries()) {
        await dispatch(h.deps, update(i + 1, message));
      }
      const otherDb = separateConnection ? openDatabase(join(h.dir, "test.sqlite")) : h.db;
      const gate = Promise.withResolvers<void>();
      let hadClaim = false;
      let calls = 0;
      h.deps.model = { complete: async (request) => {
        calls += 1;
        hadClaim = Boolean(h.db.prepare("SELECT update_id FROM telegram_updates WHERE update_id = 6").get());
        await gate.promise;
        return { text: request.safeText };
      } };
      const sentBefore = h.messenger.sent.length;
      try {
        const first = dispatch(h.deps, update(6, "yes"));
        const second = dispatch({ ...h.deps, db: otherDb }, update(6, "yes"));
        const settled = Promise.allSettled([first, second]);
        gate.resolve();
        const results = await settled;
        assert.equal(listRecords(h.db).length, 0, "a duplicated consent cannot confirm the record");
        assert.ok(hadClaim, "update must be claimed before the conversation reaches the model");
        assert.equal(calls, 1);
        for (const result of results) {
          assert.equal(result.status, "fulfilled", "no UNIQUE error may escape");
          if (result.status === "fulfilled") assert.equal(result.value.status, 200);
        }
        assert.deepEqual(results[0], results[1]);
        assert.equal(h.messenger.sent.length, sentBefore + 1);
        const beforeReplay = h.snapshot();
        const writes = h.db.prepare("SELECT total_changes() AS n").get()?.n;
        await dispatch(h.deps, update(6, "yes"));
        assert.deepEqual(h.snapshot(), beforeReplay);
        assert.equal(h.db.prepare("SELECT total_changes() AS n").get()?.n, writes);
        await dispatch(h.deps, update(7, "yes"));
        assert.equal(listRecords(h.db).length, 1, "a new explicit confirmation still saves");
      } finally {
        gate.resolve();
        if (separateConnection) otherDb.close();
      }
    });
  });
}

it("retries a failed Telegram send once for concurrent redeliveries without reapplying", async () => {
  await withHarness(async (h) => {
    let sends = 0;
    h.deps.messenger = { send: async () => {
      sends += 1;
      if (sends === 1) throw new Error("synthetic delivery failure");
    } };
    const request = update(1, "Alice Example");
    assert.equal((await dispatch(h.deps, request)).status, 503);
    const draft = h.snapshot().sessionGroups;
    const calls = h.model.requests.length;
    const replies = await Promise.all([dispatch(h.deps, request), dispatch(h.deps, request)]);
    assert.equal(sends, 2, "one failed attempt plus one successful retry");
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(replies[0]?.status, 200);
    assert.deepEqual(h.snapshot().sessionGroups, draft);
    assert.equal(h.model.requests.length, calls);
  });
});

it("continues a group user's intake when they answer in private", async () => {
  await withHarness(async (h) => {
    await dispatch(h.deps, update(1, "Alice Example", -100, 11));
    assert.deepEqual(h.messenger.sent.at(-1), { chatId: "11", text: "What is your Email?" });
    await dispatch(h.deps, update(2, "alice@example.com", 11, 11));
    assert.deepEqual(h.messenger.sent.at(-1), { chatId: "11", text: "What is your Mobile?" });
    assert.equal(h.snapshot().sessions.length, 1);
    const starter = h.snapshot().sessionGroups;
    await dispatch(h.deps, update(3, "change name to Someone Else", -100, 22));
    assert.equal(h.messenger.sent.at(-1)?.chatId, "22");
    const starterId = (starter[0] as { id: string }).id;
    assert.deepEqual(h.snapshot().sessionGroups.find((g) => (g as { id: string }).id === starterId), starter[0]);
  });
});

for (const legacyKey of ["11:11", "-100:11"]) {
  it(`continues the existing ${legacyKey} intake after switching to user identity`, async () => {
    await withHarness(async (h) => {
      await h.send("telegram", legacyKey, "Alice Example");
      await dispatch(h.deps, update(1, "alice@example.com", 11, 11));
      assert.equal(h.messenger.sent.at(-1)?.text, "What is your Mobile?");
      assert.equal(h.snapshot().sessions.length, 1);
      await dispatch(h.deps, update(2, "555-0100", -200, 11));
      assert.equal(h.messenger.sent.at(-1)?.text, "What is your Organization name?");
      assert.equal(h.snapshot().sessions.length, 1);
    });
  });
}

it("preserves ambiguous legacy drafts rather than silently choosing or replacing one", async () => {
  await withHarness(async (h) => {
    await h.send("telegram", "11:11", "First Draft");
    await h.send("telegram", "-100:11", "Second Draft");
    const before = h.snapshot();
    await assert.rejects(h.send("telegram", "11", "alice@example.com"), /legacy Telegram intakes/);
    assert.deepEqual(h.snapshot(), before);
  });
});
