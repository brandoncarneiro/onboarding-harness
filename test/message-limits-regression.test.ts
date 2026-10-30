import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createHttpServer, dispatch } from "../src/http.ts";
import { scriptureReply } from "../src/scripture.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

describe("message admission and scripture parsing", () => {
  for (const channel of ["web", "telegram", "imessage"] as const) {
    it(`refuses oversized raw ${channel} messages without intake changes or model calls`, async () => {
      await withHarness(async (harness) => {
        await harness.send(channel, "existing", "Sample Person");
        const before = harness.snapshot();
        const calls = harness.model.requests.length;
        for (const key of ["existing", "new"]) {
          // Trimming first would incorrectly accept this as a new intake value.
          const result = await harness.send(channel, key, `${" ".repeat(4096)}x`);
          assert.match(result.reply, /message.*too long|message.*4096/i);
          assert.deepEqual(harness.snapshot(), before);
          assert.equal(harness.model.requests.length, calls);
        }
      });
    });
  }

  it("accepts messages at the limit without truncating their model input", async () => {
    await withHarness(async (harness) => {
      const message = `Quote ${"x".repeat(4090)}`;
      const response = await dispatch(harness.deps, {
        method: "POST", path: "/api/chat", headers: {},
        body: JSON.stringify({ sessionId: "at-limit", message }),
      });
      assert.equal(response.status, 200);
      assert.equal(harness.model.requests[0]?.messages[1]?.content, message);
    });
  });

  it("returns HTTP 413 for oversized chat text before any intake or model work", async () => {
    await withHarness(async (harness) => {
      const before = harness.snapshot();
      const response = await dispatch(harness.deps, {
        method: "POST", path: "/api/chat", headers: {},
        body: JSON.stringify({ sessionId: "too-long", message: "x".repeat(4097) }),
      });
      assert.equal(response.status, 413);
      assert.match(JSON.parse(response.body).error, /message.*too long|message.*4096/i);
      assert.deepEqual(harness.snapshot(), before);
      assert.equal(harness.model.requests.length, 0);
    });
  });

  it("acknowledges oversized Telegram text with a cached refusal instead of retrying", async () => {
    await withHarness(async (harness) => {
      const request = {
        method: "POST", path: "/api/telegram/webhook",
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: JSON.stringify({ update_id: 90, message: { chat: { id: 80 }, text: "x".repeat(4097) } }),
      };
      const response = await dispatch(harness.deps, request);
      assert.equal(response.status, 200);
      assert.match(JSON.parse(response.body).reply, /message.*too long|message.*4096/i);
      assert.equal(harness.db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
      assert.equal(harness.model.requests.length, 0);
      assert.equal(harness.messenger.sent.length, 1);
      assert.equal((await dispatch(harness.deps, request)).status, 200);
      assert.equal(harness.messenger.sent.length, 1);
    });
  });

  it("returns HTTP 413 when the transport body exceeds its byte limit", async () => {
    await withHarness(async (harness) => {
      const server = createHttpServer(harness.deps);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
          method: "POST", body: JSON.stringify({ sessionId: "body-limit", message: "x".repeat(1_000_001) }),
        });
        assert.equal(response.status, 413);
        assert.equal(harness.model.requests.length, 0);
      } finally {
        server.close();
        await once(server, "close");
      }
    });
  });

  it("refuses oversized consent during legacy Telegram recovery before rewriting the input", async () => {
    await withHarness(async (harness) => {
      for (const message of INTAKE_BEFORE_CONFIRM) await harness.send("telegram", "42", message);
      harness.db.prepare("INSERT INTO telegram_updates (update_id,reply,chat_id,state) VALUES (91,'','42','applying')").run();
      const before = harness.snapshot();
      const calls = harness.model.requests.length;
      const request = {
        method: "POST", path: "/api/telegram/webhook",
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: JSON.stringify({ update_id: 91, message: { chat: { id: 42 }, text: `${" ".repeat(4096)}yes` } }),
      };
      const response = await dispatch(harness.deps, request);
      assert.equal(response.status, 200);
      assert.match(JSON.parse(response.body).reply, /message.*too long|message.*4096/i);
      const after = harness.snapshot();
      assert.deepEqual(after.sessionGroups, before.sessionGroups);
      assert.deepEqual(after.sessions, before.sessions);
      assert.deepEqual(after.records, before.records);
      assert.equal(harness.model.requests.length, calls);
      assert.equal(harness.messenger.sent.length, 1);
      assert.deepEqual(await dispatch(harness.deps, request), response);
      assert.equal(harness.messenger.sent.length, 1);
    });
  });

  for (const [label, expression] of [
    ["many false references", '"office 9:00 ".repeat(50_000) + "John 3:16-18"'],
    ["a giant digit run without a colon", '"9".repeat(250_000) + " John 3:16-18"'],
    ["a giant digit run after a book without a colon", '"John " + "9".repeat(250_000) + " John 3:16-18"'],
  ]) {
    it(`finishes parsing ${label} within an isolated two-second budget`, () => {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { scriptureReply } from ${JSON.stringify(new URL("../src/scripture.ts", import.meta.url).href)};
        assert.equal(scriptureReply(${expression}), "Reference: John 3:16-18");
      `], { timeout: 2000, encoding: "utf8" });
      assert.equal(child.error, undefined, `parser exceeded its budget: ${child.error?.message}`);
      assert.equal(child.status, 0, child.stderr);
    });
  }

  it("preserves numbered books, whitespace, ranges, casing and ordinary time questions", () => {
    for (const [message, expected] of [
      ["Quote Song\t of\n Solomon 2:1", "Reference: Song of Solomon 2:1"],
      ["what is 1 John 4:8?", "Reference: 1 John 4:8"],
      ["john3:16-18", "Reference: john 3:16-18"],
      ["Quote Example 1:1", "Reference: Example 1:1"],
      ["XJohn 3:16", null],
      ["Johnathan 3:16", null],
      ["What time does the office open, 9:00?", null],
    ]) assert.equal(scriptureReply(message ?? ""), expected);
  });
});
