import { timingSafeEqual } from "node:crypto";

export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
