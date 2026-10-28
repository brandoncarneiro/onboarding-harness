import { createHash } from "node:crypto";
import type { FieldSpec } from "./schema.ts";

export type DraftValues = Record<string, unknown>;

export type IntakeStatus = "collecting" | "awaiting_confirmation" | "saved";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AFFIRMATIVE = /^(yes|yep|y|true|agree|i agree)$/i;

export function getPath(values: DraftValues, path: string): unknown {
  const parts = path.split(".");
  let cursor: unknown = values;
  for (const part of parts) {
    if (!isPlain(cursor) || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

export function setPath(values: DraftValues, path: string, value: unknown): DraftValues {
  const clone = structuredClone(values);
  const parts = path.split(".");
  let cursor: DraftValues = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!key) throw new Error("empty field path");
    const next = cursor[key];
    if (!isPlain(next)) cursor[key] = {};
    const child = cursor[key];
    if (!isPlain(child)) throw new Error("field path is not an object");
    cursor = child;
  }
  const leaf = parts[parts.length - 1];
  if (!leaf) throw new Error("empty field path");
  cursor[leaf] = value;
  return clone;
}

export function parseFieldInput(
  field: FieldSpec,
  raw: string,
): { ok: true; value: string | boolean } | { ok: false } {
  const text = raw.trim();
  if (field.type === "boolean") {
    const affirmative = AFFIRMATIVE.test(text);
    const negative = /^(no|n|false)$/i.test(text);
    if (affirmative) {
      if (field.constValue === false) return { ok: false };
      return { ok: true, value: true };
    }
    if (negative) {
      if (field.constValue === true) return { ok: false };
      return { ok: true, value: false };
    }
    return { ok: false };
  }
  if (!text) return { ok: false };
  if (field.minLength !== undefined && text.length < field.minLength) return { ok: false };
  if (field.format === "email" && !EMAIL.test(text)) return { ok: false };
  if (typeof field.constValue === "string" && text !== field.constValue) return { ok: false };
  return { ok: true, value: text };
}

export function isFilled(field: FieldSpec, values: DraftValues): boolean {
  const value = getPath(values, field.path);
  if (field.type === "boolean") {
    if (typeof field.constValue === "boolean") return value === field.constValue;
    return value === true || value === false;
  }
  return typeof value === "string" && parseFieldInput(field, value).ok;
}

export function nextMissing(fields: FieldSpec[], values: DraftValues): FieldSpec | undefined {
  return fields.find((field) => field.required && !isFilled(field, values));
}

export function fieldByLabel(fields: FieldSpec[], label: string): FieldSpec | undefined {
  const wanted = normalizeLabel(label);
  return fields.find((field) => {
    const leaf = field.path.split(".").at(-1) ?? field.path;
    return (
      normalizeLabel(field.title) === wanted ||
      normalizeLabel(field.path) === wanted ||
      normalizeLabel(leaf) === wanted
    );
  });
}

export function canonicalTree(fields: FieldSpec[], values: DraftValues): DraftValues {
  const root: DraftValues = {};
  for (const field of fields) {
    assign(root, field.path, storedValue(field, getPath(values, field.path)));
  }
  return root;
}

export function canonicalJson(fields: FieldSpec[], values: DraftValues): string {
  return JSON.stringify(canonicalTree(fields, values));
}

export function hashValues(fields: FieldSpec[], values: DraftValues): string {
  return sha256(canonicalJson(fields, values));
}

export function confirmationIsValid(fields: FieldSpec[], values: DraftValues, hash: string | null): boolean {
  if (!hash) return false;
  if (nextMissing(fields, values)) return false;
  return hashValues(fields, values) === hash;
}

export function intakeStatus(
  fields: FieldSpec[],
  group: { values: DraftValues; pendingHash: string | null; confirmationHash: string | null },
): IntakeStatus {
  if (confirmationIsValid(fields, group.values, group.confirmationHash)) return "saved";
  if (
    group.pendingHash &&
    !nextMissing(fields, group.values) &&
    group.pendingHash === hashValues(fields, group.values)
  ) {
    return "awaiting_confirmation";
  }
  return "collecting";
}

export function fieldPrompt(field: FieldSpec): string {
  if (field.type === "boolean") return `${field.title}. Reply yes to agree.`;
  return `What is your ${field.title}?`;
}

export function confirmationSummary(fields: FieldSpec[], values: DraftValues): string {
  const lines = fields.map((field) => `${field.title}: ${displayValue(field, getPath(values, field.path))}`);
  return `Confirm this exact set of details:\n${lines.join("\n")}\nReply yes to confirm.`;
}

export function isEmptyValues(values: DraftValues): boolean {
  return Object.keys(values).length === 0;
}

export function stableJson(value: unknown): string {
  if (!isPlain(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function displayValue(field: FieldSpec, value: unknown): string {
  if (field.type === "boolean") return value === true ? "yes" : value === false ? "no" : "not answered";
  return typeof value === "string" ? value : "";
}

function storedValue(field: FieldSpec, value: unknown): string | boolean | null {
  if (field.type === "boolean") return value === true || value === false ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assign(root: DraftValues, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!key) throw new Error("empty field path");
    const next = cursor[key];
    if (!isPlain(next)) cursor[key] = {};
    const child = cursor[key];
    if (!isPlain(child)) throw new Error("field path is not an object");
    cursor = child;
  }
  const leaf = parts[parts.length - 1];
  if (!leaf) throw new Error("empty field path");
  cursor[leaf] = value;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isPlain(value: unknown): value is DraftValues {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
