import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadEnvFile } from "./config.ts";
import { beginCompanionPair, socketTransport, spawnImsgRpc } from "./imsg.ts";

export async function runImsgCompanion(config: {
  imsgCommand: string;
  imsgPairHost: string;
  imsgPairPort: number;
  imsgPairCode: string;
}): Promise<void> {
  if (!config.imsgPairHost || !config.imsgPairCode) {
    throw new Error("IMSG_PAIR_HOST and IMSG_PAIR_CODE are required");
  }
  const socket = connect({ host: config.imsgPairHost, port: config.imsgPairPort });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  await beginCompanionPair(spawnImsgRpc(config.imsgCommand), socketTransport(socket), config.imsgPairCode);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  loadEnvFile(join(process.cwd(), ".env"), process.env);
  const config = loadConfig(process.env, process.cwd());
  void runImsgCompanion(config).catch(() => {
    console.error("imsg companion failed");
    process.exitCode = 1;
  });
}
