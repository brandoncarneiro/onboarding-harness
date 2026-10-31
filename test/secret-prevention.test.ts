import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
// Deliberately generated, nonfunctional fixtures; never a provider-issued credential.
const fakeToken = `gh${"p"}_${createHash("sha256").update("synthetic-hook-test").digest("hex").slice(0, 36)}`;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_TERMINAL_PROMPT: "0" };

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

function succeeds(cwd: string, args: string[]) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function withRepo(run: (repo: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "secret-prevention-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  try {
    succeeds(repo, ["init", "--quiet", "--initial-branch=main"]);
    for (const path of [".githooks", "scripts", ".gitleaks.toml"]) {
      if (existsSync(join(root, path))) cpSync(join(root, path), join(repo, path), { recursive: true });
    }
    succeeds(repo, ["config", "--local", "core.hooksPath", ".githooks"]);
    writeFileSync(join(repo, "clean.txt"), "Fictional local example.\n");
    succeeds(repo, ["add", "."]);
    succeeds(repo, ["commit", "--quiet", "-m", "Clean fixture"]);
    run(repo, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pre-commit rejects the staged credential even when its working file is clean", () => {
  withRepo((repo) => {
    writeFileSync(join(repo, "credential.txt"), `credential=${fakeToken}\n`);
    succeeds(repo, ["add", "credential.txt"]);
    writeFileSync(join(repo, "credential.txt"), "sanitized working file\n");
    const before = succeeds(repo, ["rev-parse", "HEAD"]);
    const result = git(repo, ["commit", "--quiet", "-m", "Must be rejected"]);
    assert.notEqual(result.status, 0, "staged credential must reject the actual commit");
    assert.equal(succeeds(repo, ["rev-parse", "HEAD"]), before);
    assert.equal((result.stdout + result.stderr).includes(fakeToken), false);
  });
});

test("pre-commit accepts a clean index despite an unstaged credential", () => {
  withRepo((repo) => {
    writeFileSync(join(repo, "clean.txt"), "Sanitized staged change.\n");
    succeeds(repo, ["add", "clean.txt"]);
    writeFileSync(join(repo, "clean.txt"), `credential=${fakeToken}\n`);
    succeeds(repo, ["commit", "--quiet", "-m", "Clean staged content"]);
  });
});

test("pre-commit rejects custom endpoint environment credentials", () => {
  withRepo((repo) => {
    writeFileSync(join(repo, "operator.env"), `MODEL_BASE_URL=https://model.example/v1\nMODEL_API_KEY=${createHash("sha256").update("synthetic-custom-endpoint").digest("hex")}\n`);
    succeeds(repo, ["add", "operator.env"]);
    assert.notEqual(git(repo, ["commit", "--quiet", "-m", "Must be rejected"]).status, 0);
  });
});

test("pre-commit accepts consecutive blank environment settings", () => {
  withRepo((repo) => {
    writeFileSync(join(repo, ".env.example"), "MODEL_API_KEY=\nMODEL_BASE_URL=\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_WEBHOOK_SECRET=\n");
    succeeds(repo, ["add", ".env.example"]);
    succeeds(repo, ["commit", "--quiet", "-m", "Blank operator template"]);
  });
});

test("pre-push rejects credentials in history after a later clean commit", () => {
  withRepo((repo, dir) => {
    const remote = join(dir, "remote.git");
    succeeds(dir, ["init", "--bare", "--quiet", remote]);
    succeeds(repo, ["remote", "add", "origin", remote]);
    succeeds(repo, ["push", "--quiet", "origin", "main"]);
    writeFileSync(join(repo, "clean.txt"), `credential=${fakeToken}\n`);
    succeeds(repo, ["add", "clean.txt"]);
    // Seed deliberately dirty history in the disposable fixture only.
    succeeds(repo, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Synthetic dirty history"]);
    writeFileSync(join(repo, "clean.txt"), "Sanitized current content.\n");
    succeeds(repo, ["add", "clean.txt"]);
    succeeds(repo, ["commit", "--quiet", "-m", "Clean current tree"]);
    const before = succeeds(dir, ["--git-dir", remote, "rev-parse", "refs/heads/main"]);
    const result = git(repo, ["push", "--quiet", "origin", "main"]);
    assert.notEqual(result.status, 0, "history credential must reject the actual local push");
    assert.equal(succeeds(dir, ["--git-dir", remote, "rev-parse", "refs/heads/main"]), before);
    assert.equal((result.stdout + result.stderr).includes(fakeToken), false);
  });
});

test("secret checks fail closed when gitleaks is missing", () => {
  withRepo((repo, dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const gitPath = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const result = spawnSync(process.execPath, [join(repo, "scripts/check-secrets.mjs"), "staged"], { cwd: repo, env: { ...env, PATH: bin }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gitleaks.*(required|install|missing)/i);
  });
});

test("hook setup installs only a repository-local hooksPath", () => {
  withRepo((repo) => {
    succeeds(repo, ["config", "--local", "--unset", "core.hooksPath"]);
    const result = spawnSync(process.execPath, [join(repo, "scripts/setup-hooks.mjs")], { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(succeeds(repo, ["config", "--local", "--get", "core.hooksPath"]), ".githooks");
    assert.equal(git(repo, ["config", "--global", "--get", "core.hooksPath"]).status, 1);
  });
});

test("hook setup can be repeated after its first successful installation", () => {
  withRepo((repo) => {
    succeeds(repo, ["config", "--local", "--unset", "core.hooksPath"]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(process.execPath, [join(repo, "scripts/setup-hooks.mjs")], { cwd: repo, env, encoding: "utf8" });
      assert.equal(result.status, 0, `installation ${attempt + 1}: ${result.stderr}`);
    }
    assert.equal(succeeds(repo, ["config", "--local", "--get", "core.hooksPath"]), ".githooks");
  });
});

test("hook setup can be repeated from a linked worktree", () => {
  withRepo((repo, dir) => {
    const worktree = join(dir, "linked-worktree");
    succeeds(repo, ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"]);
    succeeds(repo, ["config", "--local", "--unset", "core.hooksPath"]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(process.execPath, [join(worktree, "scripts/setup-hooks.mjs")], { cwd: worktree, env, encoding: "utf8" });
      assert.equal(result.status, 0, `linked installation ${attempt + 1}: ${result.stderr}`);
    }
  });
});

test("hook setup preserves the common default-directory hook in a linked worktree", () => {
  withRepo((repo, dir) => {
    const worktree = join(dir, "linked-worktree");
    succeeds(repo, ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"]);
    succeeds(repo, ["config", "--local", "--unset", "core.hooksPath"]);
    writeFileSync(join(repo, ".git/hooks/pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(worktree, "scripts/setup-hooks.mjs")], { cwd: worktree, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]).status, 1);
  });
});

test("hook setup preserves a conflicting configured hooks directory", () => {
  withRepo((repo) => {
    succeeds(repo, ["config", "--local", "core.hooksPath", "existing-hooks"]);
    const result = spawnSync(process.execPath, [join(repo, "scripts/setup-hooks.mjs")], { cwd: repo, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(succeeds(repo, ["config", "--local", "--get", "core.hooksPath"]), "existing-hooks");
  });
});

test("hook setup preserves an existing global hooks directory", () => {
  withRepo((repo, dir) => {
    succeeds(repo, ["config", "--local", "--unset", "core.hooksPath"]);
    const globalConfig = join(dir, "global.gitconfig");
    writeFileSync(globalConfig, "[core]\n\thooksPath = existing-global-hooks\n");
    const result = spawnSync(process.execPath, [join(repo, "scripts/setup-hooks.mjs")], { cwd: repo, env: { ...env, GIT_CONFIG_GLOBAL: globalConfig }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]).status, 1);
  });
});

test("hook setup preserves a custom default-directory hook", () => {
  withRepo((repo) => {
    succeeds(repo, ["config", "--local", "--unset", "core.hooksPath"]);
    writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(repo, "scripts/setup-hooks.mjs")], { cwd: repo, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]).status, 1);
  });
});
