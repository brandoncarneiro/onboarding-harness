import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { applyIncoming, type AppDeps, type ChatResult } from "../src/conversation.ts";
import { snapshotDatabase, type DatabaseSnapshot, openDatabase } from "../src/db.ts";
import { indexKnowledgeDirectory } from "../src/knowledge.ts";
import type { LanguageModel, ModelRequest, ModelResult } from "../src/model.ts";
import type { OutboundMessenger } from "../src/outbound.ts";
import { loadSchema, type SchemaDocument } from "../src/schema.ts";
import type { Channel } from "../src/recordStore.ts";
import type { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(here, "..");

export class FakeModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];
  private readonly responder: (request: ModelRequest) => string;

  constructor(responder: (request: ModelRequest) => string = () => "You are registered, approved, and signed up.") {
    this.responder = responder;
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    return { text: this.responder(request) };
  }
}

export class RecordingMessenger implements OutboundMessenger {
  readonly sent: { chatId: string; text: string }[] = [];

  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

export type Harness = {
  dir: string;
  db: DatabaseSync;
  deps: AppDeps;
  schema: SchemaDocument;
  model: FakeModel;
  messenger: RecordingMessenger;
  snapshot: () => DatabaseSnapshot;
  send: (channel: Channel, channelKey: string, message: string) => Promise<ChatResult>;
  close: () => void;
};

export function createHarness(now = Date.parse("2026-10-26T12:00:00.000Z")): Harness {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-harness-"));
  const databasePath = join(dir, "test.sqlite");
  const config = loadConfig(
    {
      PORT: "8787",
      DATABASE_PATH: databasePath,
      ORGANIZATION_SCHEMA_PATH: join(projectRoot, "fixtures", "record.schema.json"),
      KNOWLEDGE_DIR: join(projectRoot, "fixtures", "knowledge"),
      TELEGRAM_WEBHOOK_SECRET: "test-secret",
    },
    projectRoot,
  );
  const db = openDatabase(databasePath);
  indexKnowledgeDirectory(db, config.knowledgeDir);
  const schema = loadSchema(config.schemaPath);
  const model = new FakeModel();
  const messenger = new RecordingMessenger();
  const deps: AppDeps = {
    db,
    config,
    model,
    fields: schema.fields,
    messenger,
    now: () => now,
  };
  return {
    dir,
    db,
    deps,
    schema,
    model,
    messenger,
    snapshot: () => snapshotDatabase(db),
    send: (channel, channelKey, message) => applyIncoming(deps, { channel, channelKey, message }),
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const INTAKE_BEFORE_CONFIRM = [
  "Sample Person",
  "person@example.com",
  "555-0100",
  "Sample Organization",
  "Sample City",
  "yes",
];

export async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = createHarness();
  try {
    await run(harness);
  } finally {
    harness.close();
  }
}
