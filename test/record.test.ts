import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords, persistIntake, readGroup, readSession, saveConfirmedRecord } from "../src/recordStore.ts";
import { confirmationIsValid, hashValues } from "../src/values.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

const confirmedValues = {
  name: "Sample Person",
  email: "person@example.com",
  mobile: "555-0100",
  organizationName: "Sample Organization",
  city: "Sample City",
  agreements: { storeDetails: true },
};

describe("record confirmation", () => {
  it("asks for the first field on start and does not store that command", async () => {
    await withHarness(async (harness) => {
      const opening = await harness.send("telegram", "1", "/start");
      assert.equal(opening.reply, "What is your Name?");
      assert.deepEqual(opening.draft, {});
      assert.equal(opening.status, "collecting");
      const name = await harness.send("telegram", "1", "Sample Person");
      assert.match(name.reply, /What is your Email/);
      assert.equal(name.draft.name, "Sample Person");
      assert.equal(listRecords(harness.db).length, 0);

      const beforeResume = harness.snapshot();
      const resumed = await harness.send("telegram", "1", "start");
      assert.equal(resumed.reply, "What is your Email?");
      assert.equal(resumed.draft.name, "Sample Person");
      assert.equal(resumed.draft.email, undefined);
      assert.deepEqual(harness.snapshot(), beforeResume);
    });
  });

  it("requires the example fields, including the agreements the schema marks required", async () => {
    await withHarness(async (harness) => {
      assert.deepEqual(
        harness.schema.fields.filter((field) => field.required).map((field) => field.path),
        ["name", "email", "mobile", "organizationName", "city", "agreements.storeDetails"],
      );
    });
  });

  it("does not save a record without a matching confirmation hash", async () => {
    await withHarness(async (harness) => {
      persistIntake(harness.db, {
        channel: "web",
        channelKey: "hash-gate",
        nowIso: "2026-10-26T12:00:00.000Z",
        values: {},
        pendingHash: null,
        confirmationHash: null,
        save: false,
        fields: harness.schema.fields,
      });
      const session = readSession(harness.db, "web", "hash-gate");
      assert.ok(session);
      const before = harness.snapshot();
      assert.throws(
        () => saveConfirmedRecord(harness.db, {
          groupId: session.groupId,
          values: confirmedValues,
          fields: harness.schema.fields,
          confirmationHash: "not-the-hash",
          nowIso: "2026-10-26T12:00:00.000Z",
        }),
        /matching confirmation hash/,
      );
      assert.deepEqual(harness.snapshot(), before);
      assert.equal(listRecords(harness.db).length, 0);
    });
  });

  it("saves only the confirmed set, and an edit invalidates that confirmation", async () => {
    await withHarness(async (harness) => {
      let last = await harness.send("web", "edit-gate", INTAKE_BEFORE_CONFIRM[0] ?? "");
      for (const message of INTAKE_BEFORE_CONFIRM.slice(1)) {
        last = await harness.send("web", "edit-gate", message);
        assert.notEqual(last.status, "saved");
        assert.doesNotMatch(last.reply, /registered|approved|signed up/i);
      }
      assert.match(last.reply, /Confirm this exact set of details/);
      assert.match(last.reply, /Sample City/);
      assert.equal(listRecords(harness.db).length, 0);

      const saved = await harness.send("web", "edit-gate", "yes");
      assert.equal(saved.reply, "The details are saved.");
      assert.equal(saved.status, "saved");
      const [record] = listRecords(harness.db);
      assert.ok(record);
      assert.equal(record.valuesJson, JSON.stringify(confirmedValues));
      assert.equal(record.confirmationHash, hashValues(harness.schema.fields, saved.draft));

      const oldHash = record.confirmationHash;
      const edited = await harness.send("web", "edit-gate", "change city to Other City");
      assert.equal(edited.status, "awaiting_confirmation");
      assert.match(edited.reply, /Other City/);
      assert.doesNotMatch(edited.reply, /The details are saved/);
      const session = readSession(harness.db, "web", "edit-gate");
      assert.ok(session);
      const group = readGroup(harness.db, session.groupId);
      assert.equal(group.confirmationHash, null);
      assert.equal(confirmationIsValid(harness.schema.fields, group.values, oldHash), false);
      assert.notEqual(hashValues(harness.schema.fields, group.values), oldHash);
      assert.equal(listRecords(harness.db).length, 1);
      assert.equal(JSON.parse(record.valuesJson).city, "Sample City");

      const beforeRejected = harness.snapshot();
      assert.throws(
        () => saveConfirmedRecord(harness.db, {
          groupId: group.id,
          values: group.values,
          fields: harness.schema.fields,
          confirmationHash: oldHash,
          nowIso: "2026-10-26T12:01:00.000Z",
        }),
        /matching confirmation hash/,
      );
      assert.deepEqual(harness.snapshot(), beforeRejected);

      const again = await harness.send("web", "edit-gate", "yes");
      assert.equal(again.reply, "The details are saved.");
      const records = listRecords(harness.db);
      assert.equal(records.length, 2);
      assert.equal(JSON.parse(records[0]?.valuesJson ?? "{}").city, "Sample City");
      assert.equal(JSON.parse(records[1]?.valuesJson ?? "{}").city, "Other City");
      assert.notEqual(records[0]?.confirmationHash, records[1]?.confirmationHash);
      assert.equal(records[1]?.confirmationHash, hashValues(harness.schema.fields, again.draft));
    });
  });
});
