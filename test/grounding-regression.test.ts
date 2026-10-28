import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replyForSearch } from "../src/grounding.ts";
import { indexKnowledge, parseKnowledgeFile, searchKnowledge } from "../src/knowledge.ts";
import { scriptureReply } from "../src/scripture.ts";
import { FakeModel, withHarness } from "./helpers.ts";

describe("grounding regressions", () => {
  it("keeps the server prompt when a model adds a field, a fact, or a rephrase", async () => {
    await withHarness(async (harness) => {
      for (const [index, text] of [
        "Please provide Email; date of birth.",
        "Our services start at 10. What is your Email?",
        "Could you share your Email?",
      ].entries()) {
        harness.deps.model = new FakeModel(() => text);
        const turn = await harness.send("web", `prompt-${index}`, "Sample Person");
        assert.equal(turn.reply, "What is your Email?");
        assert.deepEqual(turn.draft, { name: "Sample Person" });
      }
    });
  });

  it("answers an office time question from knowledge instead of inventing a reference", async () => {
    await withHarness(async (harness) => {
      indexKnowledge(harness.db, [{
        url: "https://example.invalid/office",
        title: "Office",
        kind: "page",
        passages: ["The office opens at 9:00."],
      }]);
      assert.equal(scriptureReply("Does the office open at 9:00?"), null);
      const turn = await harness.send("web", "office-time", "Does the office open at 9:00?");
      assert.equal(turn.reply, "The office opens at 9:00.\nWhat is your Name?");
      assert.deepEqual(turn.draft, {});
    });
  });

  it("preserves recognized scripture books and the synthetic reference in any case", () => {
    for (const [message, expected] of [
      ["Quote Song of Solomon 2:1", "Reference: Song of Solomon 2:1"],
      ["what is song of solomon 2:1?", "Reference: song of solomon 2:1"],
      ["Quote 1 John 4:8", "Reference: 1 John 4:8"],
      ["john 3:16-18", "Reference: john 3:16-18"],
      ["Quote Example 1:1 VERSE-TEXT-NOT-ALLOWED", "Reference: Example 1:1"],
    ]) {
      assert.equal(scriptureReply(message ?? ""), expected);
    }
    assert.equal(scriptureReply("First Bible Church"), null);
    assert.equal(scriptureReply("What time is the service, 10:00?"), null);
  });

  it("indexes only the canonical video title regardless of body text", async () => {
    await withHarness(async (harness) => {
      const page = parseKnowledgeFile([
        "---",
        "url: https://example.invalid/tour",
        "title: Front door tour",
        "kind: video",
        "---",
        "",
        "Video title: Different title. The pastor says the doors are red.",
        "",
        "A transcript discusses the budget.",
      ].join("\n"));
      assert.deepEqual(page.passages, ["Video title: Front door tour"]);
      indexKnowledge(harness.db, [page]);
      assert.equal(replyForSearch("What does the video say?", searchKnowledge(harness.db, "video")), "Video title: Front door tour");
      assert.equal(searchKnowledge(harness.db, "pastor budget").kind, "miss");
    });
  });

  it("drops sentences after a title in direct video search results", () => {
    const outcome = {
      kind: "hits" as const,
      hits: [{
        kind: "hit" as const,
        url: "https://example.invalid/tour",
        title: "Front door tour",
        pageKind: "video" as const,
        passage: "Video title: Front door tour. The pastor says the doors are red.\nThe budget is discussed.",
      }],
    };
    assert.equal(replyForSearch("What does the video say?", outcome), "Video title: Front door tour");
    assert.equal(replyForSearch("Tell me about the front door", outcome), "Video title: Front door tour");
  });

  for (const title of ["St. Mark’s front door tour", "Welcome! Our front door tour"]) {
    it(`preserves the stored video title ${title} and omits its body`, async () => {
      await withHarness(async (harness) => {
        indexKnowledge(harness.db, [{
          url: "https://example.invalid/punctuated-tour",
          title,
          kind: "video",
          passages: [`Video title: ${title}. The pastor says the doors are red.`],
        }]);
        const outcome = searchKnowledge(harness.db, "video");
        assert.equal(outcome.kind, "hits");
        assert.equal(replyForSearch("What does the video say?", outcome), `Video title: ${title}`);
        assert.equal(replyForSearch("Tell me about the front door", outcome), `Video title: ${title}`);
        if (outcome.kind !== "hits") throw new Error("expected video search hit");
        assert.equal(outcome.hits[0]?.title, title);
        assert.equal(outcome.hits[0]?.pageKind, "video");
      });
    });
  }

  it("uses the page kind rather than a video-title prefix in a normal page passage", async () => {
    await withHarness(async (harness) => {
      indexKnowledge(harness.db, [{
        url: "https://example.invalid/article",
        title: "Tour article",
        kind: "page",
        passages: ["Video title: Our tour. This article describes the front door."],
      }]);
      const outcome = searchKnowledge(harness.db, "tour");
      assert.equal(replyForSearch("Tell me about the front door", outcome), "Video title: Our tour. This article describes the front door.");
      assert.equal(replyForSearch("What does the video say?", outcome), "I do not have that in the organization's pages.");
    });
  });
});
