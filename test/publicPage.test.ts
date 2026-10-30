import assert from "node:assert/strict";
import { it } from "node:test";
import { dispatch } from "../src/http.ts";
import { withHarness } from "./helpers.ts";
it("escapes every church name token without injecting HTML", async () => {
  const { renderPublicPage } = await import("../src/publicPage.ts");
  assert.equal(renderPublicPage('<title>{{ORGANIZATION_NAME}}</title><h1>{{ORGANIZATION_NAME}}</h1>', '<img src=x onerror="bad"> & \'church\''), '<title>&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; &#39;church&#39;</title><h1>&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; &#39;church&#39;</h1>');
});

it("serves the configured church name and explains draft storage", async () => {
  await withHarness(async (harness) => {
    harness.deps.organizationName = "Church <North> & Friends";
    const response = await dispatch(harness.deps, { method: "GET", path: "/", headers: {}, body: "" });
    assert.equal(response.status, 200);
    assert.match(response.body, /<h1>Church &lt;North&gt; &amp; Friends<\/h1>/);
    assert.doesNotMatch(response.body, /\{\{ORGANIZATION_NAME\}\}/);
    assert.match(response.body, /answers are saved as a draft/);
    assert.doesNotMatch(response.body, /same HTTP API as Telegram/);
  });
});
