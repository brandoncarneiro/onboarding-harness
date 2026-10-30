import { join } from "node:path";
import { loadConfig, loadEnvFile } from "./config.ts";
import { replayIncoming } from "./replay.ts";
import { createModel } from "./model.ts";
import { openDatabase } from "./db.ts";
import { createHttpServer } from "./http.ts";
import { startImsg } from "./imsg-runtime.ts";
import { indexKnowledgeDirectory } from "./knowledge.ts";
import { createMessenger } from "./outbound.ts";
import { loadSchema } from "./schema.ts";

loadEnvFile(join(process.cwd(), ".env"), process.env);
const config = loadConfig(process.env, process.cwd());
const db = openDatabase(config.databasePath);
const schema = loadSchema(config.schemaPath);
indexKnowledgeDirectory(db, config.knowledgeDir);

const deps = {
  db,
  config,
  model: createModel(config),
  fields: schema.fields,
  organizationName: schema.title,
  messenger: createMessenger(config),
  now: () => Date.now(),
};

startImsg({
  mode: config.imsgMode,
  command: config.imsgCommand,
  db,
  now: deps.now,
  pairPort: config.imsgPairPort,
  receive: async (_chatId, text, guid, replyTo) => {
    if (!guid || !replyTo) throw new Error("iMessage identity and recipient required");
    const result = await replayIncoming(deps, {
      requestId: guid,
      channel: "imessage",
      channelKey: replyTo,
      replyTo,
      message: text,
    });
    return result.reply;
  },
});

const server = createHttpServer(deps);

server.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
