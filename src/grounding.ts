import type { SearchHit, SearchOutcome } from "./knowledge.ts";
import { MISS_REPLY } from "./prompt.ts";

export type AssessedClaim =
  | { supported: true; url: string; passage: string }
  | { supported: false };

export function requireHits(outcome: SearchOutcome): SearchHit[] {
  if (outcome.kind === "miss") throw new Error("miss is not a hit");
  return outcome.hits;
}

export function factsFromOutcome(outcome: SearchOutcome): SearchHit[] {
  if (outcome.kind === "miss") return [];
  return requireHits(outcome);
}

export function assessClaim(claim: string, outcome: SearchOutcome): AssessedClaim {
  if (outcome.kind === "miss") return { supported: false };
  for (const hit of outcome.hits) {
    if (hit.kind !== "hit") return { supported: false };
    if (passageSupportsClaim(hit.passage, claim)) {
      return { supported: true, url: hit.url, passage: hit.passage };
    }
  }
  return { supported: false };
}

export function passageSupportsClaim(passage: string, claim: string): boolean {
  const supported = normalize(passage);
  const wanted = normalize(claim);
  if (!supported || !wanted) return false;
  return supported.includes(wanted);
}

export function replyForSearch(question: string, outcome: SearchOutcome): string {
  if (outcome.kind === "miss") return MISS_REPLY;
  if (/\bvideo\b/i.test(question)) {
    const titles = outcome.hits
      .filter((hit) => hit.pageKind === "video")
      .map((hit) => `Video title: ${hit.title}`);
    if (titles.length === 0) return MISS_REPLY;
    return titles.join("\n");
  }
  return outcome.hits
    .map((hit) => hit.pageKind === "video" ? `Video title: ${hit.title}` : hit.passage)
    .join("\n\n");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
