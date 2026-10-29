import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { it } from "node:test";
import { openDatabase } from "../src/db.ts";
import { projectRoot } from "./helpers.ts";

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

it("serves web intake without opening a retired pairing listener from old settings", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-retirement-"));
  const port = await unusedPort();
  const pairPort = await unusedPort();
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(dir, "test.sqlite"),
      ORGANIZATION_SCHEMA_PATH: join(projectRoot, "fixtures", "record.schema.json"),
      KNOWLEDGE_DIR: join(projectRoot, "fixtures", "knowledge"),
      MODEL_API_KEY: "",
      TELEGRAM_BOT_TOKEN: "",
      IMSG_MODE: "remote",
      IMSG_PAIR_PORT: String(pairPort),
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start")), 5_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("server exited before readiness")); });
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes(`listening on ${port}`)) { clearTimeout(timer); resolve(); }
      });
    });
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "retired-settings", message: "start" }),
    });
    assert.equal(chat.status, 200);
    assert.match((await chat.json() as { reply: string }).reply, /What is your Name/);
    const pairingListenerExists = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: pairPort });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    assert.equal(pairingListenerExists, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

it("removes retired pairing credentials while preserving historical intake sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-retired-state-"));
  const path = join(dir, "test.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY, draft_json TEXT NOT NULL, pending_hash TEXT,
      confirmation_hash TEXT, saved_record_id TEXT, updated_at TEXT NOT NULL
    );
    INSERT INTO session_groups VALUES ('historical-group', '{}', NULL, NULL, NULL, '2026-10-26');
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, channel_key TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES session_groups(id), created_at TEXT NOT NULL,
      UNIQUE (channel, channel_key)
    );
    INSERT INTO sessions VALUES ('historical-session', 'imessage', 'synthetic-chat', 'historical-group', '2026-10-26');
    CREATE TABLE imsg_pair_codes (code TEXT PRIMARY KEY, created_at TEXT, expires_at TEXT, used_at TEXT);
    INSERT INTO imsg_pair_codes VALUES ('TESTONLY', '2026-10-26', '2099-01-01', NULL);
  `);
  legacy.close();
  const db = openDatabase(path);
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'imsg_pair_codes'").get()?.count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sessions WHERE id = 'historical-session'").get()?.count, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
