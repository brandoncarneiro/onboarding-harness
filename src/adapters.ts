/**
 * Seams for adapters that are not part of V0.
 * Nothing in this file is implemented, and none of these projects are dependencies.
 */

export type KnowledgePageInput = {
  url: string;
  title: string;
  passages: string[];
};

/** Later: unclecode/crawl4ai, Apache-2.0. It will fill the knowledge loader. Not imported. */
export interface SiteCrawlLoader {
  load(startUrl: string): Promise<KnowledgePageInput[]>;
}

/** Later: onyx-dot-app/onyx Community. Optional knowledge service. Not imported. */
export interface ExternalKnowledgeService {
  search(query: string): Promise<{ url: string; passage: string }[]>;
}

/**
 * Later: docling-project/docling and microsoft/markitdown, with faster-whisper for speech.
 * Documents, audio, and video. Not imported.
 */
export interface MediaIngest {
  ingest(input: { kind: "document" | "audio" | "video"; path: string }): Promise<KnowledgePageInput[]>;
}

/**
 * Later: the server substitutes scripture text for a reference.
 * The pattern to study is apologist-project/llm-scripture-fidelity, which is CC0.
 * V0 has no implementation and stores no verse text.
 */
export interface ScriptureTextSubstituter {
  textForReference(reference: string): Promise<string>;
}

/** Later: a LiveKit voice adapter on this same HTTP API. Not imported. */
export interface LiveKitVoiceAdapter {
  attach(apiBasePath: "/api/chat"): void;
}
