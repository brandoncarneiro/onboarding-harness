import { closeSync, constants, fchmodSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadEnvFile } from "./config.ts";

const usage = "Usage: npm run export -- --format csv|json --output <new-file-path>\nExports confirmed saved revisions from DATABASE_PATH (or data/onboarding.sqlite).\n";
type SavedRecord = { id: string; savedAt: string; confirmationHash: string; values: Record<string, unknown> };

function argumentsFor(args: string[]): { format: "csv" | "json"; output: string } | "help" {
  if (args.length === 1 && args[0] === "--help") return "help";
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if ((key !== "--format" && key !== "--output") || !value || value.startsWith("--") || options.has(key)) throw new Error();
    options.set(key, value);
  }
  const format = options.get("--format"); const output = options.get("--output");
  if ((format !== "csv" && format !== "json") || !output || output === "-") throw new Error();
  return { format, output };
}

function readRecords(path: string): SavedRecord[] {
  // Do not use openDatabase: that helper creates directories and runs migrations.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT id, saved_at, confirmation_hash, values_json FROM records ORDER BY saved_at, id").all().map((row) => {
      if (typeof row.id !== "string" || typeof row.saved_at !== "string" || typeof row.confirmation_hash !== "string" || !row.confirmation_hash || typeof row.values_json !== "string") throw new Error();
      const values: unknown = JSON.parse(row.values_json);
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
      return { id: row.id, savedAt: row.saved_at, confirmationHash: row.confirmation_hash, values: values as Record<string, unknown> };
    });
  } finally { db.close(); }
}

function flatten(value: unknown, path: string, result: Map<string, unknown>): void {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) flatten(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, result);
  } else result.set(path, value);
}

function csvCell(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  // Quote escaping alone does not stop spreadsheet applications evaluating cells.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(records: SavedRecord[]): string {
  const values = records.map((record) => { const result = new Map<string, unknown>(); flatten(record.values, "values", result); return result; });
  const paths = [...new Set(values.flatMap((record) => [...record.keys()]))].sort();
  return [["id", "savedAt", "confirmationHash", ...paths].map(csvCell).join(","), ...records.map((record, index) =>
    [record.id, record.savedAt, record.confirmationHash, ...paths.map((path) => values[index]?.get(path) ?? (values[index]?.has(path) ? null : ""))].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

let options: ReturnType<typeof argumentsFor>;
try { options = argumentsFor(process.argv.slice(2)); } catch {
  process.stderr.write(`Invalid export arguments. ${usage}`);
  process.exit(1);
}
if (options === "help") process.stdout.write(usage);
else {
  try {
    loadEnvFile(join(process.cwd(), ".env"), process.env);
    const records = readRecords(process.env.DATABASE_PATH || join(process.cwd(), "data", "onboarding.sqlite"));
    const content = options.format === "json" ? JSON.stringify(records, null, 2) + "\n" : csv(records);
    // Exclusive creation refuses existing files, including symlinks, atomically.
    const fd = openSync(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); }
  } catch {
    // SQLite/parser/filesystem diagnostics can contain values or sensitive paths.
    process.stderr.write("Export failed. Check source database, output availability, and filesystem permissions.\n");
    process.exitCode = 1;
  }
}
