import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, it } from "node:test";
import {
  acceptCompanionHandshake,
  beginCompanionPair,
  issueImsgPairCode,
  socketTransport,
  type StdioTransport,
} from "../src/imsg.ts";
import { withHarness } from "./helpers.ts";

const SEND = JSON.stringify({ jsonrpc: "2.0", id: "send-1", method: "send", params: { chat_id: 7, text: "hello", transport: "bridge" } });

class QueuedStdio implements StdioTransport {
  readonly written: string[] = [];
  closes = 0;
  private handler: ((line: string) => void) | undefined;
  writeLine(line: string): void { this.written.push(line); }
  onLine(handler: (line: string) => void): void { this.handler = handler; }
  close(): void { this.closes += 1; }
  receiveQueued(line: string): void { this.handler?.(line); }
}

class QueuedSocket extends EventEmitter {
  destroyed = false;
  readonly written: string[] = [];
  setEncoding(): this { return this; }
  write(line: string): boolean { this.written.push(line); return true; }
  end(): this { return this; }
  destroy(): this { this.destroyed = true; this.emit("close"); return this; }
}

describe("companion transport regressions", () => {
  it("returns and requires the companion's exact pairing code", async () => {
    await withHarness(async (harness) => {
      const code = issueImsgPairCode(harness.db, harness.deps.now());
      const handshake = acceptCompanionHandshake(harness.db, harness.deps.now(), JSON.stringify({ type: "pair", code }));
      assert.deepEqual(JSON.parse(handshake.response), { type: "paired", code });
      const local = new QueuedStdio();
      const remote = new QueuedStdio();
      const pairing = beginCompanionPair(local, remote, code);
      remote.receiveQueued(handshake.response);
      await pairing;
      remote.receiveQueued(SEND);
      const sent = JSON.parse(local.written[0] ?? "{}");
      assert.equal(sent.params?.transport, "applescript");
    });
  });

  for (const [name, firstLine] of [
    ["bare acknowledgment", '{"type":"paired"}'],
    ["wrong pairing code", '{"type":"paired","code":"WRONG234"}'],
    ["extra-field acknowledgment", '{"type":"paired","code":"ABCD2345","method":"send"}'],
    ["malformed acknowledgment", "not-json"],
  ]) {
    it(`terminally rejects a ${name}`, async () => {
      const local = new QueuedStdio();
      const remote = new QueuedStdio();
      const pairing = beginCompanionPair(local, remote, "ABCD2345");
      remote.receiveQueued(firstLine!);
      await assert.rejects(pairing, /rejected/);
      remote.receiveQueued('{"type":"paired","code":"ABCD2345"}');
      remote.receiveQueued(SEND);
      local.receiveQueued("queued child output");
      assert.deepEqual(local.written, []);
      assert.deepEqual(remote.written, ['{"type":"pair","code":"ABCD2345"}']);
      assert.equal(local.closes, 1);
      assert.equal(remote.closes, 1);
    });
  }

  it("preserves command restrictions after a code-matching acknowledgment", async () => {
    const local = new QueuedStdio();
    const remote = new QueuedStdio();
    const pairing = beginCompanionPair(local, remote, "ABCD2345");
    remote.receiveQueued('{"type":"paired","code":"ABCD2345"}');
    await pairing;
    for (const method of ["typing", "read", "send.tracked", "send.attachment"]) {
      remote.receiveQueued(JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} }));
    }
    assert.deepEqual(local.written, []);
    remote.receiveQueued(JSON.stringify({ jsonrpc: "2.0", id: "send", method: "send", params: { chat_id: 7, text: "hello", file: "/tmp/private", transport: "bridge" } }));
    assert.deepEqual(JSON.parse(local.written[0] ?? "{}"), { jsonrpc: "2.0", id: "send", method: "send", params: { chat_id: 7, text: "hello", transport: "applescript" } });
  });

  it("handles socket errors and ignores queued reads and later writes", () => {
    const socket = new QueuedSocket();
    const transport = socketTransport(socket as unknown as Socket);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    assert.doesNotThrow(() => socket.emit("error", new Error("synthetic connection reset")));
    socket.emit("data", "queued input\n");
    transport.writeLine("later output");
    assert.equal(socket.destroyed, true);
    assert.deepEqual(lines, []);
    assert.deepEqual(socket.written, []);
  });

  for (const [name, chunks] of [
    ["ASCII", ["x".repeat(16_384), "x"]],
    ["UTF-8", ["é".repeat(8192), "é"]],
    ["terminated UTF-8", ["é".repeat(8193) + "\n"]],
  ] as const) {
    it(`destroys an oversized ${name} line and ignores all later input`, () => {
      const socket = new QueuedSocket();
      const transport = socketTransport(socket as unknown as Socket);
      const lines: string[] = [];
      transport.onLine((line) => lines.push(line));
      for (const chunk of chunks) socket.emit("data", chunk);
      socket.emit("data", "queued input\n");
      transport.writeLine("later output");
      assert.equal(socket.destroyed, true);
      assert.deepEqual(lines, []);
      assert.deepEqual(socket.written, []);
    });
  }

  it("accepts a UTF-8 line exactly at the byte limit across chunks", () => {
    const socket = new QueuedSocket();
    const transport = socketTransport(socket as unknown as Socket);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    socket.emit("data", "é".repeat(4096));
    socket.emit("data", "é".repeat(4096) + "\n");
    assert.deepEqual(lines, ["é".repeat(8192)]);
    assert.equal(socket.destroyed, false);
  });
});
