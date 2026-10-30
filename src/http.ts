import { replayIncoming, RequestIdentityConflict } from "./replay.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { prepareIncoming, completeIncoming, type AppDeps } from "./conversation.ts";
import { readSession, readGroup } from "./recordStore.ts";
import { intakeStatus } from "./values.ts";
import { withTransaction } from "./db.ts";
import { isRecord } from "./util.ts";
import { secretMatches } from "./secrets.ts";
import { MAX_MESSAGE_LENGTH, MESSAGE_TOO_LONG_REPLY } from "./messageLimits.ts";
import { renderPublicPage } from "./publicPage.ts";

export type HttpRequest = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export async function dispatch(deps: AppDeps, request: HttpRequest): Promise<HttpResponse> {
  const method = request.method.toUpperCase();
  if (method === "GET" && request.path === "/health") return json(200, { ok: true });
  if (method === "GET" && (request.path === "/" || request.path === "/index.html")) {
    const html = readFileSync(join(deps.config.publicDir, "index.html"), "utf8");
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
      body: renderPublicPage(html, deps.organizationName ?? "Organization"),
    };
  }
  if (method === "POST" && request.path === "/api/chat") return handleChat(deps, request.body);
  if (method === "POST" && request.path === "/api/telegram/webhook") return handleTelegram(deps, request);
  return json(404, { error: "not found" });
}

export function createHttpServer(deps: AppDeps): Server {
  return createServer((req, res) => {
    void respond(deps, req, res);
  });
}

async function respond(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const response = await dispatch(deps, {
      method: req.method ?? "GET",
      path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
      headers: normalizeHeaders(req.headers),
      body: await readBody(req),
    });
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(error instanceof BodyTooLarge ? 413 : 500, JSON_HEADERS);
    res.end(JSON.stringify({ error: error instanceof BodyTooLarge ? "body too large" : "internal error" }));
  }
}

async function handleChat(deps: AppDeps, rawBody: string): Promise<HttpResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (!isRecord(parsed)) return json(400, { error: "invalid json" });
  const { sessionId, requestId, message } = parsed;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) {
    return json(400, { error: "invalid session" });
  }
  if (typeof message !== "string") return json(400, { error: "invalid message" });
  if (message.length > MAX_MESSAGE_LENGTH) return json(413, { error: MESSAGE_TOO_LONG_REPLY });
  if (!message.trim()) return json(400, { error: "invalid message" });
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) return json(400, { error: "invalid requestId" });
  try {
    const result = await replayIncoming(deps, { channel: "web", channelKey: sessionId, requestId, message });
    return json(200, result);
  } catch (error) {
    if (error instanceof RequestIdentityConflict) return json(409, { error: "requestId already used for another message" });
    throw error;
  }
}

async function handleTelegram(deps: AppDeps, request: HttpRequest): Promise<HttpResponse> {
  if (!secretMatches(request.headers["x-telegram-bot-api-secret-token"], deps.config.telegramWebhookSecret)) {
    return json(401, { error: "unauthorized" });
  }
  const update = parseUpdate(request.body);
  if (update.kind === "invalid") return json(400, { error: "invalid json" });
  if (update.kind === "ignore") return json(200, { ok: true });
  return deliverTelegramUpdate(deps, update);
}

type TelegramUpdate = { updateId: number; sessionKey: string; sendChatId: string; text: string };
type StoredTelegramUpdate = {
  reply: string; chat_id: string; sent_at: string | null; state: string;
  owner: string | null; applied_reply: string | null; checkpoint_version: number;
};

const activeTelegramOwners = new Set<string>();

function ownerIsAlive(owner: string | null): boolean {
  if (!owner) return false;
  const pid = Number(owner.split(":", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return activeTelegramOwners.has(owner);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireAbandonedUpdate(deps: AppDeps, updateId: number, stored: StoredTelegramUpdate, owner: string): boolean {
  if (stored.owner === owner) return true;
  if (ownerIsAlive(stored.owner)) return false;
  return withTransaction(deps.db, () => deps.db.prepare(
    `UPDATE telegram_updates SET owner = ?
     WHERE update_id = ? AND state = ? AND owner IS ? AND sent_at IS NULL`,
  ).run(owner, updateId, stored.state, stored.owner).changes > 0);
}

async function deliverTelegramUpdate(deps: AppDeps, update: TelegramUpdate): Promise<HttpResponse> {
  const existing = readTelegramUpdate(deps, update.updateId);
  if (existing?.sent_at) return json(200, { ok: true, reply: existing.reply });
  const owner = `${process.pid}:${randomUUID()}`;
  activeTelegramOwners.add(owner);
  try {
    if (!existing) {
      withTransaction(deps.db, () => deps.db.prepare(
        `INSERT INTO telegram_updates (update_id, reply, chat_id, state, owner, checkpoint_version)
         VALUES (?, '', ?, 'applying', ?, 1) ON CONFLICT(update_id) DO NOTHING`,
      ).run(update.updateId, update.sendChatId, owner));
    }
    while (true) {
      const stored = readTelegramUpdate(deps, update.updateId);
      if (!stored || stored.state === "failed") return json(500, { error: "telegram update failed" });
      if (stored.sent_at) return json(200, { ok: true, reply: stored.reply });
      if (stored.state === "applying" && acquireAbandonedUpdate(deps, update.updateId, stored, owner)) {
        try {
          if (stored.applied_reply !== null) {
            // Intake already committed. Reuse its checkpoint, never decide again
            // against a draft that may now be awaiting confirmation.
            deps.db.prepare(`UPDATE telegram_updates SET reply = applied_reply, state = 'ready', owner = NULL
              WHERE update_id = ? AND owner = ?`).run(update.updateId, owner);
          } else {
            const prepared = withTransaction(deps.db, () => {
              let message = update.text;
              // Old rows have no atomic checkpoint. A legacy consent that has
              // reached confirmation must be resumed, never treated as a new yes.
              if (stored.checkpoint_version === 0 && message.length <= MAX_MESSAGE_LENGTH && message.trim() === "yes") {
                const session = readSession(deps.db, "telegram", update.sessionKey);
                if (session && intakeStatus(deps.fields, readGroup(deps.db, session.groupId)) === "awaiting_confirmation") {
                  message = "start";
                }
              }
              const result = prepareIncoming(deps, { channel: "telegram", channelKey: update.sessionKey, message });
              deps.db.prepare(`UPDATE telegram_updates SET applied_reply = ?, checkpoint_version = 1
                WHERE update_id = ? AND owner = ?`).run(result.result.reply.trim(), update.updateId, owner);
              return result;
            });
            // No asynchronous work runs inside the intake/checkpoint transaction.
            const result = await completeIncoming(deps, update.text, prepared);
            deps.db.prepare(`UPDATE telegram_updates SET reply = ?, state = 'ready', owner = NULL
              WHERE update_id = ? AND owner = ?`).run(result.reply, update.updateId, owner);
          }
        } catch {
          deps.db.prepare(`UPDATE telegram_updates SET owner = NULL WHERE update_id = ? AND owner = ?`)
            .run(update.updateId, owner);
          return json(500, { error: "telegram update failed" });
        }
        continue;
      }
      const sendClaimed = stored.state === "ready"
        ? withTransaction(deps.db, () => deps.db.prepare(
          `UPDATE telegram_updates SET state = 'sending', owner = ?
           WHERE update_id = ? AND state = 'ready' AND sent_at IS NULL`,
        ).run(owner, update.updateId).changes > 0)
        : stored.state === "sending" && acquireAbandonedUpdate(deps, update.updateId, stored, owner);
      if (sendClaimed) {
        try {
          await deps.messenger.send(stored.chat_id, stored.reply);
        } catch {
          deps.db.prepare(`UPDATE telegram_updates SET state = 'ready', owner = NULL
            WHERE update_id = ? AND owner = ?`).run(update.updateId, owner);
          return json(503, { ok: false });
        }
        deps.db.prepare(`UPDATE telegram_updates SET sent_at = ?, state = 'sent', owner = NULL
          WHERE update_id = ? AND owner = ?`).run(new Date(deps.now()).toISOString(), update.updateId, owner);
        return json(200, { ok: true, reply: stored.reply });
      }
      await delay(10);
    }
  } finally {
    activeTelegramOwners.delete(owner);
  }
}

function readTelegramUpdate(deps: AppDeps, updateId: number): StoredTelegramUpdate | undefined {
  return deps.db.prepare(`SELECT reply, chat_id, sent_at, state, owner, applied_reply, checkpoint_version
    FROM telegram_updates WHERE update_id = ?`).get(updateId) as StoredTelegramUpdate | undefined;
}

function parseUpdate(rawBody: string):
  | { kind: "message"; updateId: number; sessionKey: string; sendChatId: string; text: string }
  | { kind: "ignore" }
  | { kind: "invalid" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.message)) return { kind: "ignore" };
  if (typeof parsed.update_id !== "number" || !Number.isSafeInteger(parsed.update_id)) return { kind: "ignore" };
  const message = parsed.message;
  if (!isRecord(message.chat)) return { kind: "ignore" };
  const chatId = message.chat.id;
  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) return { kind: "ignore" };
  if (typeof message.text !== "string" || !message.text.trim()) return { kind: "ignore" };
  const senderId = isRecord(message.from) && typeof message.from.id === "number" && Number.isSafeInteger(message.from.id)
    ? String(message.from.id)
    : undefined;
  const chatType = typeof message.chat.type === "string" ? message.chat.type : undefined;
  const chatKey = String(chatId);
  const group = chatType === "group" || chatType === "supergroup" || chatId < 0;
  return {
    kind: "message",
    updateId: parsed.update_id,
    sessionKey: senderId ?? chatKey,
    sendChatId: group && senderId !== undefined ? senderId : chatKey,
    text: message.text,
  };
}

function json(status: number, payload: unknown): HttpResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return normalized;
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new BodyTooLarge("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
