import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { CheckFailed } from "./errors.ts";
import { generateLinkCode } from "./linkCodes.ts";
import { secretMatches } from "./secrets.ts";
import { asNullableString, asString, isRecord } from "./util.ts";

const PAIR_TTL_MS = 15 * 60 * 1000;

export const IMSG_METHODS = [
  "chats.list",
  "messages.history",
  "watch.subscribe",
  "watch.unsubscribe",
  "send",
] as const;

const ALLOWED = new Set<string>(IMSG_METHODS);

export type ImsgMethod = (typeof IMSG_METHODS)[number];

export type StdioTransport = {
  writeLine(line: string): void;
  onLine(handler: (line: string) => void): void;
  close(): void;
};

export type RpcNotification = {
  method: string;
  params: unknown;
};

export class ScriptedStdio implements StdioTransport {
  readonly written: string[] = [];
  private handler: ((line: string) => void) | undefined;
  private closed = false;

  writeLine(line: string): void {
    if (this.closed) return;
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  receive(line: string): void {
    if (!this.closed) this.handler?.(line);
  }

  close(): void {
    this.closed = true;
  }
}

export function imsgRpcCommand(binary = "imsg"): { command: string; args: readonly ["rpc"] } {
  return { command: binary, args: ["rpc"] };
}

export function encodeImsgRequest(
  method: string,
  params: Record<string, string | number | boolean>,
  id: string,
): string {
  if (!ALLOWED.has(method)) throw new Error("imsg method is not allowed");
  const body = method === "send" ? { ...params, transport: "applescript" } : params;
  if (method === "send" && "file" in body) throw new Error("imsg send is text only");
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: body });
}

export class ImsgRpcClient {
  private nextId = 1;
  private readonly transport: StdioTransport;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly notifications = new Set<(note: RpcNotification) => void>();

  constructor(transport: StdioTransport) {
    this.transport = transport;
    transport.onLine((line) => this.onLine(line));
  }

  chats(limit = 20): Promise<{ chats: unknown[] }> {
    return this.call("chats.list", { limit });
  }

  history(chatId: number, limit = 20): Promise<{ messages: unknown[] }> {
    assertPositiveInt(chatId, "chat_id");
    return this.call("messages.history", { chat_id: chatId, limit });
  }

  watch(options?: { chatId?: number; sinceRowid?: number }): Promise<{ subscription: number }> {
    const params: Record<string, number> = { since_rowid: options?.sinceRowid ?? 0 };
    if (options?.chatId !== undefined) {
      assertPositiveInt(options.chatId, "chat_id");
      params.chat_id = options.chatId;
    }
    return this.call("watch.subscribe", params);
  }

  unwatch(subscription: number): Promise<{ ok: boolean }> {
    assertPositiveInt(subscription, "subscription");
    return this.call("watch.unsubscribe", { subscription });
  }

  sendText(input: { chatId?: number; to?: string; text: string }): Promise<{ ok: boolean }> {
    const hasChat = input.chatId !== undefined;
    const hasTo = input.to !== undefined && input.to !== "";
    if (hasChat === hasTo) throw new Error("imsg send needs one target");
    const params: Record<string, string | number | boolean> = { text: input.text };
    if (input.chatId !== undefined) {
      assertPositiveInt(input.chatId, "chat_id");
      params.chat_id = input.chatId;
    } else if (input.to) {
      params.to = input.to;
    }
    return this.call("send", params);
  }

  onNotification(handler: (note: RpcNotification) => void): void {
    this.notifications.add(handler);
  }

  private call<T>(method: ImsgMethod, params: Record<string, string | number | boolean>): Promise<T> {
    const id = String(this.nextId);
    this.nextId += 1;
    const line = encodeImsgRequest(method, params, id);
    this.transport.writeLine(line);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (typeof parsed.method === "string" && parsed.id === undefined) {
      const note = { method: parsed.method, params: parsed.params };
      for (const handler of this.notifications) handler(note);
      return;
    }
    if (parsed.id === undefined || parsed.id === null) return;
    const pending = this.pending.get(String(parsed.id));
    if (!pending) return;
    this.pending.delete(String(parsed.id));
    if (parsed.error !== undefined) {
      pending.reject(new Error("imsg request failed"));
      return;
    }
    pending.resolve(parsed.result);
  }
}

export type InboundImsg = {
  chatId: number;
  text: string;
  guid?: string;
};

export function inboundFromNotification(note: RpcNotification): InboundImsg | null {
  if (note.method !== "message" || !isRecord(note.params) || !isRecord(note.params.message)) return null;
  const message = note.params.message;
  if (message.type === "edited" || message.type === "unsent") return null;
  if (message.is_from_me !== false) return null;
  // imsg can emit is_group=false with empty routing fields when chat lookup is
  // unavailable. Require positive direct-chat metadata before touching intake.
  if (message.is_group !== false) return null;
  if (typeof message.chat_identifier !== "string" || !message.chat_identifier.trim()
    || message.chat_identifier.includes(";+;")) return null;
  if (typeof message.chat_guid !== "string" || !/^[^;\s]+;-;[^;\s]+$/.test(message.chat_guid)) return null;
  if (!Array.isArray(message.participants) || message.participants.length !== 1) return null;
  const participant: unknown = message.participants[0];
  if (typeof participant !== "string" || !participant.trim() || participant !== message.sender) return null;
  if (typeof message.text !== "string" || !message.text.trim()) return null;
  if (!isPositiveInt(message.chat_id)) return null;
  const guid = typeof message.guid === "string" && message.guid ? message.guid : undefined;
  return guid === undefined
    ? { chatId: message.chat_id, text: message.text }
    : { chatId: message.chat_id, text: message.text, guid };
}

export async function attachImsgIntake(
  client: ImsgRpcClient,
  receive: (message: InboundImsg) => Promise<string>,
): Promise<void> {
  const seenGuids = new Set<string>();
  client.onNotification((note) => {
    if (note.method === "watch.overflow" && isRecord(note.params) && isPositiveInt(note.params.resume_after_rowid)) {
      void client.watch({ sinceRowid: note.params.resume_after_rowid }).catch(() => {
        console.error("imsg is unavailable");
      });
      return;
    }
    const inbound = inboundFromNotification(note);
    if (!inbound) return;
    if (inbound.guid) {
      if (seenGuids.has(inbound.guid)) return;
      seenGuids.add(inbound.guid);
    }
    void receive(inbound)
      .then((reply) => client.sendText({ chatId: inbound.chatId, text: reply }))
      .catch(() => {
        console.error("imsg is unavailable");
      });
  });
  await client.watch();
}

export function issueImsgPairCode(db: DatabaseSync, nowMs: number): string {
  return withTransaction(db, () => {
    const code = generateLinkCode();
    const createdAt = new Date(nowMs).toISOString();
    db.prepare(
      `INSERT INTO imsg_pair_codes (code, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)`,
    ).run(code, createdAt, new Date(nowMs + PAIR_TTL_MS).toISOString());
    return code;
  });
}

export function acceptImsgPairCode(db: DatabaseSync, nowMs: number, code: string): boolean {
  try {
    withTransaction(db, () => {
      const normalized = code.trim().toUpperCase();
      const row = db.prepare(
        `SELECT code, expires_at, used_at FROM imsg_pair_codes WHERE code = ?`,
      ).get(normalized);
      if (!row) throw new CheckFailed("unknown imsg pair code");
      const record = row as Record<string, unknown>;
      if (asNullableString(record.used_at)) throw new CheckFailed("used imsg pair code");
      const nowIso = new Date(nowMs).toISOString();
      if (asString(record.expires_at) <= nowIso) throw new CheckFailed("expired imsg pair code");
      const stored = asString(record.code);
      if (!secretMatches(normalized, stored)) throw new CheckFailed("imsg pair code mismatch");
      db.prepare(`UPDATE imsg_pair_codes SET used_at = ? WHERE code = ?`).run(nowIso, stored);
    });
    return true;
  } catch (error) {
    if (error instanceof CheckFailed) return false;
    throw error;
  }
}

export function acceptCompanionHandshake(
  db: DatabaseSync,
  nowMs: number,
  firstLine: string,
): { ok: boolean; response: string } {
  let code: string | null = null;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (isRecord(parsed) && parsed.type === "pair" && typeof parsed.code === "string") code = parsed.code;
  } catch {
    code = null;
  }
  if (!code || !acceptImsgPairCode(db, nowMs, code)) {
    return { ok: false, response: JSON.stringify({ type: "rejected" }) };
  }
  return { ok: true, response: JSON.stringify({ type: "paired", code }) };
}

export function beginCompanionPair(local: StdioTransport, remote: StdioTransport, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const buffered: string[] = [];
    let paired = false;
    let rejected = false;
    local.onLine((line) => {
      if (rejected) return;
      if (paired) remote.writeLine(line);
      else buffered.push(line);
    });
    remote.onLine((line) => {
      if (rejected) return;
      if (!paired) {
        if (!isExactPairAck(line, code)) {
          rejected = true;
          buffered.length = 0;
          local.close();
          remote.close();
          reject(new Error("imsg pair was rejected"));
          return;
        }
        paired = true;
        for (const item of buffered) remote.writeLine(item);
        resolve();
        return;
      }
      const forwarded = forwardCompanionCommand(line);
      if (forwarded) local.writeLine(forwarded);
    });
    remote.writeLine(JSON.stringify({ type: "pair", code }));
  });
}

export function spawnImsgRpc(binary = "imsg"): StdioTransport {
  const spec = imsgRpcCommand(binary);
  const child = spawn(spec.command, [...spec.args], { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", () => {
    console.error("imsg is unavailable");
  });
  return new ChildStdioTransport(child);
}

export const COMPANION_LINE_CAP = 16_384;

export function appendCompanionChunk(
  buffer: string,
  chunk: string,
): { buffer: string; lines: string[]; overflow: boolean } {
  let rest = buffer + chunk;
  const lines: string[] = [];
  while (rest.length > 0) {
    const index = rest.indexOf("\n");
    if (index < 0) {
      if (Buffer.byteLength(rest, "utf8") > COMPANION_LINE_CAP) return { buffer: "", lines, overflow: true };
      return { buffer: rest, lines, overflow: false };
    }
    if (Buffer.byteLength(rest.slice(0, index), "utf8") > COMPANION_LINE_CAP) return { buffer: "", lines, overflow: true };
    const line = rest.slice(0, index).replace(/\r$/, "");
    if (line) lines.push(line);
    rest = rest.slice(index + 1);
  }
  return { buffer: "", lines, overflow: false };
}

export function socketTransport(socket: Socket): StdioTransport {
  const transport = new ScriptedStdio();
  let buffer = "";
  let closed = false;
  const markClosed = () => {
    closed = true;
    buffer = "";
    transport.close();
  };
  const close = () => {
    if (closed) return;
    markClosed();
    socket.destroy();
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    if (closed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const fed = appendCompanionChunk(buffer, text);
    buffer = fed.buffer;
    if (fed.overflow) {
      close();
      return;
    }
    for (const line of fed.lines) transport.receive(line);
  });
  socket.on("error", close);
  socket.on("close", markClosed);
  return {
    writeLine: (line) => {
      if (!closed) socket.write(`${line}\n`);
    },
    onLine: (handler) => transport.onLine(handler),
    close,
  };
}

function isExactPairAck(line: string, code: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) && Object.keys(parsed).length === 2 && parsed.type === "paired"
      && typeof parsed.code === "string" && secretMatches(parsed.code, code);
  } catch {
    return false;
  }
}

export function forwardCompanionCommand(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.method !== "string" || !ALLOWED.has(parsed.method)) return null;
  if (parsed.method === "send" && isRecord(parsed.params)) {
    const params = { ...parsed.params };
    delete params.file;
    params.transport = "applescript";
    parsed.params = params;
    return JSON.stringify(parsed);
  }
  return line;
}

class ChildStdioTransport implements StdioTransport {
  private readonly child: ChildProcess;
  private handler: ((line: string) => void) | undefined;
  private buffer = "";

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.handler?.(line);
        index = this.buffer.indexOf("\n");
      }
    });
  }

  writeLine(line: string): void {
    this.child.stdin?.write(`${line}\n`);
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.child.kill();
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!isPositiveInt(value)) throw new Error(`${label} must be a positive integer`);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
