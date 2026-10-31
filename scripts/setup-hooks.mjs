import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const existing = spawnSync("git", ["config", "--get-all", "core.hooksPath"], { cwd: root, encoding: "utf8" });
if (![0, 1].includes(existing.status)) {
  console.error("Cannot inspect existing Git hooks configuration; setup refused.");
  process.exit(2);
}
if (existing.status === 0 && existing.stdout.trim().split("\n").some((path) => resolve(root, path) !== resolve(root, ".githooks"))) {
  console.error("An existing core.hooksPath is configured. Preserve and integrate those hooks before retrying setup.");
  process.exit(2);
}
// --git-path hooks follows core.hooksPath. Inspect the actual shared default
// directory instead, including when running setup again or from a worktree.
const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
if (commonDir.status !== 0) process.exit(2);
const defaultHooks = join(resolve(root, commonDir.stdout.trim()), "hooks");
if (["pre-commit", "pre-push"].some((hook) => existsSync(join(defaultHooks, hook)))) {
  console.error("Existing default-directory Git hooks require integration before setup; no configuration changed.");
  process.exit(2);
}
const check = spawnSync(process.execPath, [fileURLToPath(new URL("./check-secrets.mjs", import.meta.url)), "verify-tool"], { stdio: "inherit" });
if (check.status !== 0) process.exit(check.status ?? 2);
for (const hook of ["pre-commit", "pre-push"]) chmodSync(`${root}.githooks/${hook}`, 0o755);
const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 2);
console.log("Repository-local pre-commit and pre-push secret checks installed.");
