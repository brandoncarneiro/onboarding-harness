import { join } from "node:path";
import { loadConfig, loadEnvFile } from "./config.ts";
import { createModel } from "./model.ts";
import { openDatabase } from "./db.ts";
import { createHttpServer } from "./http.ts";
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
  messenger: createMessenger(config),
  now: () => Date.now(),
};

const server = createHttpServer(deps);

server.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
