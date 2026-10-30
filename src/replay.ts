import { completeIncoming, prepareIncoming, type AppDeps, type ChatResult, type PreparedIncoming } from './conversation.ts';
import { withTransaction } from './db.ts';
import type { Channel } from './recordStore.ts';

export class RequestIdentityConflict extends Error {}

type Checkpoint = { message: string; prepared_json: string; result_json: string | null; reply_to: string | null };

// Commit the interpretation and intake mutation together. After a crash only
// optional wording is repeated; consent and field answers are never re-applied.
export async function replayIncoming(deps: AppDeps, input: {
  channel: Channel; channelKey: string; requestId: string; message: string; replyTo?: string;
}): Promise<ChatResult> {
  const key = [input.channel, input.channelKey, input.requestId];
  const read = () => deps.db.prepare(`SELECT message, prepared_json, result_json, reply_to FROM incoming_requests
    WHERE channel = ? AND channel_key = ? AND request_id = ?`).get(...key) as Checkpoint | undefined;
  const checkpoint = withTransaction(deps.db, () => {
    const stored = read();
    if (stored) {
      if (stored.message !== input.message || stored.reply_to !== (input.replyTo ?? null)) throw new RequestIdentityConflict();
      return stored;
    }
    const prepared = prepareIncoming(deps, input);
    const preparedJson = JSON.stringify(prepared);
    deps.db.prepare(`INSERT INTO incoming_requests (channel, channel_key, request_id, message, prepared_json, reply_to)
      VALUES (?, ?, ?, ?, ?, ?)`).run(...key, input.message, preparedJson, input.replyTo ?? null);
    return { message: input.message, prepared_json: preparedJson, result_json: null, reply_to: input.replyTo ?? null };
  });
  if (checkpoint.result_json) return JSON.parse(checkpoint.result_json) as ChatResult;
  const result = await completeIncoming(deps, input.message, JSON.parse(checkpoint.prepared_json) as PreparedIncoming);
  // Concurrent responders agree on whichever wording committed first.
  deps.db.prepare(`UPDATE incoming_requests SET result_json = ? WHERE channel = ? AND channel_key = ?
    AND request_id = ? AND result_json IS NULL`).run(JSON.stringify(result), ...key);
  return JSON.parse(read()!.result_json!) as ChatResult;
}
