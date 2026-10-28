import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db.ts";
import { applyIncoming } from "../src/conversation.ts";
import { snapshotDatabase } from "../src/db.ts";
import {
  acceptCompanionHandshake,
  attachImsgIntake,
  beginCompanionPair,
  encodeImsgRequest,
  IMSG_METHODS,
  ImsgRpcClient,
  imsgRpcCommand,
  issueImsgPairCode,
  ScriptedStdio,
} from "../src/imsg.ts";
import { startImsg } from "../src/imsg-runtime.ts";
import { withHarness } from "./helpers.ts";

function request(line: string): { id: string; method: string; params: Record<string, unknown> } {
  const parsed = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
  return parsed;
}

function respond(io: ScriptedStdio, result: unknown): void {
  const pending = request(io.written[io.written.length - 1] ?? "{}");
  io.receive(JSON.stringify({ jsonrpc: "2.0", id: pending.id, result }));
}

describe("imsg", () => {
  it("keeps an older session table able to store an iMessage chat", () => {
    const dir = mkdtempSync(join(tmpdir(), "onboarding-harness-imsg-"));
    const path = join(dir, "old.sqlite");
    const created = new DatabaseSync(path);
    created.exec(`
      CREATE TABLE session_groups (
        id TEXT PRIMARY KEY,
        draft_json TEXT NOT NULL,
        pending_hash TEXT,
        confirmation_hash TEXT,
        saved_record_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
        channel_key TEXT NOT NULL,
        group_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (channel, channel_key)
      );
    `);
    created.close();
    const db = openDatabase(path);
    db.prepare(
      `INSERT INTO session_groups (id, draft_json, updated_at) VALUES ('group-1', '{"values":{}}', '2026-10-26T12:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_key, group_id, created_at) VALUES ('session-1', 'imessage', '7', 'group-1', '2026-10-26T12:00:00.000Z')`,
    ).run();
    const row = db.prepare("SELECT channel FROM sessions WHERE id = 'session-1'").get() as { channel: string };
    assert.equal(row.channel, "imessage");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("speaks only chats, history, watch, and AppleScript send", async () => {
    assert.deepEqual(IMSG_METHODS, [
      "chats.list",
      "messages.history",
      "watch.subscribe",
      "watch.unsubscribe",
      "send",
    ]);
    assert.deepEqual(imsgRpcCommand("imsg"), { command: "imsg", args: ["rpc"] });
    assert.equal(JSON.stringify(imsgRpcCommand().args).includes("launch"), false);
    assert.throws(() => encodeImsgRequest("typing", {}, "1"), /not allowed/);
    assert.throws(() => encodeImsgRequest("send.tracked", { text: "hi", to: "+15555550100" }, "1"), /not allowed/);
    assert.throws(() => encodeImsgRequest("read", {}, "1"), /not allowed/);
    const send = JSON.parse(encodeImsgRequest("send", {
      text: "hello",
      chat_id: 4,
      transport: "bridge",
    }, "9")) as { method: string; params: { transport: string; text: string } };
    assert.equal(send.method, "send");
    assert.equal(send.params.transport, "applescript");
    assert.equal(JSON.stringify(send).includes("bridge"), false);

    const io = new ScriptedStdio();
    const client = new ImsgRpcClient(io);
    const chats = client.chats(5);
    const chatsRequest = request(io.written[0] ?? "");
    assert.equal(chatsRequest.method, "chats.list");
    assert.deepEqual(chatsRequest.params, { limit: 5 });
    respond(io, { chats: [{ id: 4 }] });
    assert.deepEqual(await chats, { chats: [{ id: 4 }] });

    const history = client.history(4, 2);
    assert.equal(request(io.written[1] ?? "").method, "messages.history");
    assert.deepEqual(request(io.written[1] ?? "").params, { chat_id: 4, limit: 2 });
    respond(io, { messages: [] });
    assert.deepEqual(await history, { messages: [] });
    assert.throws(() => client.history(0), /positive integer/);
    assert.equal(io.written.length, 2);
  });

  it("turns a watched message into the intake reply and ignores its own sends", async () => {
    await withHarness(async (harness) => {
      const io = new ScriptedStdio();
      const client = new ImsgRpcClient(io);
      const attached = attachImsgIntake(client, async (message) => {
        const result = await applyIncoming(harness.deps, {
          channel: "imessage",
          channelKey: String(message.chatId),
          message: message.text,
        });
        return result.reply;
      });
      assert.equal(request(io.written[0] ?? "").method, "watch.subscribe");
      respond(io, { subscription: 1, buffer_limit: 256 });
      await attached;

      const beforeOwn = harness.snapshot();
      const writtenBeforeOwn = io.written.length;
      io.receive(JSON.stringify({
        jsonrpc: "2.0",
        method: "message",
        params: { subscription: 1, message: { chat_id: 7, text: "/start", is_from_me: true } },
      }));
      await settle();
      assert.deepEqual(harness.snapshot(), beforeOwn);
      assert.equal(io.written.length, writtenBeforeOwn);

      io.receive(JSON.stringify({
        jsonrpc: "2.0",
        method: "message",
        params: { subscription: 1, message: { chat_id: 7, text: "/start", is_from_me: false } },
      }));
      await settle();
      const outgoing = request(io.written.at(-1) ?? "");
      assert.equal(outgoing.method, "send");
      assert.equal(outgoing.params.chat_id, 7);
      assert.equal(outgoing.params.text, "What is your Name?");
      assert.equal(outgoing.params.transport, "applescript");
      assert.equal(JSON.stringify(outgoing).includes("bridge"), false);
      respond(io, { ok: true });
    });
  });

  it("pairs a companion with one code and writes nothing when the code fails", async () => {
    await withHarness(async (harness) => {
      const now = harness.deps.now();
      const beforeIssue = harness.snapshot();
      const rejected = acceptCompanionHandshake(harness.db, now, "{\"type\":\"pair\",\"code\":\"ZZZZZZZZ\"}");
      assert.equal(rejected.ok, false);
      assert.deepEqual(harness.snapshot(), beforeIssue);

      const code = issueImsgPairCode(harness.db, now);
      const issued = harness.snapshot();
      const malformed = acceptCompanionHandshake(harness.db, now, "not-json");
      assert.equal(malformed.ok, false);
      assert.deepEqual(harness.snapshot(), issued);

      const expired = acceptCompanionHandshake(harness.db, now + 16 * 60 * 1000, JSON.stringify({ type: "pair", code }));
      assert.equal(expired.ok, false);
      assert.deepEqual(harness.snapshot(), issued);

      const paired = acceptCompanionHandshake(harness.db, now, JSON.stringify({ type: "pair", code }));
      assert.equal(paired.ok, true);
      assert.equal(paired.response, JSON.stringify({ type: "paired", code }));
      const used = snapshotDatabase(harness.db).imsgPairCodes as { code: string; used_at: string | null }[];
      assert.equal(used.find((row) => row.code === code)?.used_at, new Date(now).toISOString());
      const afterUse = harness.snapshot();
      const reused = acceptCompanionHandshake(harness.db, now, JSON.stringify({ type: "pair", code }));
      assert.equal(reused.ok, false);
      assert.deepEqual(harness.snapshot(), afterUse);
    });
  });

  it("forwards stdio after the companion pairs and does not open a live process in tests", async () => {
    const local = new ScriptedStdio();
    const remote = new ScriptedStdio();
    const pairing = beginCompanionPair(local, remote, "ABCD2345");
    assert.equal(remote.written[0], JSON.stringify({ type: "pair", code: "ABCD2345" }));
    local.receive("{\"jsonrpc\":\"2.0\",\"method\":\"ready\"}");
    remote.receive(JSON.stringify({ type: "rejected" }));
    await assert.rejects(pairing, /rejected/);

    const againLocal = new ScriptedStdio();
    const againRemote = new ScriptedStdio();
    const accepted = beginCompanionPair(againLocal, againRemote, "ABCD2345");
    againLocal.receive("child-line");
    againRemote.receive(JSON.stringify({ type: "paired", code: "ABCD2345" }));
    await accepted;
    assert.equal(againRemote.written.includes("child-line"), true);
    againRemote.receive("{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"send\"}");
    assert.equal(againLocal.written.at(-1), "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"send\"}");

    await withHarness(async (harness) => {
      const io = new ScriptedStdio();
      let listened = 0;
      startImsg({
        mode: "local",
        command: "imsg",
        db: harness.db,
        now: harness.deps.now,
        pairPort: 8791,
        receive: async () => "unused",
        openLocal: () => io,
        listen: () => {
          listened += 1;
        },
      });
      assert.equal(listened, 0);
      assert.equal(request(io.written[0] ?? "").method, "watch.subscribe");

      const logs: string[] = [];
      let connect: ((transport: ScriptedStdio) => void) | undefined;
      startImsg({
        mode: "remote",
        command: "imsg",
        db: harness.db,
        now: harness.deps.now,
        pairPort: 8791,
        receive: async () => "What is your Name?",
        openLocal: () => {
          throw new Error("remote mode must not spawn imsg");
        },
        listen: (_port, onConnection) => {
          connect = (transport) => onConnection(transport);
        },
        log: (line) => logs.push(line),
      });
      assert.match(logs[0] ?? "", /^imsg pair code: [A-Z2-9]{8}$/);
      const code = (logs[0] ?? "").slice("imsg pair code: ".length);
      assert.ok(connect);
      const rejected = new ScriptedStdio();
      const before = harness.snapshot();
      connect(rejected);
      rejected.receive(JSON.stringify({ type: "pair", code: "ZZZZZZZZ" }));
      assert.equal(rejected.written.at(-1), JSON.stringify({ type: "rejected" }));
      assert.deepEqual(harness.snapshot(), before);
      const paired = new ScriptedStdio();
      connect(paired);
      paired.receive(JSON.stringify({ type: "pair", code }));
      assert.equal(paired.written[0], JSON.stringify({ type: "paired", code }));
      assert.equal(request(paired.written[1] ?? "").method, "watch.subscribe");
    });
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
