import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["staged", "history", "verify-tool"].includes(mode)) {
  console.error("Usage: node scripts/check-secrets.mjs staged|history|verify-tool");
  process.exit(2);
}
const version = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== "8.30.1") {
  console.error("gitleaks 8.30.1 is required. Install it with node scripts/install-gitleaks.mjs <bin-directory> and add that directory to PATH.");
  process.exit(2);
}
if (mode === "verify-tool") process.exit(0);

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootResult.status !== 0) {
  console.error("Secret checks require a Git working tree.");
  process.exit(2);
}
const root = rootResult.stdout.trim();
const config = fileURLToPath(new URL("../.gitleaks.toml", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "onboarding-secret-check-"));
let status = 2;
try {
  const flags = ["--config", config, "--redact", "--no-banner", "--no-color", "--log-level", "warn", "--ignore-gitleaks-allow", "--gitleaks-ignore-path", join(temp, "no-ignores")];
  let args;
  if (mode === "staged") {
    // Export the entire index, never the working files: partial staging must be exact.
    const snapshot = join(temp, "index");
    const exported = spawnSync("git", ["checkout-index", "--all", `--prefix=${snapshot}/`], { cwd: root, encoding: "utf8" });
    if (exported.status !== 0) throw new Error("Cannot export the staged index for secret scanning.");
    args = ["dir", snapshot, ...flags];
  } else {
    const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" });
    if (shallow.status !== 0 || shallow.stdout.trim() !== "false") {
      throw new Error("Full history is required for secret scanning. Fetch complete history before retrying.");
    }
    args = ["git", resolve(root), "--log-opts=--all --full-history", ...flags];
  }
  const result = spawnSync("gitleaks", args, { cwd: root, stdio: "inherit" });
  status = result.status ?? 2;
  if (status !== 0) console.error("Secret check failed; commit/push is blocked. Review redacted findings or scanner errors.");
} catch (error) {
  console.error(error.message);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exit(status);
