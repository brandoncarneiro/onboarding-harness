import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createHttpServer, dispatch } from "../src/http.ts";
import { listRecords } from "../src/recordStore.ts";
import { withHarness } from "./helpers.ts";

describe("http", () => {
  it("serves health, the chat page, and POST /api/chat", async () => {
    await withHarness(async (harness) => {
    const before = harness.snapshot();
    const health = await dispatch(harness.deps, { method: "GET", path: "/health", headers: {}, body: "" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    const page = await dispatch(harness.deps, { method: "GET", path: "/", headers: {}, body: "" });
    assert.equal(page.status, 200);
    assert.match(page.body, /\/api\/chat/);
    assert.match(page.body, /id="message"/);

    const invalid = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(harness.snapshot(), before);

    const empty = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ sessionId: "web-1", message: "   " }),
    });
    assert.equal(empty.status, 400);
    assert.deepEqual(harness.snapshot(), before);

    const chat = await dispatch(harness.deps, {
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ sessionId: "web-1", message: "Sample Person" }),
    });
    assert.equal(chat.status, 200);
    const payload = JSON.parse(chat.body) as { reply: string; sessionId: string; status: string };
    assert.equal(payload.sessionId, "web-1");
    assert.equal(payload.status, "collecting");
    assert.match(payload.reply, /What is your Email/);
    assert.doesNotMatch(payload.reply, /registered|approved|signed up/i);
    assert.equal(listRecords(harness.db).length, 0);
    assert.ok(harness.model.requests.length > 0);
    assert.equal(
      harness.model.requests.some((request) => request.messages.some((message) => message.role === "system" && message.content.includes(harness.schema.title))),
      false,
    );
    });
  });

  it("answers a live health check and a live chat post", async () => {
    await withHarness(async (harness) => {
    const server = createHttpServer(harness.deps);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
      const page = await fetch(`${base}/`);
      assert.match(await page.text(), /fetch\("\/api\/chat"/);
      const chat = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "live-session", message: "Sample Person" }),
      });
      const payload = await chat.json() as { reply: string };
      assert.match(payload.reply, /What is your Email/);
      assert.doesNotMatch(payload.reply, /registered|approved|signed up/i);
    } finally {
      server.close();
      await once(server, "close");
    }
    });
  });
});
