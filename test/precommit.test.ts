import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Socket } from "node:net";
import { dispatch } from "../src/http.ts";
import {
  attachImsgIntake,
  beginCompanionPair,
  ImsgRpcClient,
  inboundFromNotification,
  ScriptedStdio,
  socketTransport,
} from "../src/imsg.ts";
import { startImsg } from "../src/imsg-runtime.ts";
import { issueLinkCode, redeemLinkCode } from "../src/linkCodes.ts";
import { listRecords, readGroup, readSession } from "../src/recordStore.ts";
import { replyForSearch } from "../src/grounding.ts";
import { scriptureReply } from "../src/scripture.ts";
import { canonicalJson, confirmationSummary, parseFieldInput, type DraftValues } from "../src/values.ts";
import type { FieldSpec } from "../src/schema.ts";
import type { OutboundMessenger } from "../src/outbound.ts";
import { FakeModel, INTAKE_BEFORE_CONFIRM, projectRoot, withHarness } from "./helpers.ts";

const secret = { "x-telegram-bot-api-secret-token": "test-secret" };

function telegramUpdate(input: {
  updateId: number;
  chatId: number;
  text: string;
  fromId?: number;
  chatType?: string;
}): string {
  return JSON.stringify({
    update_id: input.updateId,
    message: {
      message_id: input.updateId,
      chat: { id: input.chatId, ...(input.chatType ? { type: input.chatType } : {}) },
      ...(input.fromId === undefined ? {} : { from: { id: input.fromId } }),
      text: input.text,
    },
  });
}

class FlakyMessenger implements OutboundMessenger {
  readonly sent: { chatId: string; text: string }[] = [];
  fail = true;

  async send(chatId: string, text: string): Promise<void> {
    if (this.fail) throw new Error("send failed");
    this.sent.push({ chatId, text });
  }
}

describe("pre-commit findings", () => {
  it("dedupes a Telegram update and lets a failed send be retried", async () => {
    await withHarness(async (harness) => {
      const messenger = new FlakyMessenger();
      harness.deps.messenger = messenger;
      const body = telegramUpdate({ updateId: 9, chatId: 42, text: "Sample Person" });
      const failed = await dispatch(harness.deps, {
        method: "POST",
        path: "/api/telegram/webhook",
        headers: secret,
        body,
      });
      assert.equal(failed.status >= 400, true);
      assert.equal(messenger.sent.length, 0);
      const afterFailure = harness.snapshot();

      messenger.fail = false;
      const retried = await dispatch(harness.deps, {
        method: "POST",
        path: "/api/telegram/webhook",
        headers: secret,
        body,
      });
      assert.equal(retried.status, 200);
      assert.equal(messenger.sent.length, 1);
      assert.match(messenger.sent[0]?.text ?? "", /What is your Email/);
      assert.doesNotMatch(messenger.sent[0]?.text ?? "", /valid Email/);
      const afterSend = harness.snapshot();
      assert.notDeepEqual(afterSend, afterFailure);

      const replay = await dispatch(harness.deps, {
        method: "POST",
        path: "/api/telegram/webhook",
        headers: secret,
        body,
      });
      assert.equal(replay.status, 200);
      assert.equal(messenger.sent.length, 1);
      assert.deepEqual(harness.snapshot(), afterSend);
    });
  });

  it("keeps a group member who did not start the Telegram intake from reading or changing it", async () => {
    await withHarness(async (harness) => {
      const first = await dispatch(harness.deps, {
        method: "POST",
        path: "/api/telegram/webhook",
        headers: secret,
        body: telegramUpdate({ updateId: 1, chatId: -100, fromId: 11, chatType: "supergroup", text: "Sample Person" }),
      });
      assert.equal(first.status, 200);
      const starter = readSession(harness.db, "telegram", "11");
      assert.ok(starter);
      const before = readGroup(harness.db, starter.groupId).values;

      const other = await dispatch(harness.deps, {
        method: "POST",
        path: "/api/telegram/webhook",
        headers: secret,
        body: telegramUpdate({ updateId: 2, chatId: -100, fromId: 22, chatType: "supergroup", text: "change city to Other City" }),
      });
      assert.equal(other.status, 200);
      assert.deepEqual(readGroup(harness.db, starter.groupId).values, before);
      const intruder = readSession(harness.db, "telegram", "22");
      assert.ok(intruder);
      assert.notEqual(intruder.groupId, starter.groupId);
      assert.equal(JSON.stringify(readGroup(harness.db, intruder.groupId).values).includes("Sample Person"), false);
    });
  });

  it("ignores an edited iMessage and a repeated message guid", async () => {
    assert.equal(inboundFromNotification({
      method: "message",
      params: { message: { type: "edited", chat_id: 7, text: "yes", is_from_me: false, is_group: false, chat_identifier: "+15555550100", chat_guid: "iMessage;-;+15555550100", participants: ["+15555550100"], sender: "+15555550100", guid: "edited-1" } },
    }), null);

    const io = new ScriptedStdio();
    const client = new ImsgRpcClient(io);
    let calls = 0;
    const attached = attachImsgIntake(client, async () => {
      calls += 1;
      return "What is your Name?";
    });
    const watch = JSON.parse(io.written[0] ?? "{}") as { id: string };
    io.receive(JSON.stringify({ jsonrpc: "2.0", id: watch.id, result: { subscription: 1 } }));
    await attached;
    const notice = {
      jsonrpc: "2.0",
      method: "message",
      params: { subscription: 1, message: { chat_id: 7, text: "/start", is_from_me: false, is_group: false, chat_identifier: "+15555550100", chat_guid: "iMessage;-;+15555550100", participants: ["+15555550100"], sender: "+15555550100", guid: "same-guid" } },
    };
    io.receive(JSON.stringify(notice));
    io.receive(JSON.stringify(notice));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
  });

  it("saves only a new message that is exactly yes", async () => {
    await withHarness(async (harness) => {
      for (const message of INTAKE_BEFORE_CONFIRM) {
        await harness.send("web", "confirm-word", message);
      }
      const yep = await harness.send("web", "confirm-word", "yep");
      const confirm = await harness.send("web", "confirm-word", "confirm");
      assert.notEqual(yep.status, "saved");
      assert.notEqual(confirm.status, "saved");
      assert.equal(listRecords(harness.db).length, 0);
      const saved = await harness.send("web", "confirm-word", "yes");
      assert.equal(saved.reply, "The details are saved.");
      assert.equal(listRecords(harness.db).length, 1);
    });
  });

  it("rejects companion lines that are not allowed RPC methods and ignores a forged paired response", async () => {
    const forgedLocal = new ScriptedStdio();
    const forgedRemote = new ScriptedStdio();
    const forged = beginCompanionPair(forgedLocal, forgedRemote, "ABCD2345");
    forgedRemote.receive(JSON.stringify({
      type: "paired",
      method: "send",
      params: { text: "pwn", to: "+15555550100", transport: "bridge" },
    }));
    await assert.rejects(forged, /rejected/);
    assert.equal(forgedLocal.written.length, 0);

    const local = new ScriptedStdio();
    const remote = new ScriptedStdio();
    const paired = beginCompanionPair(local, remote, "ABCD2345");
    remote.receive(JSON.stringify({ type: "paired", code: "ABCD2345" }));
    await paired;
    remote.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "typing", params: {} }));
    remote.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "send",
      params: { chat_id: 4, text: "hello", transport: "bridge" },
    }));
    assert.equal(local.written.some((line) => line.includes("typing")), false);
    const forwarded = JSON.parse(local.written.at(-1) ?? "{}") as { method?: string; params?: { transport?: string } };
    assert.equal(forwarded.method, "send");
    assert.equal(forwarded.params?.transport, "applescript");
  });

  it("describes the pair socket as plaintext and not for a public port", () => {
    const readme = readFileSync(join(projectRoot, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Phone and iMessage"));
    assert.match(section, /plaintext/);
    assert.match(section, /public port/);
    assert.doesNotMatch(section, /safe (to|on|for) (a )?public/i);
  });

  it("uses the safe prompt for both non-schema requests and benign model rephrases", async () => {
    await withHarness(async (harness) => {
      harness.deps.model = new FakeModel((request) => {
        if (request.mode === "prompt") return "What is your Email and your date of birth?";
        return request.safeText;
      });
      const extra = await harness.send("web", "rephrase-bad", "Sample Person");
      assert.equal(extra.reply, "What is your Email?");
      assert.equal(extra.reply.includes("birth"), false);

      harness.deps.model = new FakeModel((request) => {
        if (request.mode === "prompt") return "Could you share your Email?";
        return request.safeText;
      });
      const rephrased = await harness.send("web", "rephrase-ok", "Sample Person");
      assert.equal(rephrased.reply, "What is your Email?");
    });
  });

  it("logs a generic iMessage error and keeps web and Telegram serving", async () => {
    await withHarness(async (harness) => {
      const logged: string[] = [];
      const original = console.error;
      console.error = (message?: unknown) => {
        logged.push(String(message));
      };
      try {
        assert.doesNotThrow(() => {
          startImsg({
            mode: "local",
            command: "imsg-missing",
            db: harness.db,
            now: harness.deps.now,
            pairPort: 8791,
            receive: async () => "unused",
            openLocal: () => {
              throw new Error("spawn imsg-missing ENOENT /start secret text");
            },
            listen: () => {
              throw new Error("should not listen");
            },
          });
        });

        const io = new ScriptedStdio();
        const client = new ImsgRpcClient(io);
        const attached = attachImsgIntake(client, async () => "What is your Name?");
        const watch = JSON.parse(io.written[0] ?? "{}") as { id: string };
        io.receive(JSON.stringify({ jsonrpc: "2.0", id: watch.id, result: { subscription: 1 } }));
        await attached;
        io.receive(JSON.stringify({
          jsonrpc: "2.0",
          method: "message",
          params: { message: { chat_id: 3, text: "secret intake text", is_from_me: false, is_group: false, chat_identifier: "+15555550100", chat_guid: "iMessage;-;+15555550100", participants: ["+15555550100"], sender: "+15555550100", guid: "g-send" } },
        }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const send = JSON.parse(io.written.at(-1) ?? "{}") as { id: string };
        io.receive(JSON.stringify({ jsonrpc: "2.0", id: send.id, error: { code: -32603, message: "secret intake text" } }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        console.error = original;
      }
      assert.ok(logged.some((line) => line === "imsg is unavailable"));
      assert.equal(logged.some((line) => line.includes("secret")), false);
      const health = await dispatch(harness.deps, { method: "GET", path: "/health", headers: {}, body: "" });
      assert.equal(health.status, 200);
    });
  });

  it("moves every session in the source group when linking", async () => {
    await withHarness(async (harness) => {
      const now = harness.deps.now();
      const first = issueLinkCode(harness.db, { channel: "web", channelKey: "member-a", nowMs: now });
      assert.equal(redeemLinkCode(harness.db, { channel: "web", channelKey: "member-b", code: first, nowMs: now }).linked, true);
      const groupBefore = readSession(harness.db, "web", "member-a")?.groupId;
      assert.equal(groupBefore, readSession(harness.db, "web", "member-b")?.groupId);
      const issuer = issueLinkCode(harness.db, { channel: "telegram", channelKey: "issuer", nowMs: now });
      assert.equal(redeemLinkCode(harness.db, { channel: "web", channelKey: "member-b", code: issuer, nowMs: now }).linked, true);
      const issuerGroup = readSession(harness.db, "telegram", "issuer")?.groupId;
      assert.equal(readSession(harness.db, "web", "member-a")?.groupId, issuerGroup);
      assert.equal(readSession(harness.db, "web", "member-b")?.groupId, issuerGroup);
    });
  });

  it("lists every hashed field in the confirmation summary, including optional fields", () => {
    const fields: FieldSpec[] = [
      { path: "name", title: "Name", type: "string", required: true },
      { path: "note", title: "Note", type: "string", required: false },
    ];
    const values: DraftValues = { name: "Sample Person", note: "side door" };
    const summary = confirmationSummary(fields, values);
    assert.match(summary, /Name: Sample Person/);
    assert.match(summary, /Note: side door/);
    assert.equal(canonicalJson(fields, values).includes("side door"), true);
  });

  it("stores First Bible Church as the organization name", async () => {
    await withHarness(async (harness) => {
      for (const message of ["Sample Person", "person@example.com", "555-0100"]) {
        await harness.send("web", "org-name", message);
      }
      const turn = await harness.send("web", "org-name", "First Bible Church");
      assert.equal(turn.draft.organizationName, "First Bible Church");
      assert.match(turn.reply, /What is your City/);
      assert.equal(turn.reply.includes("Reference:"), false);
      assert.equal(scriptureReply("First Bible Church"), null);
    });
  });

  it("stores a schema boolean false as false", () => {
    const field: FieldSpec = { path: "optOut", title: "Opt out", type: "boolean", required: true };
    assert.deepEqual(parseFieldInput(field, "false"), { ok: true, value: false });
    const stored = canonicalJson([field], { optOut: false });
    assert.equal(JSON.parse(stored).optOut, false);
  });

  it("keeps the full scripture book name and matches it in any case", () => {
    assert.equal(scriptureReply("Quote Song of Solomon 2:1"), "Reference: Song of Solomon 2:1");
    assert.equal(scriptureReply("what is song of solomon 2:1?"), "Reference: song of solomon 2:1");
    assert.equal(scriptureReply("Quote Song of Solomon 2:1 VERSE-TEXT-NOT-ALLOWED")?.includes("VERSE-TEXT-NOT-ALLOWED"), false);
  });

  it("returns only the video title line from a video passage", () => {
    const reply = replyForSearch("What does the video say about the budget?", {
      kind: "hits",
      hits: [{
        kind: "hit",
        url: "https://video.example/example-community-church/front-door-tour",
        title: "Front door tour",
        pageKind: "video",
        passage: "Video title: Front door tour\nThe doors are red and the budget is discussed.",
      }],
    });
    assert.equal(reply, "Video title: Front door tour");
  });

  it("closes a companion socket when a line exceeds the cap and writes nothing", () => {
    const socket = fakeSocket();
    const transport = socketTransport(socket as unknown as Socket);
    let lines = 0;
    transport.onLine(() => {
      lines += 1;
    });
    socket.push(`${"x".repeat(20_000)}`);
    assert.equal(socket.ended, true);
    assert.equal(lines, 0);
    assert.equal(socket.written, "");
  });
});

function fakeSocket(): {
  ended: boolean;
  written: string;
  setEncoding: () => void;
  on: (event: string, handler: (chunk?: string) => void) => void;
  write: (chunk: string) => void;
  end: () => void;
  destroy: () => void;
  push: (chunk: string) => void;
} {
  let onData: ((chunk: string) => void) | undefined;
  return {
    ended: false,
    written: "",
    setEncoding() {},
    on(event: string, handler: (chunk?: string) => void) {
      if (event === "data") onData = handler as (chunk: string) => void;
    },
    write(chunk: string) {
      this.written += chunk;
    },
    end() {
      this.ended = true;
    },
    destroy() {
      this.ended = true;
    },
    push(chunk: string) {
      onData?.(chunk);
    },
  };
}
