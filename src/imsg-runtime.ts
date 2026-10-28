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
} from "./imsg.ts";

export function startImsg(options: {
  mode: "" | "local" | "remote";
  command: string;
  db: DatabaseSync;
  now: () => number;
  pairPort: number;
  receive: (chatId: number, text: string) => Promise<string>;
  openLocal?: () => StdioTransport;
  listen?: (port: number, onConnection: (transport: StdioTransport) => void) => void;
  log?: (line: string) => void;
}): void {
  if (options.mode === "") return;
  const receive = async (message: { chatId: number; text: string }) => options.receive(message.chatId, message.text);
  if (options.mode === "local") {
    try {
      const transport = (options.openLocal ?? (() => spawnImsgRpc(options.command)))();
      void attachImsgIntake(new ImsgRpcClient(transport), receive).catch(() => {
        console.error("imsg is unavailable");
      });
    } catch {
      console.error("imsg is unavailable");
    }
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
  receive: (message: { chatId: number; text: string }) => Promise<string>,
): void {
  let paired = false;
  const relay = {
    writeLine(line: string) {
      transport.writeLine(line);
    },
    onLine(handler: (line: string) => void) {
      relay.handler = handler;
    },
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
      void attachImsgIntake(new ImsgRpcClient(relay), receive).catch(() => {
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
