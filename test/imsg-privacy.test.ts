import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { bindCompanion, startImsg } from "../src/imsg-runtime.ts";
import { issueImsgPairCode, ScriptedStdio } from "../src/imsg.ts";
import { issueLinkCode, redeemLinkCode } from "../src/linkCodes.ts";
import { listRecords } from "../src/recordStore.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness, type Harness } from "./helpers.ts";

// RPCPayloads.swift and docs/json.md at openclaw/imsg 5af52a029b3d027cc064f16ead5ed60b888febfb.
const directMetadata = {
  chat_identifier: "+15555550100",
  chat_guid: "iMessage;-;+15555550100",
  chat_name: "",
  is_group: false,
  participants: ["+15555550100"],
  sender: "+15555550100",
};

function attach(harness: Harness, mode: "local" | "companion"): ScriptedStdio {
  const io = new ScriptedStdio();
  const receive = async (chatId: number, text: string) =>
    (await harness.send("imessage", String(chatId), text)).reply;
  if (mode === "local") {
    startImsg({
      mode: "local", command: "unused", db: harness.db, now: harness.deps.now,
      pairPort: 8791, receive, openLocal: () => io,
    });
  } else {
    const code = issueImsgPairCode(harness.db, harness.deps.now());
    bindCompanion(harness.db, harness.deps.now, io, (message) => receive(message.chatId, message.text));
    io.receive(JSON.stringify({ type: "pair", code }));
  }
  const watch = JSON.parse(io.written.at(-1) ?? "{}") as { id: string; method: string };
  assert.equal(watch.method, "watch.subscribe");
  io.receive(JSON.stringify({ jsonrpc: "2.0", id: watch.id, result: { subscription: 1, buffer_limit: 256 } }));
  return io;
}

async function deliver(io: ScriptedStdio, text: string, metadata: Record<string, unknown> = {}): Promise<void> {
  io.receive(JSON.stringify({
    jsonrpc: "2.0", method: "message", params: {
      subscription: 1,
      message: {
        id: 10, chat_id: 7, guid: `message-${io.written.length}-${text}`, text,
        created_at: "2026-10-26T12:00:00.000Z", is_from_me: false, attachments: [],
        ...directMetadata, ...metadata,
      },
    },
  }));
  await setImmediate();
}

function lastReply(io: ScriptedStdio): string {
  const outgoing = JSON.parse(io.written.at(-1) ?? "{}") as {
    id: string; method: string; params: { to: string; chat_id?: number; text: string; transport: string };
  };
  assert.equal(outgoing.method, "send");
  assert.equal(outgoing.params.to, "+15555550100");
  assert.equal(outgoing.params.chat_id, undefined);
  assert.equal(outgoing.params.transport, "applescript");
  io.receive(JSON.stringify({ jsonrpc: "2.0", id: outgoing.id, result: { ok: true } }));
  return outgoing.params.text;
}

describe("iMessage direct-message privacy", () => {
  for (const mode of ["local", "companion"] as const) {
    it(`blocks group members from reading, editing, confirming, or linking existing linked intake through ${mode}`, async () => {
      await withHarness(async (harness) => {
        for (const text of INTAKE_BEFORE_CONFIRM) await harness.send("web", "owner", text);
        const code = issueLinkCode(harness.db, { channel: "web", channelKey: "owner", nowMs: harness.deps.now() });
        assert.equal(redeemLinkCode(harness.db, {
          channel: "imessage", channelKey: "7", code, nowMs: harness.deps.now(),
        }).linked, true);
        const unusedCode = issueLinkCode(harness.db, { channel: "web", channelKey: "owner", nowMs: harness.deps.now() });
        const io = attach(harness, mode);
        const before = harness.snapshot();
        const writes = io.written.length;
        const modelRequests = harness.model.requests.length;
        for (const sender of ["+15555550100", "+15555550101"]) {
          for (const text of ["/start", "change Name to Someone Else", "yes", "link code", `use code ${unusedCode}`]) {
            await deliver(io, text, {
              is_group: true, chat_identifier: "chat123", chat_guid: "iMessage;+;chat123",
              participants: ["+15555550100", "+15555550101"], sender,
            });
            assert.deepEqual(harness.snapshot(), before, `${sender}: ${text}`);
            assert.equal(io.written.length, writes, "must not disclose intake in a group reply");
            assert.equal(harness.model.requests.length, modelRequests);
          }
        }
        await deliver(io, `use code ${unusedCode}`, {
          chat_id: 99, is_group: true, chat_identifier: "chat456", chat_guid: "iMessage;+;chat456",
          participants: ["+15555550100", "+15555550101"],
        });
        assert.deepEqual(harness.snapshot(), before, "a new group must not consume a link code or create a session");
      });
    });
  }

  for (const [name, metadata] of [
    ["missing group flag", { is_group: undefined }],
    ["null group flag", { is_group: null }],
    ["string group flag", { is_group: "false" }],
    ["missing chat identity", { chat_identifier: "", chat_guid: "", participants: [] }],
    ["missing identifier", { chat_identifier: undefined }],
    ["missing GUID", { chat_guid: undefined }],
    ["unknown GUID shape", { chat_guid: "unknown" }],
    ["conflicting group GUID", { chat_guid: "iMessage;+;chat123" }],
    ["conflicting group identifier", { chat_identifier: "iMessage;+;chat123" }],
    ["missing participants", { participants: undefined }],
    ["empty participants", { participants: [] }],
    ["multiple participants", { participants: ["+15555550100", "+15555550101"] }],
    ["empty participant", { participants: [""] }],
    ["different sender", { sender: "+15555550101" }],
  ] satisfies [string, Record<string, unknown>][]) {
    it(`ignores ${name} without creating intake or replying`, async () => {
      await withHarness(async (harness) => {
        const io = attach(harness, "local");
        const before = harness.snapshot();
        const writes = io.written.length;
        await deliver(io, "/start", metadata);
        assert.deepEqual(harness.snapshot(), before);
        assert.equal(io.written.length, writes);
        assert.equal(harness.model.requests.length, 0);
      });
    });
  }

  it("ignores watch metadata errors without touching intake", async () => {
    await withHarness(async (harness) => {
      const io = attach(harness, "local");
      const before = harness.snapshot();
      const writes = io.written.length;
      io.receive(JSON.stringify({ jsonrpc: "2.0", method: "error", params: { subscription: 1, error: { message: "chat metadata unavailable" } } }));
      await setImmediate();
      assert.deepEqual(harness.snapshot(), before);
      assert.equal(io.written.length, writes);
    });
  });

  for (const mode of ["local", "companion"] as const) {
    it(`preserves direct-message intake, edits, confirmation, and linking through ${mode}`, async () => {
      await withHarness(async (harness) => {
        const io = attach(harness, mode);
        await deliver(io, "/start");
        assert.equal(lastReply(io), "What is your Name?");
        for (const text of INTAKE_BEFORE_CONFIRM) {
          await deliver(io, text);
          lastReply(io);
        }
        await deliver(io, "change Name to Updated Person");
        assert.match(lastReply(io), /Updated Person/);
        await deliver(io, "yes");
        assert.equal(lastReply(io), "The details are saved.");
        assert.equal(listRecords(harness.db).length, 1);
        await deliver(io, "link code");
        const code = /One-time link code: ([A-Z2-9]{8})/.exec(lastReply(io))?.[1];
        assert.ok(code);
        await harness.send("web", "linked-web", `use code ${code}`);
        const resumed = await harness.send("web", "linked-web", "/start");
        assert.equal(resumed.draft.name, "Updated Person");
        assert.equal(resumed.status, "saved");
      });
    });
  }
});
