import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createModel, LocalModel } from "../src/model.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { loadSchema } from "../src/schema.ts";
import { projectRoot } from "./helpers.ts";

const BANNED = [
  "firecrawl",
  "@mendable/firecrawl-js",
  "exa-js",
  "tavily",
  "@browserbasehq/sdk",
  "crawl4ai",
  "onyx",
  "docling",
  "markitdown",
  "faster-whisper",
  "livekit-server-sdk",
  "livekit-client",
];

describe("boundaries", () => {
  it("lists environment names without values", () => {
    const lines = readFileSync(join(projectRoot, ".env.example"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    assert.ok(lines.length > 0);
    for (const line of lines) assert.match(line, /^[A-Z0-9_]+=$/);
  });

  it("does not depend on later adapters or external search products", () => {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    for (const name of names) {
      assert.equal(BANNED.some((banned) => name.includes(banned)), false, name);
    }
    for (const file of typescriptFiles(join(projectRoot, "src")).concat(typescriptFiles(join(projectRoot, "test")))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        assert.equal(BANNED.some((banned) => specifier.includes(banned)), false, `${file} imports ${specifier}`);
      }
    }
  });

  it("has no Twilio, Linq, or Photon seam", () => {
    const paths = [join(projectRoot, "README.md"), ...typescriptFiles(join(projectRoot, "src"))];
    const pattern = /twilio|linq|photon/i;
    for (const path of paths) {
      assert.equal(pattern.test(readFileSync(path, "utf8")), false, path);
    }
  });

  it("uses the local model when no API key is set", async () => {
    const config = loadConfig({}, projectRoot);
    const model = createModel(config);
    assert.ok(model instanceof LocalModel);
    const result = await model.complete({
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
      safeText: "The details are saved.",
      mode: "saved",
    });
    assert.equal(result.text, "The details are saved.");
    const schema = loadSchema(join(projectRoot, "fixtures", "record.schema.json"));
    assert.equal(SYSTEM_PROMPT.includes(schema.title), false);
  });
});

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}
