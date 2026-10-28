import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { asString } from "./util.ts";

export type LoadedPage = {
  url: string;
  title: string;
  kind: "page" | "video";
  passages: string[];
};

export type SearchHit = {
  kind: "hit";
  url: string;
  title: string;
  pageKind: LoadedPage["kind"];
  passage: string;
};

export type SearchMiss = {
  kind: "miss";
};

export type SearchOutcome =
  | SearchMiss
  | {
      kind: "hits";
      hits: SearchHit[];
    };

const STOP = new Set([
  "what",
  "is",
  "the",
  "a",
  "an",
  "do",
  "does",
  "did",
  "you",
  "your",
  "where",
  "when",
  "who",
  "how",
  "which",
  "of",
  "for",
  "to",
  "in",
  "on",
  "and",
  "or",
  "about",
  "please",
  "me",
  "that",
  "this",
]);

export function readKnowledgeDirectory(dir: string): LoadedPage[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseKnowledgeFile(readFileSync(join(dir, name), "utf8")));
}

export function indexKnowledge(db: DatabaseSync, pages: LoadedPage[]): void {
  withTransaction(db, () => {
    db.exec("DELETE FROM knowledge_pages");
    const insertPage = db.prepare(
      `INSERT INTO knowledge_pages (url, title, kind) VALUES (?, ?, ?)`,
    );
    const insertPassage = db.prepare(
      `INSERT INTO knowledge_passages (page_id, passage) VALUES (?, ?)`,
    );
    for (const page of pages) {
      const result = insertPage.run(page.url, page.title, page.kind);
      const pageId = Number(result.lastInsertRowid);
      for (const passage of page.passages) {
        insertPassage.run(pageId, passage);
      }
    }
    db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
  });
}

export function indexKnowledgeDirectory(db: DatabaseSync, dir: string): void {
  indexKnowledge(db, readKnowledgeDirectory(dir));
}

export function searchKnowledge(db: DatabaseSync, query: string): SearchOutcome {
  const match = toFtsQuery(query);
  if (!match) return { kind: "miss" };
  let rows: unknown[];
  try {
    rows = db.prepare(
      `SELECT pages.url AS url, pages.title AS title, pages.kind AS page_kind,
              passages.passage AS passage
       FROM knowledge_fts
       JOIN knowledge_passages AS passages ON passages.id = knowledge_fts.rowid
       JOIN knowledge_pages AS pages ON pages.id = passages.page_id
       WHERE knowledge_fts MATCH ?
       LIMIT 8`,
    ).all(match);
  } catch {
    return { kind: "miss" };
  }
  if (rows.length === 0) return { kind: "miss" };
  const hits: SearchHit[] = rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      kind: "hit",
      url: asString(record.url),
      title: asString(record.title),
      pageKind: asString(record.page_kind) as LoadedPage["kind"],
      passage: asString(record.passage),
    };
  });
  return { kind: "hits", hits };
}

export function parseKnowledgeFile(text: string): LoadedPage {
  if (!text.startsWith("---\n")) throw new Error("knowledge page requires front matter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("knowledge page front matter is unterminated");
  const meta: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    meta[match[1]] = match[2].trim();
  }
  const url = meta.url;
  const title = meta.title;
  if (!url || !title) throw new Error("knowledge page requires url and title");
  const kind = meta.kind === "video" ? "video" : "page";
  let passages = text
    .slice(end + 5)
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (kind === "video") {
    passages = passages.length > 0 ? [`Video title: ${title}`] : [];
  }
  if (passages.length === 0) throw new Error("knowledge page requires a passage");
  return { url, title, kind, passages };
}

function toFtsQuery(input: string): string | null {
  const terms = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = terms.filter((term) => term.length > 1 && !STOP.has(term));
  if (kept.length === 0) return null;
  return kept.map((term) => `"${term}"`).join(" OR ");
}
