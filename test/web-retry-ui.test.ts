import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { dispatch } from "../src/http.ts";
import { INTAKE_BEFORE_CONFIRM, withHarness } from "./helpers.ts";

for (const recovery of ["retry button", "page reload"] as const) {
  it(`reuses the consent request after response loss via ${recovery}`, async () => {
    await withHarness(async (harness) => {
      for (const message of INTAKE_BEFORE_CONFIRM.slice(0, 5)) await harness.send("web", "visitor", message);
      const storage = new Map<string, string>([["onboarding-harness-session", "visitor"]]);
      const requests: { sessionId: string; requestId: string; message: string }[] = [];
      let loseReply = true;
      const source = readFileSync(process.env.UI_TEMPLATE_PATH || new URL("../public/index.html", import.meta.url), "utf8");
      const script = /<script>([\s\S]*?)<\/script>/.exec(source)?.[1];
      assert.ok(script);
      function load() {
        let submit: () => void = () => {};
        const log = { textContent: "", scrollTop: 0, scrollHeight: 0 };
        const input = { value: "", disabled: false, focus() {} };
        const button = { disabled: false, textContent: "Send" };
        const form = { querySelector: () => button, addEventListener(_name: string, handler: (event: unknown) => void) {
          submit = () => handler({ preventDefault() {} });
        } };
        runInNewContext(script!, {
          document: { querySelector: (selector: string) => selector === "#log" ? log : selector === "#chat" ? form : input },
          crypto: { randomUUID },
          sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
          fetch: async (_url: string, init: { body: string }) => {
            const request = JSON.parse(init.body);
            requests.push(request);
            const response = await dispatch(harness.deps, { method: "POST", path: "/api/chat", headers: {}, body: init.body });
            if (request.message === "yes" && loseReply) { loseReply = false; throw new Error("response lost after commit"); }
            return new Response(response.body, { status: response.status });
          },
        });
        return { input, button, log, submit: () => submit() };
      }
      let page = load();
      await setImmediate();
      page.input.value = "yes";
      page.submit();
      await setImmediate();
      assert.equal(harness.snapshot().records.length, 0);
      assert.match(page.log.textContent, /could not confirm delivery/i);
      assert.equal(page.input.disabled, true);
      if (recovery === "page reload") page = load();
      else page.submit();
      await setImmediate();
      const consent = requests.filter((request) => request.message === "yes");
      assert.equal(consent.length, 2);
      assert.ok(consent[0]?.requestId);
      assert.equal(consent[0]?.requestId, consent[1]?.requestId);
      assert.equal(harness.snapshot().records.length, 0, "replayed consent must not confirm the intake");
      assert.match(page.log.textContent, /Confirm this exact set/);
      assert.equal(page.input.disabled, false);
      page.input.value = "Yes";
      page.submit();
      await setImmediate();
      assert.equal(harness.snapshot().records.length, 1);
      assert.notEqual(requests.at(-1)?.requestId, consent[0]?.requestId);
      assert.match(page.log.textContent, /details are saved/i);
    });
  });
}
