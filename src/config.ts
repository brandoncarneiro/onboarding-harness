import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AppConfig = {
  port: number;
  databasePath: string;
  schemaPath: string;
  knowledgeDir: string;
  publicDir: string;
  modelApiKey: string;
  modelBaseUrl: string;
  modelName: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
};

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, root: string): AppConfig {
  const port = env.PORT ? Number(env.PORT) : 8787;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  return {
    port,
    databasePath: env.DATABASE_PATH || join(root, "data", "onboarding.sqlite"),
    schemaPath: env.ORGANIZATION_SCHEMA_PATH || join(root, "fixtures", "record.schema.json"),
    knowledgeDir: env.KNOWLEDGE_DIR || join(root, "fixtures", "knowledge"),
    publicDir: join(root, "public"),
    modelApiKey: env.MODEL_API_KEY ?? "",
    modelBaseUrl: env.MODEL_BASE_URL ?? "",
    modelName: env.MODEL_NAME ?? "",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? "",
  };
}
