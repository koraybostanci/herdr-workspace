import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { v2Fixture, deferred, proof } from './helpers/v2-fixtures.mjs';
import { createPlanRuntime } from '../integrations/session-metadata/src/plans/runtime.mjs';

const lifecycleModule=await import('../integrations/session-metadata/src/binding-lifecycle.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const bridgeModule=await import('../integrations/session-metadata/src/plans/bridge.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const adapterModule=await import('../integrations/session-metadata/opencode/plans.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const claudeModule=await import('../integrations/session-metadata/claude/plans.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const execute=promisify(execFile);

async function fixture(t) {
  const f=await v2Fixture();t.after(f.cleanup);
  let now=1000;
  const labels={'herdr.space':'space-A','herdr.tab':'tab-A','herdr.meta-binding':'unchanged-v1'};
  const term={state:'live',created_ms:100,pid:10,foreground:{pid:20},labels};
  const run=async(host,command,args,options={})=>{
    assert.equal(host,'local');f.calls.push({command,args,options});
    if(command==='hc'&&args[0]==='get')return {code:0,stdout:JSON.stringify(term),stderr:''};
    if(command==='hc'&&args[0]==='label'){
      const separator=args[2].indexOf('=');labels[args[2].slice(0,separator)]=args[2].slice(separator+1);
      return {code:0,stdout:'',stderr:''};
    }
    if(command==='ps'&&args[1]==='lstart=')return {code:0,stdout:args.at(-1)==='20'?'fixture-start':'terminal-start',stderr:''};
    return {code:1,stdout:'',stderr:'unsupported fixture request'};
  };
  assert.equal(typeof lifecycleModule.createBindingLifecycle,'function');
  const lifecycle=lifecycleModule.createBindingLifecycle(f.db,{run,clock:()=>now});
  const terminal={coreHost:'local',coreSession:'fixture',terminal:'t-plan',createdMs:100};
  const reserve=(session=f.session,expectedGeneration=null)=>lifecycle.reserve({channel:'plan',session,terminal,producer:{pid:20,startedAt:'fixture-start'},expectedGeneration});
  return {...f,term,labels,run,lifecycle,terminal,reserve,clock:()=>now,setNow:n=>{now=n;}};
}

test('plan_registration_requires_exact_session_and_file proof while preserving v1 authority',async t=>{
  const f=await fixture(t),reservation=await f.reserve();
  assert.ok(reservation);
  const proof={...f.proof,generation:reservation.token};
  assert.equal(await f.lifecycle.commit(reservation,proof),true);
  assert.equal(await f.lifecycle.verify(proof),true);
  assert.equal(f.labels['herdr.meta-binding'],'unchanged-v1');
  assert.equal(await f.lifecycle.verify({...proof,session:{...proof.session,id:'ses_other'}}),false);
  assert.equal(await f.lifecycle.verify({...proof,processStartedAt:'replacement'}),false);
  f.setNow(46001);assert.equal(await f.lifecycle.verify(proof),false);
});

test('delayed plan registration cannot overwrite a newer route generation or clear it on release',async t=>{
  const f=await fixture(t),old=await f.reserve(),newSession={...f.session,id:'ses_plan_B'};
  const next=await f.reserve(newSession),proof={...f.proof,session:newSession,generation:next.token};
  assert.equal(await f.lifecycle.commit(next,proof),true);
  assert.equal(await f.lifecycle.commit(old,{...f.proof,generation:old.token}),false);
  await f.lifecycle.invalidate({channel:'plan',...f.terminal},old.token);
  assert.equal(await f.lifecycle.verify(proof),true);
});

test('uncertain label acknowledgement is never a usable plan proof',async t=>{
  const f=await fixture(t);
  const run=async(...args)=>args[1]==='hc'&&args[2][0]==='label'?{code:1,stdout:'',stderr:'uncertain'}:f.run(...args);
  const lifecycle=lifecycleModule.createBindingLifecycle(f.db,{run,clock:f.clock}),reservation=await f.reserve();
  const proof={...f.proof,generation:reservation.token};
  assert.equal(await lifecycle.commit(reservation,proof),false);
  assert.equal(await lifecycle.verify(proof),false);
});

test('plan_authority_and_host_collision_isolated and wrong producer cannot register',async t=>{
  const f=await fixture(t),reservation=await f.reserve();
  assert.equal(await f.lifecycle.commit(reservation,{...f.proof,generation:reservation.token,session:{...f.session,authority:'other'}}),false);
  assert.equal(await f.lifecycle.commit(reservation,{...f.proof,generation:reservation.token,processPid:99}),false);
  assert.equal(f.labels['herdr.plan-binding'],undefined);
});

test('private native requests are one-use and idempotent without passing content on argv',async t=>{
  assert.equal(typeof bridgeModule.createPlanBridge,'function');
  const f=await v2Fixture();t.after(f.cleanup);
  const runtime={...f,appHome:join(f.root,'app'),producerPid:20};let writes=0;
  const bridge=bridgeModule.createPlanBridge(runtime,{operations:{'save-comment':payload=>({saved:++writes,text:payload.text})}});
  const prepared=await bridge.prepare('save-comment');
  await writeFile(prepared.path,JSON.stringify({nonce:prepared.nonce,payload:{text:'Private draft'}}));
  assert.deepEqual((await bridge.apply(prepared.id)).value,{saved:1,text:'Private draft'});
  assert.deepEqual((await bridge.apply(prepared.id)).value,{saved:1,text:'Private draft'});
  assert.equal(writes,1);
  await assert.rejects(bridge.prepare('run-shell'),/operation/);
  const malformed=await bridge.prepare('save-comment');
  await writeFile(malformed.path,JSON.stringify({nonce:'wrong',payload:{text:'wrong'}}));
  assert.equal((await bridge.apply(malformed.id)).ok,false);assert.equal(writes,1);
});

test('native request symlinks and forged request identities cannot escape their private directory',async t=>{
  assert.equal(typeof bridgeModule.createPlanBridge,'function');
  const f=await v2Fixture();t.after(f.cleanup);
  const bridge=bridgeModule.createPlanBridge({...f,appHome:join(f.root,'app')},{operations:{list:()=>[]}});
  assert.equal((await bridge.apply('../outside')).ok,false);
  const request=await bridge.prepare('list'),outside=join(f.root,'outside.json');
  await writeFile(outside,JSON.stringify({nonce:request.nonce,payload:{}}));
  const {unlink}=await import('node:fs/promises');await unlink(request.path);await symlink(outside,request.path);
  assert.equal((await bridge.apply(request.id)).ok,false);
  assert.ok((await readFile(outside,'utf8')).includes(request.nonce));
});

test('owning OpenCode route is rechecked after canonical lookup before plan attestation',async()=>{
  assert.equal(typeof adapterModule.createOpenCodePlanAdapter,'function');
  const wait=deferred(),entered=deferred(),calls=[];let current='ses_plan_A';
  const context={ui:{router:{current:()=>({type:'session',sessionID:current})}},
    client:{session:{get:async()=>{entered.resolve();await wait.promise;return {id:'ses_plan_A',title:'A',location:{directory:'/task'}};}}},
    data:{session:{root:id=>id}}};
  const adapter=adapterModule.createOpenCodePlanAdapter(context,{rpc:async req=>{calls.push(req);return {ok:true,value:{token:'reservation-A'}};},scope:{host:'local',authority:'local'}});
  const pending=adapter.refresh();await entered.promise;current='ses_plan_B';wait.resolve();await pending;
  assert.equal(calls.some(c=>c.op==='owner-commit'),false);
});

test('fixed Node CLI initializes only the chosen isolated state and has a usable empty snapshot',async t=>{
  const f=await v2Fixture();t.after(f.cleanup);
  const env={...process.env,HERDR_METADATA_STATE_DIR:f.root,HERDR_APP_HOME:join(f.root,'app'),HC_SESSION:'plan-test-owned'};
  const helper=new URL('../integrations/session-metadata/bin/herdr-plan.mjs',import.meta.url).pathname;
  const initialized=await execute(process.execPath,[helper,'init'],{env});
  assert.equal(JSON.parse(initialized.stdout).ok,true);
  const snapshot=JSON.parse((await execute(process.execPath,[helper,'snapshot'],{env})).stdout);
  assert.equal(snapshot.ok,true);assert.equal(snapshot.value.owner,'herdr-session-plans');
  assert.deepEqual(snapshot.value.entries,[]);
  assert.equal(await readFile(join(f.root,'app/data/session-plans/view-v1.json'),'utf8').then(JSON.parse).then(x=>x.sequence>0),true);
});

test('plan publication drops an older delayed collection instead of replacing a newer view',async t=>{
  assert.equal(typeof bridgeModule.publishPlanView,'function');
  const f=await fixture(t),r=await f.reserve(),proof={...f.proof,generation:r.token};
  await f.lifecycle.commit(r,proof);
  const slow=deferred(),entered=deferred();let calls=0;
  const runtime={...f,appHome:join(f.root,'app'),lifecycle:{verify:async p=>{
    if(++calls===1){entered.resolve();await slow.promise;}return f.lifecycle.verify(p);
  }}};
  const old=bridgeModule.publishPlanView(runtime);await entered.promise;
  await bridgeModule.publishPlanView(runtime);slow.resolve();await old;
  const final=JSON.parse(await readFile(join(runtime.appHome,'data/session-plans/view-v1.json'),'utf8'));
  assert.equal(final.sequence,2);
});

test('owner heartbeat retains its generation but stopped or replaced processes cannot renew',async t=>{
  const f=await fixture(t),r=await f.reserve(),proof={...f.proof,generation:r.token};
  assert.equal(await f.lifecycle.commit(r,proof),true);
  f.setNow(2000);const renewed=await f.lifecycle.heartbeat(proof);
  assert.equal(renewed.generation,proof.generation);assert.equal(renewed.leaseUntil,47000);
  f.term.foreground.pid=99;
  assert.equal(await f.lifecycle.heartbeat(renewed),null);
});

test('bridge receipt retention prunes only expired completed requests, not uncertain submissions',async t=>{
  const f=await v2Fixture();t.after(f.cleanup);let now=1000;
  const bridge=bridgeModule.createPlanBridge({...f,appHome:join(f.root,'app'),clock:()=>now},{operations:{list:()=>[]}});
  const done=await bridge.prepare('list');await writeFile(done.path,JSON.stringify({nonce:done.nonce,payload:{}}));await bridge.apply(done.id);
  const pending=await bridge.prepare('list');
  f.db.sql.prepare("UPDATE bridge_requests SET state='running' WHERE id=?").run(pending.id);
  now=86401001;await bridge.prepare('list');
  assert.equal(f.db.sql.prepare('SELECT id FROM bridge_requests WHERE id=?').get(done.id),undefined);
  assert.ok(f.db.sql.prepare('SELECT id FROM bridge_requests WHERE id=?').get(pending.id));
});

test('releasing an in-flight reservation prevents its later registration',async t=>{
  const f=await fixture(t),r=await f.reserve();
  await f.lifecycle.invalidate({channel:'plan',...f.terminal},r.token);
  assert.equal(await f.lifecycle.commit(r,{...f.proof,generation:r.token}),false);
});

test('Claude Plan observation excludes children and reserves before exact SDK readback',async()=>{
  assert.equal(typeof claudeModule.createClaudePlanObserver,'function');
  const calls=[];
  const observer=claudeModule.createClaudePlanObserver({scope:{host:'local',authority:'claude'},
    sdk:{getSessionInfo:async id=>{calls.push('sdk');return {sessionId:id};}},
    rpc:async request=>{calls.push(request.op);return {ok:true,value:{token:'reserved'}};}});
  await observer.observe({hook_event_name:'SessionStart',session_id:'session-A',agent_id:'child',cwd:'/parent'});
  assert.deepEqual(calls,[]);
  await observer.observe({hook_event_name:'SessionStart',session_id:'session-A',cwd:'/parent'});
  assert.deepEqual(calls,['owner-reserve','sdk','owner-commit']);
  calls.length=0;
  await observer.observe({hook_event_name:'SessionEnd',session_id:'session-A',cwd:'/parent'});
  assert.deepEqual(calls,['owner-end']);
});

test('a newly observed root session hides the old Plan instead of leaving its document attached',async t=>{
  const f=await fixture(t),r=await f.reserve(),proof={...f.proof,generation:r.token};await f.lifecycle.commit(r,proof);
  const runtime=createPlanRuntime({...process.env,HC_TERMINAL_ID:'t-plan',HC_SESSION:'fixture',HERDR_APP_HOME:join(f.root,'app')},
    {db:f.db,run:f.run,clock:f.clock,producerPid:20});
  const next=await runtime.bridge.handle({op:'owner-reserve',payload:{session:{...f.session,id:'ses_plan_B'},expectedGeneration:null}});
  assert.equal(next.value,null);
  assert.equal(await f.lifecycle.verify(proof),false);
});

test('an uncertain label result can be reconciled by the same current owner without adopting another session',async t=>{
  const f=await fixture(t),r=await f.reserve(),proof={...f.proof,generation:r.token};
  const failed=lifecycleModule.createBindingLifecycle(f.db,{clock:f.clock,run:async(...args)=>args[1]==='hc'&&args[2][0]==='label'?{code:1,stdout:'',stderr:'uncertain'}:f.run(...args)});
  assert.equal(await failed.commit(r,proof),false);
  const runtime=createPlanRuntime({...process.env,HC_TERMINAL_ID:'t-plan',HC_SESSION:'fixture',HERDR_APP_HOME:join(f.root,'app')},
    {db:f.db,run:f.run,clock:f.clock,producerPid:20});
  const retry=await runtime.bridge.handle({op:'owner-reserve',payload:{session:f.session,expectedGeneration:null}});
  assert.ok(retry.value);
  const result=await runtime.bridge.handle({op:'owner-commit',payload:{reservation:retry.value,session:f.session}});
  assert.equal(result.ok,true);assert.equal(await f.lifecycle.verify(result.value),true);
});

test('registration payload cannot rewrite the immutable identity captured by its reservation',async t=>{
  const f=await fixture(t),r=await f.reserve(),other={...f.session,id:'ses_forged'};
  assert.equal(await f.lifecycle.commit({...r,session:other},{...f.proof,session:other,generation:r.token}),false);
  assert.equal(f.labels['herdr.plan-binding'],undefined);
});

test('arbitrary JSON native request envelopes fail closed without throwing or running an operation',async t=>{
  const f=await v2Fixture();t.after(f.cleanup);let effects=0;
  const bridge=bridgeModule.createPlanBridge({...f,appHome:join(f.root,'app')},{operations:{list:()=>{effects++;return [];}}});
  for(const value of [null,[],true,123,'text']) {
    const request=await bridge.prepare('list');await writeFile(request.path,JSON.stringify(value));
    assert.equal((await bridge.apply(request.id)).ok,false);
  }
  assert.equal(effects,0);
});

test('a rapid A-B-A route change revokes cached Plan proof even during a suspended refresh',async()=>{
  let route='ses_plan_A',slow=false;const entered=deferred(),wait=deferred();
  const proof={channel:'plan',session:{host:'local',authority:'local',harness:'opencode-v2',id:route},generation:'generation-A'};
  const context={ui:{router:{current:()=>({type:'session',sessionID:route})}},data:{session:{root:id=>id}},client:{session:{get:async({sessionID})=>{
    if(slow){entered.resolve();await wait.promise;}return {id:sessionID};
  }}}};
  const rpc=async req=>req.op==='owner-reserve'?{ok:true,value:{token:'token'}}:req.op==='owner-heartbeat'&&!req.payload.proof
    ?{ok:false,reason:'owner-unavailable'}:{ok:true,value:req.op==='owner-release'?{released:true}:proof};
  const adapter=adapterModule.createOpenCodePlanAdapter(context,{rpc,scope:{host:'local',authority:'local'}});
  await adapter.refresh();assert.equal(typeof adapter.currentProof,'function');
  slow=true;const pending=adapter.refresh();await entered.promise;
  route='ses_plan_B';adapter.refresh();route='ses_plan_A';adapter.refresh();
  assert.equal(adapter.currentProof(),null);
  slow=false;wait.resolve();await pending;await adapter.dispose();
});

test('an explicitly supplied private database also owns its helper mailbox root',async t=>{
  const f=await v2Fixture();t.after(f.cleanup);
  const runtime=createPlanRuntime({...process.env,HERDR_METADATA_STATE_DIR:join(f.root,'unwanted-root'),HERDR_APP_HOME:join(f.root,'app')},{db:f.db,run:f.run,clock:f.clock});
  const initialized=await runtime.bridge.handle({op:'init',payload:{}});
  assert.equal(initialized.value.mailbox,join(f.root,'v2/provider-mailbox'));
});

test('fixed helper explicit app/state flags override unrelated GUI environment defaults',async t=>{
  const f=await v2Fixture();t.after(f.cleanup);
  const helper=new URL('../integrations/session-metadata/bin/herdr-plan.mjs',import.meta.url).pathname;
  const env={...process.env,HERDR_METADATA_STATE_DIR:join(f.root,'wrong-state'),HERDR_APP_HOME:join(f.root,'wrong-app')};
  const result=await execute(process.execPath,[helper,'init','--app-home',join(f.root,'right-app'),'--state-root',f.root],{env});
  assert.equal(JSON.parse(result.stdout).value.mailbox,join(f.root,'v2/provider-mailbox'));
});

test('Claude task-only hooks publish root-owned task snapshots and reject failed tools',async()=>{
  const calls=[];const {createClaudePlanObserver}=await import('../integrations/session-metadata/claude/plans.mjs');
  const observer=createClaudePlanObserver({scope:{host:'local',authority:'local'},sdk:{getSessionInfo:async id=>({sessionId:id})},
    rpc:async request=>{calls.push(request);return {ok:true,value:request.op==='owner-reserve'?{token:'reservation'}:proof};}});
  const input={session_id:proof.session.id,hook_event_name:'PostToolUse',tool_use_id:'task-hook',tool_name:'TodoWrite',
    tool_input:{todos:[{id:'a',content:'Build UI',status:'completed'}]},tool_response:{}};
  await observer.observe(input);
  const update=calls.find(request=>request.op==='update-tasks');assert.ok(update);
  assert.deepEqual(update.payload.tasks,[{id:'a',title:'Build UI',status:'completed'}]);assert.equal(update.payload.session.harness,'claude');
  calls.length=0;await observer.observe({...input,tool_response:{is_error:true}});await observer.observe({...input,agent_id:'child'});
  assert.equal(calls.length,0);
});
