import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessClaim, factsFromOutcome, replyForSearch, requireHits } from "../src/grounding.ts";
import { searchKnowledge } from "../src/knowledge.ts";
import { scriptureReply } from "../src/scripture.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

describe("knowledge grounding", () => {
  it("keeps a search miss from becoming a fact", async () => {
    await withHarness(async (harness) => {
    const outcome = searchKnowledge(harness.db, "submarine drydock");
    assert.equal(outcome.kind, "miss");
    assert.equal(Object.hasOwn(outcome, "hits"), false);
    assert.equal(Object.hasOwn(outcome, "url"), false);
    assert.equal(Object.hasOwn(outcome, "passage"), false);
    assert.deepEqual(factsFromOutcome(outcome), []);
    assert.equal(assessClaim("The building has a drydock", outcome).supported, false);
    assert.throws(() => requireHits(outcome), /miss is not a hit/);
    const reply = replyForSearch("Does the building have a submarine?", outcome);
    assert.equal(reply, "I do not have that in the organization's pages.");
    assert.equal(reply.includes("submarine"), false);
    });
  });

  it("does not treat an unsupported claim as supported", async () => {
    await withHarness(async (harness) => {
    const outcome = searchKnowledge(harness.db, "video");
    assert.equal(outcome.kind, "hits");
    if (outcome.kind !== "hits") throw new Error("expected hits");
    assert.ok(outcome.hits.every((hit) => hit.kind === "hit" && hit.url && hit.passage));
    assert.equal(assessClaim("The video says the doors are red", outcome).supported, false);
    assert.equal(assessClaim("Video title: Front door tour", outcome).supported, true);
    assert.equal(
      replyForSearch("What does the video say about the budget?", outcome),
      "Video title: Front door tour",
    );

    const phone = searchKnowledge(harness.db, "office phone");
    assert.equal(assessClaim("The office phone is 555-0199", phone).supported, false);
    const supported = assessClaim("The office phone is 555-0100.", phone);
    assert.equal(supported.supported, true);
    if (supported.supported) {
      assert.equal(supported.url, "https://example-community-church.example/contact");
      assert.match(supported.passage, /555-0100/);
    }
    });
  });

  it("returns a scripture reference and does not return verse wording", async () => {
    await withHarness(async (harness) => {
    const direct = scriptureReply("Quote the verse Example 1:1 VERSE-TEXT-NOT-ALLOWED");
    assert.equal(direct, "Reference: Example 1:1");
    assert.equal(scriptureReply("Quote Example 1:1 VERSE-TEXT-NOT-ALLOWED"), "Reference: Example 1:1");
    assert.equal(direct?.includes("VERSE-TEXT-NOT-ALLOWED"), false);

    const turn = await harness.send(
      "web",
      "scripture",
      "Quote Example 1:1 VERSE-TEXT-NOT-ALLOWED",
    );
    assert.equal(turn.reply.startsWith("Reference: Example 1:1"), true);
    assert.equal(turn.reply.includes("Quote Example"), false);
    assert.equal(turn.reply.includes("VERSE-TEXT-NOT-ALLOWED"), false);
    assert.equal(harness.model.requests.at(-1)?.messages[0]?.content.includes(harness.schema.title), false);
    });
  });

  it("answers from a passage and speaks a video title only", async () => {
    await withHarness(async (harness) => {
    for (const message of [...INTAKE_BEFORE_CONFIRM, "yes"]) {
      await harness.send("web", "pages", message);
    }
    const phone = await harness.send("web", "pages", "What is the office phone?");
    assert.match(phone.reply, /The office phone is 555-0100/);
    assert.equal(phone.status, "saved");

    const video = await harness.send("web", "pages", "What does the video say about the budget?");
    assert.equal(video.reply, "Video title: Front door tour");
    assert.equal(video.reply.includes("budget"), false);

    const miss = await harness.send("web", "pages", "Does the building have a submarine?");
    assert.equal(miss.reply, "I do not have that in the organization's pages.");
    assert.equal(miss.reply.includes("submarine"), false);
    });
  });
});
