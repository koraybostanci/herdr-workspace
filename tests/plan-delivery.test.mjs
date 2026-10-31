import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { v2Fixture, deferred } from './helpers/v2-fixtures.mjs';
import { registerArtifact } from '../integrations/session-metadata/src/plans/artifacts.mjs';
import { saveComment, createSubmission, getSubmission, claimSubmission, updateDelivery } from '../integrations/session-metadata/src/plans/reviews.mjs';
import { processStamp } from '../integrations/session-metadata/src/database.mjs';
import { createPlanRuntime } from '../integrations/session-metadata/src/plans/runtime.mjs';
import { createBindingLifecycle } from '../integrations/session-metadata/src/binding-lifecycle.mjs';
import { bindingKey } from '../integrations/session-metadata/src/protocol.mjs';

const delivery=await import('../integrations/session-metadata/src/plans/delivery.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const mailbox=await import('../integrations/session-metadata/src/plans/provider-mailbox.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const owner=await import('../integrations/session-metadata/opencode/review-provider.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const capabilities=await import('../integrations/session-metadata/src/plans/capabilities.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
async function fixture(t) {
  assert.equal(typeof delivery.dispatchReview,'function');
  const f=await v2Fixture();t.after(f.cleanup);
  const path=join(f.root,'design.md');await writeFile(path,'# Design\nPRIVATE FULL PLAN SOURCE\n');
  const deps={...f,host:'local',proof:f.proof,lifecycle:{verify:async()=>true},enabled:async()=>true};
  const artifact=await registerArtifact({session:f.session,proof:f.proof,path,kind:'design',source:'explicit'},deps);
  const c=saveComment({id:'comment-A',session:f.session,artifactId:artifact.id,expectedRevision:null,text:'Preserve the manual title.',anchor:null,status:'open',documentHash:artifact.hash},f.db).comment;
  const input={session:f.session,artifactId:artifact.id,documentHash:artifact.hash,comments:[{id:c.id,revision:0}],confirmed:true,proof:f.proof};
  const submission=createSubmission(input,f.db),calls=[];
  const provider={admit:async request=>{calls.push(request);return {id:request.messageId,sessionID:request.session.id};},lookup:async()=> 'unknown'};
  return {...f,path,artifact,input,submission,calls,deps:{...deps,provider}};
}

test('user-confirmed review admission uses the exact owning session and stable request message identity',async t=>{
  const f=await fixture(t),result=await delivery.dispatchReview(f.submission.requestId,f.deps);
  assert.equal(result.state,'accepted');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].session,f.session);
  assert.equal(f.calls[0].messageId,'msg_herdr_review_'+f.submission.requestId.replaceAll('-',''));
  assert.equal(f.calls[0].resume,true);
  assert.ok(f.calls[0].text.includes(f.path));assert.ok(f.calls[0].text.includes(f.artifact.hash));
  assert.ok(f.calls[0].text.includes('Preserve the manual title.'));
  assert.equal(f.calls[0].text.includes('PRIVATE FULL PLAN SOURCE'),false);
  assert.equal((await delivery.dispatchReview(f.submission.requestId,f.deps)).state,'accepted');assert.equal(f.calls.length,1);
});

test('plan_send_rejects_reused_or_switched_session and leaves all draft content available',async t=>{
  const f=await fixture(t);
  const result=await delivery.dispatchReview(f.submission.requestId,{...f.deps,lifecycle:{verify:async()=>false}});
  assert.equal(result.state,'failed');assert.equal(result.reason,'target-changed');assert.equal(f.calls.length,0);
  assert.equal(getSubmission(f.submission.requestId,f.db).comments[0].text,'Preserve the manual title.');
});

test('unverified provider capability is Copy-only and never admits a prompt',async t=>{
  const f=await fixture(t),result=await delivery.dispatchReview(f.submission.requestId,{...f.deps,enabled:async()=>false});
  assert.equal(result.state,'failed');assert.equal(result.reason,'delivery-unavailable');assert.equal(f.calls.length,0);
  assert.ok(delivery.formatReview(f.submission,f.artifact).includes('Preserve the manual title.'));
});

test('plan_accept_then_timeout_remains_unknown_until_reconciled without automatic retry',async t=>{
  const f=await fixture(t);let calls=0;
  const deps={...f.deps,provider:{admit:async()=>{calls++;throw Error('acknowledgement lost');},lookup:async()=> 'unknown'}};
  assert.equal((await delivery.dispatchReview(f.submission.requestId,deps)).state,'unknown');
  assert.equal((await delivery.dispatchReview(f.submission.requestId,deps)).state,'unknown');assert.equal(calls,1);
  const reconciled=await delivery.reconcileReview(f.submission.requestId,{...deps,provider:{...deps.provider,lookup:async()=> 'pending'}});
  assert.equal(reconciled.state,'accepted');assert.equal(calls,1);
});

test('mismatched provider session or message acknowledgement is unknown, never accepted',async t=>{
  const f=await fixture(t);
  const result=await delivery.dispatchReview(f.submission.requestId,{...f.deps,provider:{...f.deps.provider,admit:async request=>({id:request.messageId,sessionID:'wrong-session'})}});
  assert.equal(result.state,'unknown');assert.equal(result.reason,'invalid-acknowledgement');
});

test('a changed source revision blocks admission unless the batch explicitly confirmed earlier-revision feedback',async t=>{
  const f=await fixture(t);await writeFile(f.path,'# Updated while reviewing\n');
  const result=await delivery.dispatchReview(f.submission.requestId,f.deps);
  assert.equal(result.state,'failed');assert.equal(result.reason,'document-changed');assert.equal(f.calls.length,0);
});

test('parallel dispatches share one active send and never release another live sender claim',async t=>{
  const f=await fixture(t),entered=deferred(),wait=deferred();let calls=0;
  const deps={...f.deps,provider:{admit:async request=>{calls++;entered.resolve();await wait.promise;return {id:request.messageId,sessionID:request.session.id};},lookup:async()=> 'unknown'}};
  const first=delivery.dispatchReview(f.submission.requestId,deps);await entered.promise;
  const second=await delivery.dispatchReview(f.submission.requestId,deps);
  assert.equal(second.state,'sending');assert.equal(calls,1);
  wait.resolve();assert.equal((await first).state,'accepted');assert.equal(calls,1);
});

test('a crashed sender is reconciled to unknown without replaying a possible admitted review', {timeout:15000},async t=>{
  const f=await fixture(t),child=fork(new URL('./helpers/v2-store-worker.mjs',import.meta.url),[join(f.root,'v2'),'submission'],{silent:true});
  t.after(()=>child.kill());await once(child,'message');
  const claimed=once(child,'message');child.send({claimSubmission:f.submission.requestId});assert.equal((await claimed)[0].value,true);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const result=await delivery.dispatchReview(f.submission.requestId,{...f.deps,provider:{...f.deps.provider,lookup:async()=> 'absent'}});
  assert.equal(result.state,'unknown');assert.equal(f.calls.length,0);
  assert.equal(await readFile(f.path,'utf8'),'# Design\nPRIVATE FULL PLAN SOURCE\n');
});

async function mailboxFixture(t) {
  assert.equal(typeof mailbox.prepareProviderRequest,'function');
  const f=await fixture(t);let now=0n;
  const runtime={...f.deps,root:f.root,appHome:join(f.root,'app'),producerPid:20,monotonic:()=>now,
    run:async(_host,command,args)=>({code:command==='ps'&&args.at(-1)==='20'?0:1,stdout:'fixture-start',stderr:''})};
  const actor={pid:process.pid,startedAt:processStamp(process.pid)};
  claimSubmission(f.submission.requestId,actor,f.db);
  return {...f,runtime,setNow:value=>{now=value;}};
}

test('owner mailbox authorizes one immutable batch once and refuses producer or deadline mismatches',async t=>{
  const f=await mailboxFixture(t),request=await mailbox.prepareProviderRequest(f.submission.requestId,'admit',f.runtime);
  await assert.rejects(mailbox.authorizeProviderRequest(request,{...f.runtime,producerPid:99}),/owner/);
  const authorized=await mailbox.authorizeProviderRequest(request,f.runtime);
  assert.equal(authorized.session.id,f.session.id);assert.equal(authorized.messageId,delivery.reviewMessageId(f.submission.requestId));
  assert.ok(authorized.text.includes('Preserve the manual title.'));assert.equal(authorized.text.includes('PRIVATE FULL PLAN SOURCE'),false);
  await assert.rejects(mailbox.authorizeProviderRequest(request,f.runtime),/already-authorized/);
  const expired=await mailbox.prepareProviderRequest(f.submission.requestId,'lookup',f.runtime);f.setNow(6000000000n);
  await assert.rejects(mailbox.authorizeProviderRequest(expired,f.runtime),/expired/);
});

test('late exact acknowledgement reconciles unknown delivery but cannot acknowledge another target',async t=>{
  const f=await mailboxFixture(t),request=await mailbox.prepareProviderRequest(f.submission.requestId,'admit',f.runtime);
  const authorized=await mailbox.authorizeProviderRequest(request,f.runtime);
  await assert.rejects(mailbox.recordProviderResult({...request,authorizationToken:authorized.authorizationToken,
    result:{kind:'accepted',id:authorized.messageId,sessionID:'other'}},f.runtime),/acknowledgement/);
  updateDelivery(f.submission.requestId,'sending',{state:'unknown',requestId:f.submission.requestId},f.db);f.setNow(60000000000n);
  await mailbox.recordProviderResult({...request,authorizationToken:authorized.authorizationToken,
    result:{kind:'accepted',id:authorized.messageId,sessionID:f.session.id}},f.runtime);
  assert.equal(getSubmission(f.submission.requestId,f.db).delivery.state,'accepted');
});

test('owning client rechecks root after slow canonical lookup and queues accepted reviews without interrupting',async t=>{
  assert.equal(typeof owner.createOpenCodeReviewHandler,'function');
  const f=await mailboxFixture(t),request=await mailbox.prepareProviderRequest(f.submission.requestId,'admit',f.runtime);
  let route=f.session.id;const entered=deferred(),wait=deferred(),calls=[];
  const context={app:{version:'2.test'},ui:{router:{current:()=>({type:'session',sessionID:route})}},data:{session:{root:id=>id}},
    client:{session:{get:async()=>{entered.resolve();await wait.promise;return {id:f.session.id};},prompt:async input=>{calls.push(input);return {id:input.id,sessionID:input.sessionID};}}}};
  const rpc=async req=>{
    try {return {ok:true,value:await (req.op==='owner-review'?mailbox.authorizeProviderRequest(req.payload,f.runtime):mailbox.recordProviderResult(req.payload,f.runtime))};}
    catch(e){return {ok:false,reason:e.message};}
  };
  const handler=owner.createOpenCodeReviewHandler(context,{rpc,scope:{host:'local',authority:'local'},currentProof:()=>f.proof});
  const pending=handler(request);await entered.promise;route='ses_other';wait.resolve();await pending;
  assert.equal(calls.length,0);assert.equal(getSubmission(f.submission.requestId,f.db).delivery.state,'failed');
});

test('real private mailbox round trip uses only the owning connected client and accepts its exact session receipt', {timeout:10000},async t=>{
  assert.equal(typeof owner.startReviewMailbox,'function');
  const f=await fixture(t),calls=[];
  const runtime={...f.deps,root:f.root,appHome:join(f.root,'app'),producerPid:20,
    run:async(_host,command,args)=>({code:command==='ps'&&args.at(-1)==='20'?0:1,stdout:'fixture-start',stderr:''})};
  const directory=await mailbox.ensureProviderMailbox(runtime);
  const context={app:{version:'2.test'},ui:{router:{current:()=>({type:'session',sessionID:f.session.id})}},data:{session:{root:id=>id}},
    client:{session:{get:async(_input,options)=>{assert.equal(options?.signal?.aborted,false);return {id:f.session.id};},
      prompt:async(input,options)=>{assert.equal(options?.signal?.aborted,false);calls.push(input);return {data:{id:input.id,sessionID:input.sessionID}};}}}};
  const rpc=async req=>{
    try {return {ok:true,value:await (req.op==='owner-review'?mailbox.authorizeProviderRequest(req.payload,runtime):mailbox.recordProviderResult(req.payload,runtime))};}
    catch(e){return {ok:false,reason:e.message};}
  };
  const stop=await owner.startReviewMailbox(directory,owner.createOpenCodeReviewHandler(context,{rpc,scope:{host:'local',authority:'local'},currentProof:()=>f.proof}));t.after(stop);
  const result=await delivery.dispatchReview(f.submission.requestId,{...runtime,provider:mailbox.createMailboxProvider(runtime)});
  assert.equal(result.state,'accepted');assert.equal(calls.length,1);assert.equal(calls[0].sessionID,f.session.id);
  assert.equal(calls[0].delivery,'queue');assert.equal(calls[0].resume,true);
});

async function capabilityFixture(t) {
  assert.equal(typeof capabilities.readDeliveryCapability,'function');
  const f=await fixture(t),bundleRoot=join(f.root,'bundle'),appHome=join(f.root,'app');
  await mkdir(bundleRoot);await mkdir(join(appHome,'data/session-plans'),{recursive:true});
  const source='export const protocol = 2;\n',sha=value=>createHash('sha256').update(value).digest('hex');
  await writeFile(join(bundleRoot,'provider.mjs'),source);
  const files={'provider.mjs':sha(source)},buildHash=sha(JSON.stringify(Object.entries(files)));
  await writeFile(join(bundleRoot,'build-manifest.json'),JSON.stringify({schema:1,owner:'herdr-session-metadata',protocol:2,files,buildHash}));
  const entry={...f.session,buildHash,providerVersion:'2.test',mode:'send',probeReceived:true,noModelCalls:true};delete entry.id;
  const path=join(appHome,'data/session-plans/delivery-capabilities.json');
  await writeFile(path,JSON.stringify({schema:1,owner:'herdr-session-metadata',entries:[entry]}));
  return {...f,bundleRoot,appHome,entry,capabilityPath:path,runtime:{...f.deps,bundleRoot,appHome}};
}

test('delivery gate requires exact runtime bytes, provider version and execution authority',async t=>{
  const f=await capabilityFixture(t);
  assert.equal((await capabilities.readDeliveryCapability(f.proof,f.runtime,{providerVersion:'2.test'})).send,true);
  assert.equal((await capabilities.readDeliveryCapability(f.proof,f.runtime,{providerVersion:'2.other'})).send,false);
  assert.equal((await capabilities.readDeliveryCapability({...f.proof,session:{...f.session,authority:'other'}},f.runtime,{providerVersion:'2.test'})).send,false);
  await writeFile(join(f.bundleRoot,'provider.mjs'),'export const protocol = 999;');
  assert.equal((await capabilities.readDeliveryCapability(f.proof,f.runtime,{providerVersion:'2.test'})).send,false);
});

test('probe-only capability can never enable a normal resume=true turn or an unowned namespace',async t=>{
  const f=await capabilityFixture(t);
  await writeFile(f.capabilityPath,JSON.stringify({schema:1,owner:'herdr-session-metadata',entries:[{...f.entry,mode:'probe',probeSessions:[f.session.id]}]}));
  const own={...f.proof,coreSession:'herdr-plan-probe-owned'};
  const probe=await capabilities.readDeliveryCapability(own,f.runtime,{providerVersion:'2.test',resume:false});
  assert.equal(probe.send,false);assert.equal(probe.probeAllowed,true);
  assert.equal((await capabilities.readDeliveryCapability(own,f.runtime,{providerVersion:'2.test',resume:true})).probeAllowed,false);
  assert.equal((await capabilities.readDeliveryCapability(f.proof,f.runtime,{providerVersion:'2.test',resume:false})).probeAllowed,false);
});

test('unverified live helper dispatch remains gated and receipts cannot be read under a different session',async t=>{
  const f=await fixture(t),runtime=createPlanRuntime({...process.env,HERDR_APP_HOME:join(f.root,'app')},{db:f.db,run:f.run,clock:f.clock});
  const result=await runtime.bridge.handle({op:'dispatch',payload:{session:f.session,requestId:f.submission.requestId}});
  assert.equal(result.ok,true);assert.equal(result.value.state,'failed');assert.equal(result.value.reason,'delivery-unavailable');
  const wrong=await runtime.bridge.handle({op:'receipt',payload:{session:{...f.session,id:'wrong'},requestId:f.submission.requestId}});
  assert.equal(wrong.ok,false);
});

test('a disposed owning plugin cannot admit a review after a slow canonical read completes',async t=>{
  const f=await mailboxFixture(t),request=await mailbox.prepareProviderRequest(f.submission.requestId,'admit',f.runtime);
  const entered=deferred(),wait=deferred();let active=true,calls=0;
  const context={app:{version:'2.test'},ui:{router:{current:()=>({type:'session',sessionID:f.session.id})}},data:{session:{root:id=>id}},
    client:{session:{get:async()=>{entered.resolve();await wait.promise;return {id:f.session.id};},prompt:async input=>{calls++;return {id:input.id,sessionID:input.sessionID};}}}};
  const rpc=async req=>{try{return {ok:true,value:await(req.op==='owner-review'?mailbox.authorizeProviderRequest(req.payload,f.runtime):mailbox.recordProviderResult(req.payload,f.runtime))};}catch(e){return {ok:false,reason:e.message};}};
  const handler=owner.createOpenCodeReviewHandler(context,{rpc,scope:{host:'local',authority:'local'},active:()=>active,currentProof:()=>f.proof});
  const pending=handler(request);await entered.promise;active=false;wait.resolve();await pending;
  assert.equal(calls,0);assert.equal(getSubmission(f.submission.requestId,f.db).delivery.state,'failed');
});

test('returning to the same root with a new generation cannot revive an older review grant',async t=>{
  const f=await mailboxFixture(t),request=await mailbox.prepareProviderRequest(f.submission.requestId,'admit',f.runtime);
  const entered=deferred(),wait=deferred();let proof=f.proof,calls=0;
  const context={app:{version:'2.test'},ui:{router:{current:()=>({type:'session',sessionID:f.session.id})}},data:{session:{root:id=>id}},
    client:{session:{get:async()=>{entered.resolve();await wait.promise;return {id:f.session.id};},prompt:async input=>{calls++;return {id:input.id,sessionID:input.sessionID};}}}};
  const rpc=async req=>{try{return {ok:true,value:await(req.op==='owner-review'?mailbox.authorizeProviderRequest(req.payload,f.runtime):mailbox.recordProviderResult(req.payload,f.runtime))};}catch(e){return {ok:false,reason:e.message};}};
  const handler=owner.createOpenCodeReviewHandler(context,{rpc,scope:{host:'local',authority:'local'},currentProof:()=>proof});
  const pending=handler(request);await entered.promise;proof={...proof,generation:'replacement-generation'};wait.resolve();await pending;
  assert.equal(calls,0);
});

test('read-only receipt reconciliation can use fresh same-session ownership after reconnect without rewriting the frozen batch',async t=>{
  const f=await mailboxFixture(t);
  const fresh={...f.proof,processPid:30,processStartedAt:'new-start',generation:'new-generation'};
  createBindingLifecycle(f.db,f.deps);
  f.db.sql.prepare('INSERT INTO channel_bindings VALUES (?,?,?,?)').run('plan',bindingKey(fresh),JSON.stringify(fresh),'active');
  const runtime={...f.runtime,producerPid:30,lifecycle:{verify:async proof=>proof.generation==='new-generation'},
    run:async()=>({code:0,stdout:'new-start',stderr:''})};
  const request=await mailbox.prepareProviderRequest(f.submission.requestId,'lookup',runtime);
  const grant=await mailbox.authorizeProviderRequest(request,runtime);
  assert.equal(grant.proof.generation,'new-generation');
  assert.equal(getSubmission(f.submission.requestId,f.db).proof.generation,'generation-A');
});

test('owner mailbox serializes and coalesces filesystem hints without replaying work after disposal',async()=>{
  assert.equal(typeof owner.createSerialRequestQueue,'function');
  const entered=deferred(),wait=deferred(),calls=[];
  const queue=owner.createSerialRequestQueue(async id=>{calls.push(id);if(id==='one'){entered.resolve();await wait.promise;}});
  const first=queue.enqueue('one');assert.equal(queue.enqueue('one'),first);
  const second=queue.enqueue('two');await entered.promise;assert.deepEqual(calls,['one']);
  wait.resolve();await Promise.all([first,second]);assert.deepEqual(calls,['one','two']);
  queue.close();await queue.enqueue('late');assert.deepEqual(calls,['one','two']);
});

test('receipt lookup uses bounded exact-session API reads for pending and projected messages',async t=>{
  const f=await mailboxFixture(t),calls=[];let pending=true;
  const messageId=delivery.reviewMessageId(f.submission.requestId);
  const context={app:{version:'2.test'},client:{session:{inbox:{list:async(input,options)=>{
    calls.push(['inbox',input.sessionID]);assert.equal(options?.signal?.aborted,false);
    return {data:pending?[{id:messageId,sessionID:f.session.id,type:'user',time:{created:1000},delivery:'queue',payload:{text:'review'}}]:[]};
  }},message:{get:async(input,options)=>{
    calls.push(['message',input.sessionID,input.messageID]);assert.equal(options?.signal?.aborted,false);
    return {data:{id:messageId,type:'user',time:{created:1000},metadata:{},text:'review'}};
  }}}}};
  const rpc=async req=>{try{return {ok:true,value:await(req.op==='owner-review'?mailbox.authorizeProviderRequest(req.payload,f.runtime):mailbox.recordProviderResult(req.payload,f.runtime))};}catch(e){return {ok:false,reason:e.message};}};
  const handler=owner.createOpenCodeReviewHandler(context,{rpc,scope:{host:'local',authority:'local'}});
  const first=await mailbox.prepareProviderRequest(f.submission.requestId,'lookup',f.runtime);await handler(first);
  assert.equal(JSON.parse(f.db.sql.prepare('SELECT result FROM plan_provider_requests WHERE id=?').get(first.id).result).receipt,'pending');
  pending=false;const second=await mailbox.prepareProviderRequest(f.submission.requestId,'lookup',f.runtime);await handler(second);
  assert.equal(JSON.parse(f.db.sql.prepare('SELECT result FROM plan_provider_requests WHERE id=?').get(second.id).result).receipt,'delivered');
  assert.deepEqual(calls,[['inbox',f.session.id],['inbox',f.session.id],['message',f.session.id,messageId]]);
});

test('terminal mailbox requests expire after one day without deleting unknown submissions or their review history',async t=>{
  const f=await mailboxFixture(t);let now=1000;
  const runtime={...f.runtime,clock:()=>now};
  const done=await mailbox.prepareProviderRequest(f.submission.requestId,'admit',runtime),grant=await mailbox.authorizeProviderRequest(done,runtime);
  await mailbox.recordProviderResult({...done,authorizationToken:grant.authorizationToken,result:{kind:'accepted',id:grant.messageId,sessionID:f.session.id}},runtime);
  const retry=createSubmission({...f.input,retryOf:f.submission.requestId,confirmedRetry:true},f.db);
  claimSubmission(retry.requestId,{pid:process.pid,startedAt:processStamp(process.pid)},f.db);
  const uncertain=await mailbox.prepareProviderRequest(retry.requestId,'admit',runtime),other=await mailbox.authorizeProviderRequest(uncertain,runtime);
  await mailbox.recordProviderResult({...uncertain,authorizationToken:other.authorizationToken,result:{kind:'unknown'}},runtime);
  now=86401001;const directory=await mailbox.ensureProviderMailbox(runtime);
  assert.equal(f.db.sql.prepare('SELECT id FROM plan_provider_requests WHERE id=?').get(done.id),undefined);
  await assert.rejects(lstat(join(directory,done.id+'.ack.json')),/ENOENT/);
  assert.ok(f.db.sql.prepare('SELECT id FROM plan_provider_requests WHERE id=?').get(uncertain.id));
  assert.equal(getSubmission(f.submission.requestId,f.db).comments[0].text,'Preserve the manual title.');
  assert.equal(getSubmission(retry.requestId,f.db).delivery.state,'unknown');
});
