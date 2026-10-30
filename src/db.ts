import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CheckFailed } from "./errors.ts";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

let nextSavepoint = 0;

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const savepoint = db.isTransaction ? `onboarding_${++nextSavepoint}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (savepoint) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } else {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}

export function snapshotDatabase(db: DatabaseSync): DatabaseSnapshot {
  return {
    sessionGroups: db.prepare(
      `SELECT id, draft_json, pending_hash, confirmation_hash, saved_record_id, updated_at
       FROM session_groups ORDER BY id`,
    ).all(),
    sessions: db.prepare(
      `SELECT id, channel, channel_key, group_id, created_at FROM sessions ORDER BY id`,
    ).all(),
    records: db.prepare(
      `SELECT id, group_id, values_json, confirmation_hash, saved_at FROM records ORDER BY id`,
    ).all(),
    linkCodes: db.prepare(
      `SELECT code, group_id, session_id, created_at, expires_at, used_at FROM link_codes ORDER BY code`,
    ).all(),
    imsgPairCodes: db.prepare(
      `SELECT code, created_at, expires_at, used_at FROM imsg_pair_codes ORDER BY code`,
    ).all(),
    telegramUpdates: db.prepare(
      `SELECT update_id, reply, chat_id, sent_at, state, owner, applied_reply, checkpoint_version
       FROM telegram_updates ORDER BY update_id`,
    ).all(),
    knowledgePages: db.prepare(
      `SELECT id, url, title, kind FROM knowledge_pages ORDER BY id`,
    ).all(),
    knowledgePassages: db.prepare(
      `SELECT id, page_id, passage FROM knowledge_passages ORDER BY id`,
    ).all(),
  };
}

export type DatabaseSnapshot = {
  sessionGroups: unknown[];
  sessions: unknown[];
  records: unknown[];
  linkCodes: unknown[];
  imsgPairCodes: unknown[];
  telegramUpdates: unknown[];
  knowledgePages: unknown[];
  knowledgePassages: unknown[];
};

export function refuse(message: string): never {
  throw new CheckFailed(message);
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_groups (
      id TEXT PRIMARY KEY,
      draft_json TEXT NOT NULL,
      pending_hash TEXT,
      confirmation_hash TEXT,
      saved_record_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'imessage')),
      channel_key TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES session_groups(id),
      created_at TEXT NOT NULL,
      UNIQUE (channel, channel_key)
    );

    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES session_groups(id),
      values_json TEXT NOT NULL,
      confirmation_hash TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS link_codes (
      code TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES session_groups(id),
      session_id TEXT NOT NULL REFERENCES sessions(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS imsg_pair_codes (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS incoming_requests (
      channel TEXT NOT NULL, channel_key TEXT NOT NULL, request_id TEXT NOT NULL,
      message TEXT NOT NULL, prepared_json TEXT NOT NULL, result_json TEXT, sent_at TEXT, reply_to TEXT,
      PRIMARY KEY (channel, channel_key, request_id)
    );

    CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id INTEGER PRIMARY KEY,
      reply TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sent_at TEXT,
      state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('applying', 'ready', 'sending', 'sent', 'failed')),
      owner TEXT,
      applied_reply TEXT,
      checkpoint_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS knowledge_pages (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('page', 'video'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_passages (
      id INTEGER PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      passage TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      passage,
      content='knowledge_passages',
      content_rowid='id'
    );
  `);
  const incomingColumns = db.prepare("PRAGMA table_info(incoming_requests)").all();
  if (!incomingColumns.some((column) => column.name === "reply_to")) {
    db.exec("ALTER TABLE incoming_requests ADD COLUMN reply_to TEXT");
  }
  const telegramColumns = db.prepare("PRAGMA table_info(telegram_updates)").all();
  if (!telegramColumns.some((column) => column.name === "state")) {
    db.exec(`ALTER TABLE telegram_updates ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'
      CHECK (state IN ('applying', 'ready', 'sending', 'sent', 'failed'))`);
  }
  for (const [name, definition] of [
    ["owner", "TEXT"],
    ["applied_reply", "TEXT"],
    ["checkpoint_version", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!telegramColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE telegram_updates ADD COLUMN ${name} ${definition}`);
    }
  }
  widenSessionChannels(db);
}

function widenSessionChannels(db: DatabaseSync): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  ).get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'imessage'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE sessions_next (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'imessage')),
        channel_key TEXT NOT NULL,
        group_id TEXT NOT NULL REFERENCES session_groups(id),
        created_at TEXT NOT NULL,
        UNIQUE (channel, channel_key)
      );
      INSERT INTO sessions_next (id, channel, channel_key, group_id, created_at)
        SELECT id, channel, channel_key, group_id, created_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_next RENAME TO sessions;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
