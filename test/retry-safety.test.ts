import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatch } from '../src/http.ts';
import { withHarness } from './helpers.ts';

test('web request identity replays concurrently and rejects changed text', async () => {
  await withHarness(async h => {
    const send = (message: string) => dispatch(h.deps, { method: 'POST', path: '/api/chat', headers: {}, body: JSON.stringify({sessionId:'retry',requestId:'one',message}) });
    const [a,b] = await Promise.all([send('Sample Person'),send('Sample Person')]);
    assert.equal(a.status,200);
    assert.equal(a.body,b.body);
    const state = h.snapshot();
    assert.equal((await send('Sample Person')).body,a.body);
    assert.deepEqual(h.snapshot(),state);
    assert.equal((await send('Different Person')).status,409);
  });
});

import { ImsgRpcClient, ScriptedStdio } from '../src/imsg.ts';
import { replayIncoming } from '../src/replay.ts';
import { openDatabase } from '../src/db.ts';

test('RPC disconnect rejects pending requests and synchronous responses are observed', async () => {
  const io = new ScriptedStdio();
  const client = new ImsgRpcClient(io);
  const pending = client.chats();
  io.close();
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(client.chats(), /disconnected/);
});

test('committed iMessage identity survives reopening and never applies twice', async () => {
  await withHarness(async h => {
    const input = { channel: 'imessage' as const, channelKey:'7',requestId:'guid-1',message:'Sample Person' };
    const first = await replayIncoming(h.deps,input);
    const reopened = openDatabase(h.deps.config.databasePath);
    try {
      assert.deepEqual(await replayIncoming({...h.deps,db:reopened},input),first);
      assert.deepEqual(h.snapshot().sessionGroups.length,1);
    } finally { reopened.close(); }
  });
});

test('intake rolls back if checkpoint insertion fails', async () => {
  await withHarness(async h => {
    h.db.exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON incoming_requests BEGIN SELECT RAISE(ABORT, 'injected crash'); END`);
    const before = h.snapshot();
    await assert.rejects(replayIncoming(h.deps,{channel:'web',channelKey:'rollback',requestId:'one',message:'Sample Person'}),/injected crash/);
    assert.deepEqual(h.snapshot(),before);
  });
});

import { spawnSync } from 'node:child_process';
import { INTAKE_BEFORE_CONFIRM, projectRoot } from './helpers.ts';
import { listRecords } from '../src/recordStore.ts';

test('subprocess crash after consent checkpoint resumes without treating consent as confirmation', async () => {
  await withHarness(async h => {
    for (const message of INTAKE_BEFORE_CONFIRM.slice(0,5)) await h.send('web','crash',message);
    const worker = (crash: boolean) => spawnSync(process.execPath,['--input-type=module','-e',`
      import { openDatabase } from './src/db.ts';
      import { loadConfig } from './src/config.ts';
      import { loadSchema } from './src/schema.ts';
      import { dispatch } from './src/http.ts';
      const config=loadConfig({ DATABASE_PATH:${JSON.stringify(h.deps.config.databasePath)} },process.cwd());
      const db=openDatabase(config.databasePath);
      const deps={db,config,fields:loadSchema(config.schemaPath).fields,now:()=>Date.now(),messenger:{send:async()=>{}},model:{complete:async()=>{ ${crash ? 'process.exit(23);' : ''} return {text:'unsafe'}; }}};
      const response=await dispatch(deps,{method:'POST',path:'/api/chat',headers:{},body:JSON.stringify({sessionId:'crash',requestId:'consent',message:'yes'})});
      console.log(JSON.stringify(response)); db.close();
    `],{cwd:projectRoot,encoding:'utf8',timeout:2500});
    assert.equal(worker(true).status,23);
    const groups=h.snapshot().sessionGroups;
    const recovered=worker(false);
    assert.equal(recovered.status,0,recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).status,200);
    assert.deepEqual(h.snapshot().sessionGroups,groups);
    assert.equal(listRecords(h.db).length,0);
  });
});

import { attachImsgIntake } from '../src/imsg.ts';
import { setImmediate as tick } from 'node:timers/promises';

test('iMessage failed outbound remains pending and restart drains same reply without intake replay', async () => {
  await withHarness(async h => {
    const input={channel:'imessage' as const,channelKey:'+15555550100',requestId:'failed-guid',message:'Sample Person',replyTo:'+15555550100'};
    const reply=await replayIncoming(h.deps,input);
    const before=h.snapshot().sessionGroups;
    class ReplyTransport extends ScriptedStdio {
      constructor(privateFail: boolean) { super(); this.fail=privateFail; }
      fail: boolean;
      override writeLine(line:string) {
        super.writeLine(line);
        const req=JSON.parse(line);
        queueMicrotask(()=>this.receive(JSON.stringify({jsonrpc:'2.0',id:req.id,...(req.method==='send' && this.fail?{error:{message:'failed'}}:{result:req.method==='watch.subscribe'?{subscription:1}:{ok:true}})})));
      }
    }
    const receive=async () => { throw new Error('must use durable reply'); };
    const failed=new ReplyTransport(true);
    await attachImsgIntake(new ImsgRpcClient(failed),receive,h.db);
    assert.equal(h.db.prepare('SELECT sent_at FROM incoming_requests').get()?.sent_at,null);
    const recovered=new ReplyTransport(false);
    await attachImsgIntake(new ImsgRpcClient(recovered),receive,h.db);
    assert.ok(h.db.prepare('SELECT sent_at FROM incoming_requests').get()?.sent_at);
    assert.equal(JSON.parse(recovered.written[0]!).params.text,reply.reply);
    assert.equal(JSON.parse(recovered.written[0]!).params.to,input.replyTo);
    assert.equal(JSON.parse(recovered.written[0]!).params.chat_id,undefined);
    assert.deepEqual(h.snapshot().sessionGroups,before);
    failed.close(); recovered.close();
    await tick();
  });
});

test('RPC records pending call before a synchronous transport reply', async () => {
  class SynchronousTransport extends ScriptedStdio {
    override writeLine(line:string) {
      super.writeLine(line);
      this.receive(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(line).id,result:{chats:[]}}));
    }
  }
  assert.deepEqual(await new ImsgRpcClient(new SynchronousTransport()).chats(),{chats:[]});
});

import { beginCompanionPair } from '../src/imsg.ts';

for (const side of ['local','remote'] as const) {
  test(`pairing rejects an already closed ${side} and closes its sibling`, async () => {
    const local=new ScriptedStdio();
    const remote=new ScriptedStdio();
    const closed = side === 'local' ? local : remote;
    const sibling = side === 'local' ? remote : local;
    closed.close();
    let siblingClosed=false;
    sibling.onClose(()=>{ siblingClosed=true; });
    await assert.rejects(beginCompanionPair(local,remote,'ABCD2345'),/disconnected or timed out/);
    assert.equal(siblingClosed,true);
    assert.deepEqual(remote.written,[]);
  });
}

test('recovery leaves legacy numeric chat replies pending without contacting a reused chat row', async () => {
  await withHarness(async h => {
    await replayIncoming(h.deps,{channel:'imessage',channelKey:'7',requestId:'legacy-guid',message:'Sample Person'});
    class AutoReply extends ScriptedStdio {
      override writeLine(line:string) {
        super.writeLine(line);
        const req=JSON.parse(line);
        queueMicrotask(()=>this.receive(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{ok:true,subscription:1}})));
      }
    }
    const io=new AutoReply();
    await attachImsgIntake(new ImsgRpcClient(io),async()=>{ throw new Error('legacy intake must not replay'); },h.db);
    assert.equal(io.written.some(line=>JSON.parse(line).method==='send'),false);
    assert.equal(h.db.prepare('SELECT sent_at FROM incoming_requests').get()?.sent_at,null);
    io.close();
  });
});

test('checkpoint recipient cannot be changed while replaying private cached wording', async () => {
  await withHarness(async h => {
    const input={channel:'imessage' as const,channelKey:'+15555550100',requestId:'private-guid',message:'Sample Person',replyTo:'+15555550100'};
    await replayIncoming(h.deps,input);
    await assert.rejects(replayIncoming(h.deps,{...input,replyTo:'+15555550101'}));
    assert.equal(h.db.prepare('SELECT reply_to FROM incoming_requests').get()?.reply_to,input.replyTo);
  });
});

import { startImsg } from '../src/imsg-runtime.ts';

test('fresh direct participants sharing a Mac chat row remain isolated and receive only their own replies', async () => {
  await withHarness(async h => {
    class AutoReply extends ScriptedStdio {
      override writeLine(line:string) {
        super.writeLine(line);
        const req=JSON.parse(line);
        queueMicrotask(()=>this.receive(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{ok:true,subscription:1}})));
      }
    }
    const io=new AutoReply();
    startImsg({ mode:'local',command:'unused',db:h.db,now:h.deps.now,pairPort:8791,openLocal:()=>io,
      receive:async (_chatId,text,guid,replyTo)=> {
        assert.ok(guid); assert.ok(replyTo);
        return (await replayIncoming(h.deps,{channel:'imessage',channelKey:replyTo,requestId:guid,message:text,replyTo})).reply;
      },
    });
    await tick();
    for (const [sender,text,guid] of [['+15555550100','Private Person','original-guid'],['+15555550101','/start','new-mac-guid']]) {
      io.receive(JSON.stringify({jsonrpc:'2.0',method:'message',params:{message:{chat_id:7,text,guid,is_from_me:false,is_group:false,chat_identifier:sender,chat_guid:`iMessage;-;${sender}`,participants:[sender],sender}}}));
      await tick();
    }
    const replies=io.written.map(line=>JSON.parse(line)).filter(req=>req.method==='send');
    assert.equal(replies.length,2);
    assert.equal(replies[0].params.to,'+15555550100');
    assert.equal(replies[1].params.to,'+15555550101');
    assert.equal(replies[1].params.text,'What is your Name?');
    const sessions=h.db.prepare("SELECT channel_key FROM sessions WHERE channel = 'imessage' ORDER BY channel_key").all();
    assert.deepEqual(sessions.map(row=>row.channel_key),['+15555550100','+15555550101']);
    // The original GUID may replay under a different rowid after changing Macs.
    const before=h.snapshot();
    io.receive(JSON.stringify({jsonrpc:'2.0',method:'message',params:{message:{chat_id:99,text:'Private Person',guid:'original-guid',is_from_me:false,is_group:false,chat_identifier:'+15555550100',chat_guid:'iMessage;-;+15555550100',participants:['+15555550100'],sender:'+15555550100'}}}));
    await tick();
    assert.deepEqual(h.snapshot(),before);
    assert.equal(io.written.filter(line=>JSON.parse(line).method==='send').length,2);
  });
});

test('unfinished durable iMessage reply resumes against recipient after reopening', async () => {
  await withHarness(async h => {
    const input={channel:'imessage' as const,channelKey:'+15555550100',requestId:'unfinished-guid',message:'Sample Person',replyTo:'+15555550100'};
    const reply=await replayIncoming(h.deps,input);
    h.db.prepare('UPDATE incoming_requests SET result_json = NULL').run();
    const before=h.snapshot();
    const reopened=openDatabase(h.deps.config.databasePath);
    class AutoReply extends ScriptedStdio {
      override writeLine(line:string) {
        super.writeLine(line);
        const req=JSON.parse(line);
        queueMicrotask(()=>this.receive(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{ok:true,subscription:1}})));
      }
    }
    const io=new AutoReply();
    try {
      await attachImsgIntake(new ImsgRpcClient(io),async message=>(await replayIncoming({...h.deps,db:reopened},{channel:'imessage',channelKey:message.replyTo,requestId:message.guid!,message:message.text,replyTo:message.replyTo})).reply,reopened);
      assert.equal(JSON.parse(io.written[0]!).params.to,input.replyTo);
      assert.equal(JSON.parse(io.written[0]!).params.text,reply.reply);
      assert.deepEqual(h.snapshot(),before);
      assert.ok(reopened.prepare('SELECT sent_at FROM incoming_requests').get()?.sent_at);
    } finally { io.close(); reopened.close(); }
  });
});
