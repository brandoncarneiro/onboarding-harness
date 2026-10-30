import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const cli = resolve("src/export.ts");
function fixture(run: (dir: string, dbPath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "record-export-"));
  const dbPath = join(dir, "source.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE records (id TEXT, saved_at TEXT, confirmation_hash TEXT, values_json TEXT);
    CREATE TABLE session_groups (draft_json TEXT);
    INSERT INTO session_groups VALUES ('{"draft":"PRIVATE DRAFT"}');`);
  db.prepare("INSERT INTO records VALUES (?, ?, ?, ?)").run("record-1", "2026-10-30T00:00:00Z", "hash-1", JSON.stringify({ name: '=HYPERLINK("bad")', nested: { note: 'hello,"friend"\nnext', consent: true }, count: 0, nil: null }));
  db.close();
  try { run(dir, dbPath); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function invoke(dir: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, DATABASE_PATH: dbPath }, encoding: "utf8" });
}
test("JSON exports only saved revisions with original values and restrictive permissions", () => fixture((dir, dbPath) => {
  const output = join(dir, "records.json");
  const result = invoke(dir, dbPath, ["--format", "json", "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const rows = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: "record-1", savedAt: "2026-10-30T00:00:00Z", confirmationHash: "hash-1", values: { name: '=HYPERLINK("bad")', nested: { note: 'hello,"friend"\nnext', consent: true }, count: 0, nil: null } });
  assert.equal(statSync(output).mode & 0o777, 0o600);
}));
test("CSV uses deterministic pointer columns, quotes newlines and neutralizes formulas", () => fixture((dir, dbPath) => {
  const output = join(dir, "records.csv");
  const result = invoke(dir, dbPath, ["--format", "csv", "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), '"id","savedAt","confirmationHash","values/count","values/name","values/nested/consent","values/nested/note","values/nil"\r\n"record-1","2026-10-30T00:00:00Z","hash-1","0","\'=HYPERLINK(""bad"")","true","hello,""friend""\nnext","null"\r\n');
  assert.equal(statSync(output).mode & 0o777, 0o600);
}));
test("existing files and symlinks are refused without modification", () => fixture((dir, dbPath) => {
  const existing = join(dir, "existing"); writeFileSync(existing, "keep");
  const link = join(dir, "link"); symlinkSync(existing, link);
  for (const output of [existing, link]) assert.equal(invoke(dir, dbPath, ["--format", "json", "--output", output]).status, 1);
  assert.equal(readFileSync(existing, "utf8"), "keep");
}));
test("missing database fails without creating database or output; validates args and help", () => fixture((dir) => {
  const missing = join(dir, "missing.sqlite"); const output = join(dir, "output.json");
  const result = invoke(dir, missing, ["--format", "json", "--output", output]);
  assert.equal(result.status, 1); assert.equal(existsSync(missing), false); assert.equal(existsSync(output), false);
  assert.equal(invoke(dir, missing, ["--help"]).status, 0);
  for (const args of [[], ["--format", "xml", "--output", output], ["--format", "json"], ["--help", "--bad"], ["--format", "json", "--output", "-"]]) assert.equal(invoke(dir, missing, args).status, 1);
}));
test("loads DATABASE_PATH from local .env", () => fixture((dir, dbPath) => {
  writeFileSync(join(dir, ".env"), `DATABASE_PATH=${dbPath}\n`);
  const output = join(dir, "export.json");
  const result = spawnSync(process.execPath, [cli, "--format", "json", "--output", output], { cwd: dir, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}));
test("saved history includes every revision and never exports later drafts", () => fixture((dir, dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO records VALUES (?, ?, ?, ?)").run("record-2", "2026-10-30T01:00:00Z", "hash-2", '{"revised":true}');
  db.close();
  const output = join(dir, "history.json");
  assert.equal(invoke(dir, dbPath, ["--format", "json", "--output", output]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).map((record: { id: string }) => record.id), ["record-1", "record-2"]);
  assert.equal(readFileSync(output, "utf8").includes("PRIVATE DRAFT"), false);
}));
test("invalid saved JSON fails without leaking data or creating output", () => fixture((dir, dbPath) => {
  const db = new DatabaseSync(dbPath); db.exec("UPDATE records SET values_json = 'PERSONAL BROKEN JSON'"); db.close();
  const output = join(dir, "invalid.json");
  const result = invoke(dir, dbPath, ["--format", "json", "--output", output]);
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr.includes("PERSONAL"), false); assert.equal(existsSync(output), false);
}));
test("CSV neutralizes dangerous leading characters including whitespace and escapes pointer names", () => fixture((dir, dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE records SET values_json = ?").run(JSON.stringify({ a: '+cmd', b: '-cmd', c: '@cmd', d: '  =cmd', e: '\ttext', 'x/y~z': 'safe' })); db.close();
  const output = join(dir, "safe.csv");
  assert.equal(invoke(dir, dbPath, ["--format", "csv", "--output", output]).status, 0);
  const text = readFileSync(output, "utf8");
  for (const value of ["'+cmd", "'-cmd", "'@cmd", "'  =cmd", "'\ttext"]) assert.equal(text.includes(`"${value}"`), true);
  assert.equal(text.includes('"values/x~1y~0z"'), true);
}));
test("incompatible database is not migrated", () => fixture((dir) => {
  const database = join(dir, "old.sqlite"); const db = new DatabaseSync(database); db.exec("CREATE TABLE untouched (id TEXT)"); db.close();
  const before = readFileSync(database); const output = join(dir, "none.json");
  assert.equal(invoke(dir, database, ["--format", "json", "--output", output]).status, 1);
  assert.deepEqual(readFileSync(database), before); assert.equal(existsSync(output), false);
}));
