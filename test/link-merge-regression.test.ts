import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueLinkCode, redeemLinkCode } from "../src/linkCodes.ts";
import { listRecords, readGroup, readSession } from "../src/recordStore.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

describe("link merge regressions", () => {
  it("invalidates outstanding codes from a group whose sessions have moved", async () => {
    await withHarness(async (harness) => {
      const nowMs = harness.deps.now();
      await harness.send("web", "source", "Sample Person");
      const stale = issueLinkCode(harness.db, { channel: "web", channelKey: "source", nowMs });
      const destination = issueLinkCode(harness.db, { channel: "telegram", channelKey: "destination", nowMs });
      assert.equal(redeemLinkCode(harness.db, {
        channel: "web", channelKey: "source", code: destination, nowMs,
      }).linked, true);
      await harness.send("web", "source", "person@example.com");

      const before = harness.snapshot();
      assert.equal(redeemLinkCode(harness.db, {
        channel: "imessage", channelKey: "late", code: stale, nowMs,
      }).linked, false);
      assert.deepEqual(harness.snapshot(), before);
      assert.equal(readSession(harness.db, "imessage", "late"), undefined);
    });
  });

  for (const savedSide of ["source", "destination", "both"] as const) {
    it(`preserves saved state and every record when ${savedSide} is saved`, async () => {
      await withHarness(async (harness) => {
        for (const message of INTAKE_BEFORE_CONFIRM) {
          await harness.send("web", "source", message);
          await harness.send("telegram", "destination", message);
        }
        if (savedSide !== "destination") await harness.send("web", "source", "yes");
        if (savedSide !== "source") await harness.send("telegram", "destination", "yes");
        const recordsBefore = listRecords(harness.db);
        const code = issueLinkCode(harness.db, {
          channel: "telegram", channelKey: "destination", nowMs: harness.deps.now(),
        });
        assert.equal(redeemLinkCode(harness.db, {
          channel: "web", channelKey: "source", code, nowMs: harness.deps.now(),
        }).linked, true);

        const destination = readSession(harness.db, "telegram", "destination");
        assert.ok(destination);
        assert.equal(readSession(harness.db, "web", "source")?.groupId, destination.groupId);
        const merged = readGroup(harness.db, destination.groupId);
        assert.ok(merged.savedRecordId);
        assert.ok(merged.confirmationHash);
        assert.equal((await harness.send("web", "source", "start")).status, "saved");
        const recordsAfter = listRecords(harness.db);
        assert.deepEqual(recordsAfter.map((record) => record.id), recordsBefore.map((record) => record.id));
        assert.equal(recordsAfter.every((record) => record.groupId === destination.groupId), true);
        assert.equal(recordsAfter.some((record) => record.id === merged.savedRecordId), true);
      });
    });
  }

  it("keeps conflicting drafts and their unused codes unchanged", async () => {
    await withHarness(async (harness) => {
      await harness.send("web", "source", "Sample One");
      await harness.send("telegram", "destination", "Sample Two");
      const code = issueLinkCode(harness.db, {
        channel: "telegram", channelKey: "destination", nowMs: harness.deps.now(),
      });
      const before = harness.snapshot();
      assert.equal(redeemLinkCode(harness.db, {
        channel: "web", channelKey: "source", code, nowMs: harness.deps.now(),
      }).linked, false);
      assert.deepEqual(harness.snapshot(), before);
    });
  });
});

describe("optional boolean confirmation", () => {
  for (const answer of [undefined, false] as const) {
    it(`confirms and stores an ${answer === undefined ? "unanswered" : "explicitly false"} boolean distinctly`, async () => {
      await withHarness(async (harness) => {
        harness.deps.fields.push({ path: "mailings", title: "Mailings", type: "boolean", required: false });
        let summary;
        for (const message of INTAKE_BEFORE_CONFIRM) summary = await harness.send("web", "optional", message);
        if (answer === false) summary = await harness.send("web", "optional", "change mailings to no");
        assert.ok(summary);
        assert.match(summary.reply, answer === undefined ? /Mailings: not answered/ : /Mailings: no\n/);
        await harness.send("web", "optional", "yes");
        assert.equal(JSON.parse(listRecords(harness.db)[0]?.valuesJson ?? "{}").mailings, answer ?? null);
      });
    });
  }
});
