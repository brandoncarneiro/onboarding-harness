import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindByContactDetails, issueLinkCode, linkChannels, redeemLinkCode } from "../src/linkCodes.ts";
import { listRecords, persistIntake, readGroup, readSession } from "../src/recordStore.ts";
import { confirmationIsValid } from "../src/values.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

const sharedContact = {
  name: "Sample Person",
  email: "person@example.com",
  mobile: "555-0100",
};

describe("link codes", () => {
  it("does not link two channels that share a name, email, or mobile", async () => {
    await withHarness(async (harness) => {
      const input = {
        nowIso: "2026-10-26T12:00:00.000Z",
        values: sharedContact,
        pendingHash: null,
        confirmationHash: null,
        save: false,
        fields: harness.schema.fields,
      };
      persistIntake(harness.db, { ...input, channel: "web", channelKey: "web-contact" });
      persistIntake(harness.db, { ...input, channel: "telegram", channelKey: "telegram-contact" });
      const before = harness.snapshot();
      assert.deepEqual(linkChannels(harness.db, {
        channel: "telegram",
        channelKey: "telegram-contact",
        code: null,
        nowMs: harness.deps.now(),
      }), { linked: false });
      assert.deepEqual(bindByContactDetails(sharedContact, sharedContact), { linked: false, wrote: false });
      assert.deepEqual(harness.snapshot(), before);
      assert.notEqual(
        readSession(harness.db, "web", "web-contact")?.groupId,
        readSession(harness.db, "telegram", "telegram-contact")?.groupId,
      );
    });
  });

  it("keeps two saved intakes apart until a one-time code is used", async () => {
    await withHarness(async (harness) => {
      for (const message of [...INTAKE_BEFORE_CONFIRM, "yes"]) {
        await harness.send("web", "web-saved", message);
        await harness.send("telegram", "telegram-saved", message);
      }
      const records = listRecords(harness.db);
      assert.equal(records.length, 2);
      const web = readSession(harness.db, "web", "web-saved");
      const telegram = readSession(harness.db, "telegram", "telegram-saved");
      assert.ok(web && telegram);
      assert.notEqual(web.groupId, telegram.groupId);
      assert.notEqual(records[0]?.groupId, records[1]?.groupId);

      const before = harness.snapshot();
      assert.equal(linkChannels(harness.db, {
        channel: "telegram",
        channelKey: "telegram-saved",
        code: null,
        nowMs: harness.deps.now(),
      }).linked, false);
      assert.equal(bindByContactDetails(
        { email: "person@example.com" },
        { email: "person@example.com" },
      ).wrote, false);
      assert.deepEqual(harness.snapshot(), before);
    });
  });

  it("writes nothing for a bad, conflicting, reused, or expired code", async () => {
    await withHarness(async (harness) => {
      await harness.send("web", "web-link", "Sample One");
      await harness.send("telegram", "telegram-link", "Sample Two");
      const issued = await harness.send("web", "web-link", "link code");
      const code = /One-time link code: ([A-Z2-9]{8})/.exec(issued.reply)?.[1];
      assert.ok(code);

      const beforeBad = harness.snapshot();
      const bad = await harness.send("telegram", "telegram-link", "use code ZZZZZZZZ");
      assert.equal(bad.reply, "That code did not link the chats.");
      assert.deepEqual(harness.snapshot(), beforeBad);
      assert.notEqual(
        readSession(harness.db, "web", "web-link")?.groupId,
        readSession(harness.db, "telegram", "telegram-link")?.groupId,
      );

      const conflict = redeemLinkCode(harness.db, {
        channel: "telegram",
        channelKey: "telegram-link",
        code,
        nowMs: harness.deps.now(),
      });
      assert.equal(conflict.linked, false);
      assert.deepEqual(harness.snapshot(), beforeBad);

      const freshCode = issueLinkCode(harness.db, {
        channel: "web",
        channelKey: "web-empty",
        nowMs: harness.deps.now(),
      });
      const linked = await harness.send("telegram", "telegram-empty", `use code ${freshCode}`);
      assert.equal(linked.reply, "The chats now share one record.");
      const sharedGroup = readSession(harness.db, "web", "web-empty")?.groupId;
      assert.equal(sharedGroup, readSession(harness.db, "telegram", "telegram-empty")?.groupId);

      for (const message of [...INTAKE_BEFORE_CONFIRM, "yes"]) {
        await harness.send("web", "web-empty", message);
      }
      const records = listRecords(harness.db);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.groupId, sharedGroup);
      const group = readGroup(harness.db, sharedGroup ?? "");
      assert.equal(confirmationIsValid(harness.schema.fields, group.values, records[0]?.confirmationHash ?? null), true);
      assert.equal(readSession(harness.db, "telegram", "telegram-empty")?.groupId, sharedGroup);

      const beforeReuse = harness.snapshot();
      const reused = redeemLinkCode(harness.db, {
        channel: "telegram",
        channelKey: "telegram-third",
        code: freshCode,
        nowMs: harness.deps.now(),
      });
      assert.equal(reused.linked, false);
      assert.deepEqual(harness.snapshot(), beforeReuse);
      assert.equal(readSession(harness.db, "telegram", "telegram-third"), undefined);

      const expired = issueLinkCode(harness.db, {
        channel: "web",
        channelKey: "web-expire",
        nowMs: harness.deps.now(),
      });
      const beforeExpired = harness.snapshot();
      const late = redeemLinkCode(harness.db, {
        channel: "telegram",
        channelKey: "telegram-expire",
        code: expired,
        nowMs: harness.deps.now() + 16 * 60 * 1000,
      });
      assert.equal(late.linked, false);
      assert.deepEqual(harness.snapshot(), beforeExpired);
    });
  });
});
