import { readFileSync } from "node:fs";
import { MAX_MESSAGE_LENGTH } from "./messageLimits.ts";
import { parseFieldInput } from "./values.ts";
import { isRecord } from "./util.ts";

export type FieldSpec = {
  path: string;
  title: string;
  type: "string" | "boolean";
  required: boolean;
  constValue?: string | boolean;
  format?: "email";
  minLength?: number;
};

export type SchemaDocument = {
  title: string;
  fields: FieldSpec[];
};

export function loadSchema(path: string): SchemaDocument {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const fields = fieldsFromSchema(parsed);
  const title = isRecord(parsed) && typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Organization";
  return { title, fields };
}

export function fieldsFromSchema(schema: unknown): FieldSpec[] {
  const fields: FieldSpec[] = [];
  visit(schema, "", true, 0);
  return fields;

  function visit(value: unknown, path: string, required: boolean, depth: number): void {
    const fail = (reason: string): never => { throw new Error(`Invalid schema at ${path || "root"}: ${reason}`); };
    if (!isRecord(value)) fail("node must be an object");
    const node = value as Record<string, unknown>;
    const object = node.type === "object";
    if (!object && node.type !== "string" && node.type !== "boolean") fail("type must be object, string or boolean");
    if (depth === 0 && !object) fail("root type must be object");
    const allowed = new Set(["type", "title", "description", ...(depth === 0 ? ["$schema"] : []), ...(object ? ["properties", "required"] : ["const", ...(node.type === "string" ? ["format", "minLength"] : [])])]);
    for (const key of Object.keys(node)) if (!allowed.has(key)) fail(`unsupported keyword ${key}`);
    for (const key of ["title", "description", "$schema"]) if (key in node && typeof node[key] !== "string") fail(`${key} must be a string`);
    if (object) {
      if (depth > 1) fail("only one nested object level is supported");
      if (!isRecord(node.properties) || Object.keys(node.properties).length === 0) fail("properties must be a nonempty object");
      const properties = node.properties as Record<string, unknown>;
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((key: unknown) => typeof key !== "string" || !Object.hasOwn(properties, key)) || new Set(node.required).size !== node.required.length)) fail("required must contain unique existing property names");
      const requiredKeys = new Set(node.required as string[] | undefined);
      for (const [key, child] of Object.entries(properties)) {
        if (!key.trim() || key.includes(".") || ["__proto__", "prototype", "constructor"].includes(key)) fail(`unsafe property name ${key}`);
        visit(child, path ? `${path}.${key}` : key, required && requiredKeys.has(key), depth + 1);
      }
      return;
    }
    if ("const" in node && typeof node.const !== node.type) fail("const must match type");
    if ("format" in node && node.format !== "email") fail("only email format is supported");
    if ("minLength" in node && (typeof node.minLength !== "number" || !Number.isSafeInteger(node.minLength) || node.minLength < 0)) fail("minLength must be a nonnegative integer");
    const spec: FieldSpec = { path, title: typeof node.title === "string" && node.title.trim() ? node.title.trim() : path, type: node.type as "string" | "boolean", required };
    if ("const" in node) spec.constValue = node.const as string | boolean;
    if ("format" in node) spec.format = "email";
    if ("minLength" in node) spec.minLength = node.minLength as number;
    if (spec.minLength !== undefined && spec.minLength > MAX_MESSAGE_LENGTH) fail(`minLength exceeds the ${MAX_MESSAGE_LENGTH} character message limit`);
    if (typeof spec.constValue === "string" && (spec.constValue.length > MAX_MESSAGE_LENGTH || !parseFieldInput(spec, spec.constValue).ok)) fail("const cannot satisfy the input constraints");
    fields.push(spec);
  }
}
