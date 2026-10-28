import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { refuse, withTransaction } from "./db.ts";
import { CheckFailed } from "./errors.ts";
import {
  insertSession,
  readGroup,
  readSession,
  type Channel,
  type GroupDraft,
} from "./recordStore.ts";
import { asNullableString, asString } from "./util.ts";
import { isEmptyValues, stableJson, type DraftValues } from "./values.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60 * 1000;

export function generateLinkCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    const char = ALPHABET[randomInt(ALPHABET.length)];
    if (!char) throw new Error("link code alphabet is empty");
    code += char;
  }
  return code;
}

export function linkIssuedText(code: string): string {
  return `One-time link code: ${code}. Enter it in the other chat as: use code ${code}. A name, email, or mobile number does not link chats.`;
}

export function issueLinkCode(
  db: DatabaseSync,
  input: { channel: Channel; channelKey: string; nowMs: number },
): string {
  return withTransaction(db, () => {
    const nowIso = new Date(input.nowMs).toISOString();
    const session = readSession(db, input.channel, input.channelKey) ?? insertSession(db, {
      channel: input.channel,
      channelKey: input.channelKey,
      nowIso,
    });
    const code = generateLinkCode();
    db.prepare(
      `INSERT INTO link_codes (code, group_id, session_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      code,
      session.groupId,
      session.id,
      nowIso,
      new Date(input.nowMs + CODE_TTL_MS).toISOString(),
    );
    return code;
  });
}

export function redeemLinkCode(
  db: DatabaseSync,
  input: { channel: Channel; channelKey: string; code: string; nowMs: number },
): { linked: boolean } {
  try {
    withTransaction(db, () => {
      const code = input.code.trim().toUpperCase();
      const row = db.prepare(
        `SELECT code, group_id, session_id, expires_at, used_at FROM link_codes WHERE code = ?`,
      ).get(code);
      if (!row) refuse("unknown link code");
      const link = row as Record<string, unknown>;
      if (asNullableString(link.used_at)) refuse("used link code");
      const nowIso = new Date(input.nowMs).toISOString();
      if (asString(link.expires_at) <= nowIso) refuse("expired link code");
      const session = readSession(db, input.channel, input.channelKey) ?? insertSession(db, {
        channel: input.channel,
        channelKey: input.channelKey,
        nowIso,
      });
      const issuerGroupId = asString(link.group_id);
      if (session.groupId === issuerGroupId) {
        db.prepare(`UPDATE link_codes SET used_at = ? WHERE code = ?`).run(nowIso, code);
        return;
      }
      const sourceGroupId = session.groupId;
      const issuer = readGroup(db, issuerGroupId);
      const redeemer = readGroup(db, sourceGroupId);
      if (draftsConflict(issuer.values, redeemer.values)) refuse("drafts conflict");
      const merged = (isEmptyValues(issuer.values) && !isEmptyValues(redeemer.values)) ||
        (!issuer.confirmationHash && redeemer.confirmationHash) ? redeemer : issuer;
      copyGroup(db, issuerGroupId, {
        ...merged,
        savedRecordId: merged.savedRecordId ?? issuer.savedRecordId ?? redeemer.savedRecordId,
      }, nowIso);
      db.prepare(`UPDATE records SET group_id = ? WHERE group_id = ?`).run(issuerGroupId, sourceGroupId);
      db.prepare(`UPDATE sessions SET group_id = ? WHERE group_id = ?`).run(issuerGroupId, sourceGroupId);
      db.prepare(`UPDATE link_codes SET used_at = ? WHERE group_id = ? AND used_at IS NULL`).run(nowIso, sourceGroupId);
      db.prepare(`UPDATE link_codes SET used_at = ? WHERE code = ?`).run(nowIso, code);
    });
    return { linked: true };
  } catch (error) {
    if (error instanceof CheckFailed) return { linked: false };
    throw error;
  }
}

export function linkChannels(
  db: DatabaseSync,
  input: { channel: Channel; channelKey: string; code: string | null; nowMs: number },
): { linked: boolean } {
  if (!input.code) return { linked: false };
  return redeemLinkCode(db, {
    channel: input.channel,
    channelKey: input.channelKey,
    code: input.code,
    nowMs: input.nowMs,
  });
}

export function bindByContactDetails(
  _left: { name?: string; email?: string; mobile?: string },
  _right: { name?: string; email?: string; mobile?: string },
): { linked: false; wrote: false } {
  return { linked: false, wrote: false };
}

function draftsConflict(left: DraftValues, right: DraftValues): boolean {
  if (isEmptyValues(left) || isEmptyValues(right)) return false;
  return stableJson(left) !== stableJson(right);
}

function copyGroup(db: DatabaseSync, groupId: string, source: GroupDraft, nowIso: string): void {
  db.prepare(
    `UPDATE session_groups
     SET draft_json = ?, pending_hash = ?, confirmation_hash = ?, saved_record_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify({ values: source.values }),
    source.pendingHash,
    source.confirmationHash,
    source.savedRecordId,
    nowIso,
    groupId,
  );
}
