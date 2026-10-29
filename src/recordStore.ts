import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { refuse, withTransaction } from "./db.ts";
import type { FieldSpec } from "./schema.ts";
import { asNullableString, asString, isRecord } from "./util.ts";
import {
  canonicalJson,
  hashValues,
  nextMissing,
  type DraftValues,
} from "./values.ts";

export type Channel = "web" | "telegram" | "imessage";

export type SessionRecord = {
  id: string;
  channel: Channel;
  channelKey: string;
  groupId: string;
};

export type GroupDraft = {
  id: string;
  values: DraftValues;
  pendingHash: string | null;
  confirmationHash: string | null;
  savedRecordId: string | null;
};

export type StoredRecord = {
  id: string;
  groupId: string;
  valuesJson: string;
  confirmationHash: string;
  savedAt: string;
};

export function readSession(db: DatabaseSync, channel: Channel, channelKey: string): SessionRecord | undefined {
  let row = db.prepare(
    `SELECT id, channel, channel_key, group_id FROM sessions WHERE channel = ? AND channel_key = ?`,
  ).get(channel, channelKey);
  if (!row && channel === "telegram" && /^\d+$/.test(channelKey)) {
    // Old installations keyed sessions by chat:user. Reuse the same intake from
    // any chat without deleting old session IDs or their link-code references.
    const legacy = db.prepare(
      `SELECT id, channel, channel_key, group_id FROM sessions
       WHERE channel = 'telegram' AND channel_key LIKE ? ORDER BY created_at, id`,
    ).all(`%:${channelKey}`);
    if (new Set(legacy.map((session) => session.group_id)).size > 1) {
      refuse("legacy Telegram intakes must be reconciled before continuing");
    }
    row = legacy[0];
  }
  if (!row) return undefined;
  const record = row as Record<string, unknown>;
  const foundChannel = asString(record.channel);
  if (foundChannel !== "web" && foundChannel !== "telegram" && foundChannel !== "imessage") {
    throw new Error("unknown channel");
  }
  return {
    id: asString(record.id),
    channel: foundChannel,
    channelKey: asString(record.channel_key),
    groupId: asString(record.group_id),
  };
}

export function readGroup(db: DatabaseSync, groupId: string): GroupDraft {
  const row = db.prepare(
    `SELECT id, draft_json, pending_hash, confirmation_hash, saved_record_id
     FROM session_groups WHERE id = ?`,
  ).get(groupId);
  if (!row) throw new Error("session group is missing");
  const record = row as Record<string, unknown>;
  return {
    id: asString(record.id),
    values: parseValues(asString(record.draft_json)),
    pendingHash: asNullableString(record.pending_hash),
    confirmationHash: asNullableString(record.confirmation_hash),
    savedRecordId: asNullableString(record.saved_record_id),
  };
}

export function listRecords(db: DatabaseSync): StoredRecord[] {
  const rows = db.prepare(
    `SELECT id, group_id, values_json, confirmation_hash, saved_at FROM records ORDER BY rowid`,
  ).all();
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: asString(record.id),
      groupId: asString(record.group_id),
      valuesJson: asString(record.values_json),
      confirmationHash: asString(record.confirmation_hash),
      savedAt: asString(record.saved_at),
    };
  });
}

export function insertConfirmedRecord(
  db: DatabaseSync,
  input: {
    groupId: string;
    values: DraftValues;
    fields: FieldSpec[];
    confirmationHash: string | null;
    nowIso: string;
  },
): string {
  const valuesJson = canonicalJson(input.fields, input.values);
  const digest = hashValues(input.fields, input.values);
  if (!input.confirmationHash || input.confirmationHash !== digest) {
    refuse("record requires a matching confirmation hash");
  }
  if (nextMissing(input.fields, input.values)) {
    refuse("record is incomplete");
  }
  const existing = db.prepare(
    `SELECT id FROM records WHERE group_id = ? AND confirmation_hash = ?`,
  ).get(input.groupId, digest);
  if (existing) return asString((existing as Record<string, unknown>).id);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO records (id, group_id, values_json, confirmation_hash, saved_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.groupId, valuesJson, digest, input.nowIso);
  return id;
}

export function saveConfirmedRecord(
  db: DatabaseSync,
  input: {
    groupId: string;
    values: DraftValues;
    fields: FieldSpec[];
    confirmationHash: string | null;
    nowIso: string;
  },
): string {
  return withTransaction(db, () => insertConfirmedRecord(db, input));
}

export function persistIntake(
  db: DatabaseSync,
  input: {
    channel: Channel;
    channelKey: string;
    nowIso: string;
    values: DraftValues;
    pendingHash: string | null;
    confirmationHash: string | null;
    save: boolean;
    fields: FieldSpec[];
  },
): SessionRecord {
  return withTransaction(db, () => {
    const session = readSession(db, input.channel, input.channelKey) ?? insertSession(db, input);
    writeGroup(db, {
      id: session.groupId,
      values: input.values,
      pendingHash: input.pendingHash,
      confirmationHash: input.confirmationHash,
      savedRecordId: readGroup(db, session.groupId).savedRecordId,
      nowIso: input.nowIso,
    });
    if (input.save) {
      const recordId = insertConfirmedRecord(db, {
        groupId: session.groupId,
        values: input.values,
        fields: input.fields,
        confirmationHash: input.confirmationHash,
        nowIso: input.nowIso,
      });
      db.prepare(`UPDATE session_groups SET saved_record_id = ? WHERE id = ?`).run(recordId, session.groupId);
    }
    return session;
  });
}

export function ensureSession(
  db: DatabaseSync,
  input: { channel: Channel; channelKey: string; nowIso: string },
): SessionRecord {
  return withTransaction(db, () => readSession(db, input.channel, input.channelKey) ?? insertSession(db, input));
}

export function insertSession(
  db: DatabaseSync,
  input: { channel: Channel; channelKey: string; nowIso: string },
): SessionRecord {
  const groupId = randomUUID();
  const sessionId = randomUUID();
  db.prepare(
    `INSERT INTO session_groups (id, draft_json, pending_hash, confirmation_hash, saved_record_id, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?)`,
  ).run(groupId, JSON.stringify({ values: {} }), input.nowIso);
  db.prepare(
    `INSERT INTO sessions (id, channel, channel_key, group_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, input.channel, input.channelKey, groupId, input.nowIso);
  return { id: sessionId, channel: input.channel, channelKey: input.channelKey, groupId };
}

function writeGroup(
  db: DatabaseSync,
  input: GroupDraft & { nowIso: string },
): void {
  db.prepare(
    `UPDATE session_groups
     SET draft_json = ?, pending_hash = ?, confirmation_hash = ?, saved_record_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify({ values: input.values }),
    input.pendingHash,
    input.confirmationHash,
    input.savedRecordId,
    input.nowIso,
    input.id,
  );
}

function parseValues(json: string): DraftValues {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !isRecord(parsed.values)) return {};
  return parsed.values;
}
