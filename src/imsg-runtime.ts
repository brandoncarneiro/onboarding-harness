import { createServer } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  acceptCompanionHandshake,
  attachImsgIntake,
  ImsgRpcClient,
  issueImsgPairCode,
  socketTransport,
  spawnImsgRpc,
  type StdioTransport,
  type InboundImsg,
} from "./imsg.ts";

export function startImsg(options: {
  mode: "" | "local" | "remote";
  command: string;
  db: DatabaseSync;
  now: () => number;
  pairPort: number;
  receive: (chatId: number, text: string, guid?: string, replyTo?: string) => Promise<string>;
  openLocal?: () => StdioTransport;
  listen?: (port: number, onConnection: (transport: StdioTransport) => void) => void;
  log?: (line: string) => void;
}): void {
  if (options.mode === "") return;
  const receive = async (message: InboundImsg) => options.receive(message.chatId, message.text, message.guid, message.replyTo);
  if (options.mode === "local") {
    let attempts = 0;
    const connect = () => {
      if (attempts++ >= 4) { console.error("imsg reconnect attempts exhausted"); return; }
      try {
        const transport = (options.openLocal ?? (() => spawnImsgRpc(options.command)))();
        let scheduled = false;
        const reconnect = () => {
          if (scheduled) return;
          scheduled = true;
          transport.close();
          const timer = setTimeout(connect, Math.min(1000 * 2 ** (attempts - 1), 8000));
          timer.unref();
        };
        transport.onClose?.(reconnect);
        void attachImsgIntake(new ImsgRpcClient(transport), receive, options.db).catch(reconnect);
      } catch { console.error("imsg is unavailable"); }
    };
    connect();
    return;
  }
  const code = issueImsgPairCode(options.db, options.now());
  (options.log ?? console.log)(`imsg pair code: ${code}`);
  const listen = options.listen ?? listenForImsgCompanion;
  listen(options.pairPort, (transport) => {
    bindCompanion(options.db, options.now, transport, receive);
  });
}

export function bindCompanion(
  db: DatabaseSync,
  now: () => number,
  transport: StdioTransport,
  receive: (message: InboundImsg) => Promise<string>,
): void {
  let paired = false;
  const relay = {
    writeLine(line: string) {
      transport.writeLine(line);
    },
    onLine(handler: (line: string) => void) {
      relay.handler = handler;
    },
    onClose(handler: () => void) { transport.onClose?.(handler); },
    close() {
      transport.close();
    },
    handler: undefined as ((line: string) => void) | undefined,
    receive(line: string) {
      this.handler?.(line);
    },
  };
  transport.onLine((line) => {
    if (!paired) {
      const result = acceptCompanionHandshake(db, now(), line);
      transport.writeLine(result.response);
      if (!result.ok) {
        transport.close();
        return;
      }
      paired = true;
      void attachImsgIntake(new ImsgRpcClient(relay), receive, db).catch(() => {
        console.error("imsg is unavailable");
      });
      return;
    }
    relay.receive(line);
  });
}

function listenForImsgCompanion(port: number, onConnection: (transport: StdioTransport) => void): void {
  const server = createServer((socket) => {
    onConnection(socketTransport(socket));
  });
  server.on("error", () => {
    console.error("imsg companion listener failed");
  });
  server.listen(port);
}
