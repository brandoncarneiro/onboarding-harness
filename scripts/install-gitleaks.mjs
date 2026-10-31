import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Official release asset digests verified against GitHub's release API and checksum file:
// https://api.github.com/repos/gitleaks/gitleaks/releases/tags/v8.30.1
const checksums = {
  darwin_arm64: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  linux_arm64: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
};
const platform = `${process.platform}_${process.arch}`;
const expected = checksums[platform];
if (!process.argv[2] || !expected) {
  console.error("Usage: node scripts/install-gitleaks.mjs <bin-directory> (macOS/Linux arm64/x64)");
  process.exit(2);
}
const destination = resolve(process.argv[2]);
const temp = mkdtempSync(join(tmpdir(), "install-gitleaks-"));
try {
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${platform}.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("Gitleaks checksum mismatch; installation refused.");
  const archivePath = join(temp, "gitleaks.tar.gz");
  writeFileSync(archivePath, archive, { mode: 0o600 });
  mkdirSync(destination, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", destination, "gitleaks"], { stdio: "inherit" });
  if (extracted.status !== 0) throw new Error("Gitleaks extraction failed.");
  chmodSync(join(destination, "gitleaks"), 0o755);
  console.log(`Installed checksum-verified gitleaks 8.30.1 in ${destination}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
