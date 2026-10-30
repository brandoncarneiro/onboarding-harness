import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldsFromSchema, loadSchema } from "../src/schema.ts";
import { withHarness, INTAKE_BEFORE_CONFIRM } from "./helpers.ts";
import { listRecords } from "../src/recordStore.ts";

const wrap = (field: unknown) => ({ type: "object", properties: { name: field }, required: ["name"] });
for (const [label, schema] of Object.entries({
  empty: {}, number: wrap({ type: "number" }), pattern: wrap({ type: "string", pattern: "x" }),
  emailBoolean: wrap({ type: "boolean", format: "email" }), wrongConst: wrap({ type: "string", const: true }),
  badLength: wrap({ type: "string", minLength: -1 }), unknownRequired: { ...wrap({ type: "string" }), required: ["missing"] },
  duplicateRequired: { ...wrap({ type: "string" }), required: ["name", "name"] },
  dotted: { type: "object", properties: { "a.b": { type: "string" } } },
  prototype: JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
  deep: wrap({ type: "object", properties: { inner: { type: "object", properties: { x: { type: "string" } } } } }),
})) {
  it(`rejects unsupported or malformed schema: ${label}`, () => assert.throws(() => fieldsFromSchema(schema), /schema/i));
}
it("fails schema loading before use for unsupported constraints", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema-check-"));
  try { const file = join(dir, "schema.json"); writeFileSync(file, JSON.stringify(wrap({ type: "string", maxLength: 5 }))); assert.throws(() => loadSchema(file), /maxLength/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
it("keeps nested required flags conditional on a required parent", () => {
  assert.equal(fieldsFromSchema({ type: "object", properties: { group: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } })[0]?.required, false);
});
it("accepts capitalized Yes only for the final awaiting confirmation", async () => {
  await withHarness(async (h) => {
    await h.send("web", "caps", "Yes"); assert.equal(listRecords(h.db).length, 0);
    for (const msg of INTAKE_BEFORE_CONFIRM) await h.send("web", "caps-final", msg);
    for (const msg of ["yep", "yes please"]) { await h.send("web", "caps-final", msg); assert.equal(listRecords(h.db).length, 0); }
    assert.equal((await h.send("web", "caps-final", "Yes")).status, "saved");
  });
});
for (const [label, constraints] of Object.entries({
  shorterThanMinimum: { const: "x", minLength: 2 },
  invalidEmail: { const: "not-email", format: "email" },
  exceedsMessageLimit: { minLength: 4097 },
  oversizedConst: { const: "x".repeat(4097) },
  emptyConst: { const: "" },
  paddedConst: { const: " x " },
})) {
  it(`fails loading an unsatisfiable string schema: ${label}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "unsatisfiable-schema-"));
    try {
      const path = join(dir, "schema.json");
      writeFileSync(path, JSON.stringify(wrap({ type: "string", ...constraints })));
      assert.throws(() => loadSchema(path), /schema/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
it("loads satisfiable string constraints at the message boundary", () => {
  assert.equal(fieldsFromSchema(wrap({ type: "string", minLength: 4096 }))[0]?.minLength, 4096);
  assert.equal(fieldsFromSchema(wrap({ type: "string", const: "person@example.com", format: "email", minLength: 5 }))[0]?.constValue, "person@example.com");
});
