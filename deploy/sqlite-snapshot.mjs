// SPDX-FileCopyrightText: 2026 the contributors
// SPDX-License-Identifier: MIT
// Create a consistent SQLite snapshot in a new private directory; never overwrite.
import { chmodSync, mkdtempSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [source, parent, ...extra] = process.argv.slice(2);
if (!source || !parent || extra.length || !isAbsolute(source) || !isAbsolute(parent)) {
  process.stderr.write("Usage: node deploy/sqlite-snapshot.mjs <absolute-source-db> <absolute-existing-private-parent>\n");
  process.exit(1);
}
process.umask(0o077);
let db;
let check;
try {
  // A missing source fails instead of silently creating an empty database.
  db = new DatabaseSync(source, { readOnly: true });
  const directory = mkdtempSync(join(parent, "snapshot-"));
  const destination = join(directory, "onboarding.sqlite");
  await backup(db, destination);
  chmodSync(destination, 0o600);
  check = new DatabaseSync(destination, { readOnly: true });
  const integrity = check.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok"
      || check.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("snapshot verification failed");
  }
  process.stdout.write(`${destination}\n`);
} catch {
  process.stderr.write("Snapshot failed. Do not use an incomplete snapshot; inspect privately before retrying.\n");
  process.exitCode = 1;
} finally {
  check?.close();
  db?.close();
}
