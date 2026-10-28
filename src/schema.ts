import { readFileSync } from "node:fs";
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

type SchemaNode = {
  title?: string;
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  const?: unknown;
  format?: string;
  minLength?: number;
};

export type SchemaDocument = {
  title: string;
  fields: FieldSpec[];
};

export function loadSchema(path: string): SchemaDocument {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("record schema must be a JSON object");
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Organization";
  return { title, fields: fieldsFromSchema(asNode(parsed)) };
}

export function fieldsFromSchema(schema: SchemaNode): FieldSpec[] {
  const fields: FieldSpec[] = [];
  const required = new Set(schema.required ?? []);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (property.type === "object" && property.properties) {
      const childRequired = new Set(property.required ?? []);
      for (const [childKey, child] of Object.entries(property.properties)) {
        fields.push(fieldSpec(`${key}.${childKey}`, child, required.has(key) && childRequired.has(childKey)));
      }
      continue;
    }
    fields.push(fieldSpec(key, property, required.has(key)));
  }
  return fields;
}

function fieldSpec(path: string, node: SchemaNode, required: boolean): FieldSpec {
  const type = node.type === "boolean" ? "boolean" : "string";
  const spec: FieldSpec = {
    path,
    title: node.title?.trim() || path,
    type,
    required,
  };
  if (typeof node.const === "string" || typeof node.const === "boolean") {
    spec.constValue = node.const;
  }
  if (node.format === "email") spec.format = "email";
  if (typeof node.minLength === "number") spec.minLength = node.minLength;
  return spec;
}

function asNode(value: unknown): SchemaNode {
  if (!isRecord(value)) throw new Error("schema node must be an object");
  const node: SchemaNode = {};
  if (typeof value.title === "string") node.title = value.title;
  if (typeof value.type === "string") node.type = value.type;
  if (Array.isArray(value.required)) {
    const required = value.required.filter((item): item is string => typeof item === "string");
    if (required.length === value.required.length) node.required = required;
  }
  if (typeof value.format === "string") node.format = value.format;
  if (typeof value.minLength === "number") node.minLength = value.minLength;
  if (typeof value.const === "string" || typeof value.const === "boolean") node.const = value.const;
  if (isRecord(value.properties)) {
    const properties: Record<string, SchemaNode> = {};
    for (const [key, child] of Object.entries(value.properties)) {
      properties[key] = asNode(child);
    }
    node.properties = properties;
  }
  return node;
}
