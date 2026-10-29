import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatch } from "../src/http.ts";
import { issueLinkCode, redeemLinkCode } from "../src/linkCodes.ts";
import { listRecords, readGroup, readSession } from "../src/recordStore.ts";
import { replyForSearch } from "../src/grounding.ts";
import { scriptureReply } from "../src/scripture.ts";
import { canonicalJson, confirmationSummary, parseFieldInput, type DraftValues } from "../src/values.ts";
import type { FieldSpec } from "../src/schema.ts";
import type { OutboundMessenger } from "../src/outbound.ts";
import { FakeModel, INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

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

});
