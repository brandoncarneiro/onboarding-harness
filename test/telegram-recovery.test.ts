import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { listRecords } from "../src/recordStore.ts";
import { INTAKE_BEFORE_CONFIRM, projectRoot, withHarness, type Harness } from "./helpers.ts";

function worker(h: Harness, phase: "apply" | "checkpoint" | "send" | "recover") {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { openDatabase } from './src/db.ts';
    import { loadConfig } from './src/config.ts';
    import { loadSchema } from './src/schema.ts';
    import { dispatch } from './src/http.ts';
    const config = loadConfig({ DATABASE_PATH: ${JSON.stringify(join(h.dir, "test.sqlite"))}, TELEGRAM_WEBHOOK_SECRET: 'test-secret' }, process.cwd());
    const db = openDatabase(config.databasePath);
    if (${JSON.stringify(phase)} === 'checkpoint') {
      db.function('interrupt_checkpoint', () => process.exit(25));
      db.exec('CREATE TRIGGER interrupt_checkpoint BEFORE UPDATE OF applied_reply ON telegram_updates BEGIN SELECT interrupt_checkpoint(); END');
    }
    let modelCalls = 0;
    const sent = [];
    const deps = { db, config, fields: loadSchema(config.schemaPath).fields,
      now: () => ${h.deps.now()},
      model: { complete: async (request) => {
        modelCalls++;
        if (${JSON.stringify(phase)} === 'apply') process.exit(23);
        return { text: request.safeText };
      } },
      messenger: { send: async (chatId, text) => {
        if (${JSON.stringify(phase)} === 'send') process.exit(24);
        sent.push({chatId, text});
      } },
    };
    const request = {method:'POST', path:'/api/telegram/webhook', headers:{'x-telegram-bot-api-secret-token':'test-secret'},
      body:JSON.stringify({update_id:600, message:{message_id:600, chat:{id:42,type:'private'}, from:{id:42}, text:'yes'}})};
    const responses = await Promise.all([dispatch(deps,request), dispatch(deps,request)]);
    const beforeReplay = db.prepare('SELECT total_changes() AS n').get().n;
    await dispatch(deps,request);
    const replayWrites = db.prepare('SELECT total_changes() AS n').get().n - beforeReplay;
    console.log(JSON.stringify({responses, sent, modelCalls, replayWrites}));
    db.close();
  `], { cwd: projectRoot, encoding: "utf8", timeout: 2500 });
}

async function seed(h: Harness, consent = false): Promise<void> {
  for (const message of INTAKE_BEFORE_CONFIRM.slice(0, consent ? 6 : 5)) {
    await h.send("telegram", "42", message);
  }
}

function recovered(h: Harness, expectedModelCalls: number): void {
  const result = worker(h, "recover");
  assert.equal(result.status, 0, `redelivery must finish without waiting for a dead worker: ${result.error?.message ?? result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sent.length, 1);
  assert.equal(output.sent[0].chatId, "42");
  assert.match(output.sent[0].text, /Confirm this exact set of details/);
  assert.equal(output.responses[0].status, 200);
  assert.deepEqual(output.responses[0], output.responses[1]);
  assert.equal(output.modelCalls, expectedModelCalls);
  assert.equal(output.replayWrites, 0);
  assert.equal(listRecords(h.db).length, 0, "recovering consent must never act as a new confirmation");
  const stored = h.db.prepare("SELECT state, sent_at FROM telegram_updates WHERE update_id = 600").get();
  assert.equal(stored?.state, "sent");
  assert.ok(stored?.sent_at);
}

it("recovers sending after a worker exits, delivering the stored reply once without reapplying", () => withHarness(async (h) => {
  await seed(h);
  assert.equal(worker(h, "send").status, 24);
  assert.equal(h.db.prepare("SELECT state FROM telegram_updates WHERE update_id = 600").get()?.state, "sending");
  const groups = h.snapshot().sessionGroups;
  recovered(h, 0);
  assert.deepEqual(h.snapshot().sessionGroups, groups);
}));

it("recovers applying after consent changed the draft but before the final reply was saved", () => withHarness(async (h) => {
  await seed(h);
  assert.equal(worker(h, "apply").status, 23);
  const stored = h.db.prepare("SELECT state, reply FROM telegram_updates WHERE update_id = 600").get();
  assert.equal(stored?.state, "applying");
  assert.equal(stored?.reply, "");
  const groups = h.snapshot().sessionGroups;
  recovered(h, 0);
  assert.deepEqual(h.snapshot().sessionGroups, groups);
}));

it("finishes an abandoned applying claim that has not yet changed the intake", () => withHarness(async (h) => {
  await seed(h);
  h.db.prepare("INSERT INTO telegram_updates (update_id,reply,chat_id,state) VALUES (600,'','42','applying')").run();
  recovered(h, 1);
}));

it("recovers legacy applying consent without reinterpreting it as confirmation", () => withHarness(async (h) => {
  await seed(h, true);
  h.db.prepare("INSERT INTO telegram_updates (update_id,reply,chat_id,state) VALUES (600,'','42','applying')").run();
  const groups = h.snapshot().sessionGroups;
  recovered(h, 1);
  assert.deepEqual(h.snapshot().sessionGroups, groups);
}));

it("rolls back intake mutations if the worker exits before their reply checkpoint commits", () => withHarness(async (h) => {
  await seed(h);
  const groups = h.snapshot().sessionGroups;
  assert.equal(worker(h, "checkpoint").status, 25);
  assert.deepEqual(h.snapshot().sessionGroups, groups, "intake and checkpoint must commit together");
  h.db.exec("DROP TRIGGER interrupt_checkpoint");
  recovered(h, 1);
}));
