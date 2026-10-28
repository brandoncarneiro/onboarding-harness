export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected a string column");
  }
  return value;
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}
