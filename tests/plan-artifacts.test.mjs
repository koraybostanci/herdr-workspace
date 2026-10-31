import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile, symlink, unlink, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { v2Fixture, deferred } from './helpers/v2-fixtures.mjs';
import * as planAdapter from '../integrations/session-metadata/opencode/plans.mjs';
const { createOpenCodePlanAdapter }=planAdapter;
import { proof as ownerProof } from './helpers/v2-fixtures.mjs';
import { createBindingLifecycle } from '../integrations/session-metadata/src/binding-lifecycle.mjs';
import { bindingKey } from '../integrations/session-metadata/src/protocol.mjs';
import { publishPlanView } from '../integrations/session-metadata/src/plans/bridge.mjs';

const artifacts=await import('../integrations/session-metadata/src/plans/artifacts.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const evidence=await import('../integrations/session-metadata/src/plans/evidence.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const digest=text=>createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  assert.equal(typeof artifacts.registerArtifact,'function');
  const f=await v2Fixture();t.after(f.cleanup);
  const path=join(f.root,'design.md');await writeFile(path,'# Design\n\n## Storage\nUse transactions.\n');
  const deps={...f,proof:f.proof,host:'local',lifecycle:{verify:async()=>true}};
  const input={session:f.session,proof:f.proof,path,kind:'design',source:'explicit'};
  return {...f,path,deps,input};
}

test('registered planning documents belong to the exact session, not a shared repository or title',async t=>{
  const f=await fixture(t),a=await artifacts.registerArtifact(f.input,f.deps);
  const other={...f.session,authority:'other-server'},otherProof={...f.proof,session:other};
  const b=await artifacts.registerArtifact({...f.input,session:other,proof:otherProof},{...f.deps,proof:otherProof});
  assert.notEqual(a.id,b.id);
  assert.equal((await artifacts.listArtifacts(f.session,f.deps)).length,1);
  assert.equal((await artifacts.listArtifacts(other,{...f.deps,proof:otherProof}))[0].id,b.id);
  assert.equal((await artifacts.registerArtifact(f.input,f.deps)).id,a.id);
  assert.equal((await artifacts.readArtifact({session:f.session,id:a.id},f.deps)).text,'# Design\n\n## Storage\nUse transactions.\n');
  await assert.rejects(artifacts.readArtifact({session:other,id:a.id},{...f.deps,proof:otherProof}),/artifact-unavailable/);
});

test('plan_reader_validates_host_path_type_and_size with bounded UTF-8 reads',async t=>{
  const f=await fixture(t);
  await writeFile(f.path,Buffer.alloc(1048576,97));
  const exact=await artifacts.registerArtifact(f.input,f.deps);
  assert.equal(exact.hash,digest(Buffer.alloc(1048576,97)));
  await writeFile(f.path,Buffer.alloc(1048577,97));
  await assert.rejects(artifacts.registerArtifact(f.input,f.deps),/too-large/);
  await writeFile(f.path,Buffer.from([0xf0,0x9f]));
  await assert.rejects(artifacts.registerArtifact(f.input,f.deps),/invalid-utf8/);
  await assert.rejects(artifacts.registerArtifact({...f.input,path:f.root},f.deps),/regular-file/);
  const fifo=join(f.root,'fifo');execFileSync('mkfifo',[fifo]);
  await assert.rejects(artifacts.registerArtifact({...f.input,path:fifo},f.deps),/regular-file/);
  await assert.rejects(artifacts.registerArtifact({...f.input,path:'relative.md'},f.deps),/absolute/);
  const remote={...f.session,host:'peer'},proof={...f.proof,session:remote};
  await assert.rejects(artifacts.registerArtifact({...f.input,session:remote,proof},{...f.deps,proof}),/host-unavailable/);
});

test('plan_same_bytes_new_symlink_requires_verification before a new target is shown',async t=>{
  const f=await fixture(t),copy=join(f.root,'copy.md'),link=join(f.root,'linked.md');
  const before=await readFile(f.path);await writeFile(copy,before);await symlink(f.path,link);
  const first=await artifacts.registerArtifact({...f.input,path:link},f.deps);
  await unlink(link);await symlink(copy,link);
  const changed=await artifacts.readArtifact({session:f.session,id:first.id},f.deps);
  assert.equal(changed.state,'needs-verification');assert.equal(changed.text,null);
  const verified=await artifacts.registerArtifact({...f.input,path:link},f.deps);
  assert.equal(verified.id,first.id);assert.equal(verified.revision,first.revision+1);assert.equal(verified.resolvedPath,copy);
});

test('source changes increment verified artifact revision while deletion preserves the review association',async t=>{
  const f=await fixture(t),first=await artifacts.registerArtifact(f.input,f.deps);
  await writeFile(f.path,'# Updated\nNew design.\n');
  const updated=await artifacts.readArtifact({session:f.session,id:first.id},f.deps);
  assert.equal(updated.artifact.revision,1);assert.equal(updated.artifact.hash,digest('# Updated\nNew design.\n'));
  await unlink(f.path);
  const missing=await artifacts.readArtifact({session:f.session,id:first.id},f.deps);
  assert.equal(missing.state,'missing');assert.equal(missing.text,null);
  assert.equal((await artifacts.listArtifacts(f.session,f.deps)).length,1);
  assert.equal(await artifacts.unregisterArtifact({session:f.session,id:first.id,expectedRevision:0},f.deps),false);
  assert.equal(await artifacts.unregisterArtifact({session:f.session,id:first.id,expectedRevision:1},f.deps),true);
  assert.deepEqual(await artifacts.listArtifacts(f.session,f.deps),[]);
});

test('older overlapping file read cannot overwrite or present a newer registered revision',async t=>{
  const f=await fixture(t),a=await artifacts.registerArtifact(f.input,f.deps),paused=deferred(),entered=deferred();
  const old=artifacts.readArtifact({session:f.session,id:a.id},{...f.deps,readDocument:async path=>{
    const value=await artifacts.readDocument(path);entered.resolve();await paused.promise;return value;
  }});
  await entered.promise;await writeFile(f.path,'# New content\n');
  const fresh=await artifacts.readArtifact({session:f.session,id:a.id},f.deps);paused.resolve();
  const stale=await old;
  assert.equal(stale.state,'superseded');assert.equal(stale.text,null);
  assert.equal(fresh.artifact.hash,digest('# New content\n'));
});

test('heading index excludes code and HTML blocks, preserves CRLF and nested Unicode headings',()=>{
  assert.equal(typeof artifacts.indexSections,'function');
  const markdown='# Design\r\n\r\n```md\r\n# not a section\r\n```\r\n\r\n~~~\r\n## hidden\r\n~~~\r\n\r\n    # indented\r\n\r\n<div>\r\n## hidden HTML\r\n</div>\r\n\r\n## 安全\r\nbody\r\n\r\nSetext\r\n------\r\ntext\r\n';
  const sections=artifacts.indexSections(markdown,digest(markdown));
  assert.deepEqual(sections.map(s=>s.headingPath),[['Design'],['Design','安全'],['Design','Setext']]);
  assert.equal(markdown.slice(sections[1].start,sections[1].end),'## 安全\r\nbody\r\n\r\n');
});

test('plan_comment_anchor_never_silently_retargets changed, deleted or duplicate sections',()=>{
  assert.equal(typeof artifacts.reanchor,'function');
  const original='# Design\n\n## Storage\nOne.\n';
  const sections=artifacts.indexSections(original,digest(original));
  const anchor={documentHash:digest(original),headingPath:['Design','Storage'],occurrence:0,sectionHash:sections[1].sectionHash,excerpt:'## Storage\nOne.\n'};
  assert.equal(artifacts.reanchor(anchor,sections).state,'current');
  const changed='# Design\n\n## Storage\nTwo.\n';
  assert.equal(artifacts.reanchor(anchor,artifacts.indexSections(changed,digest(changed))).state,'needs-recheck');
  assert.equal(artifacts.reanchor(anchor,[]).state,'needs-recheck');
  const duplicates=artifacts.indexSections('# Design\n## Storage\nOne.\n## Storage\nOne.\n','b'.repeat(64));
  assert.equal(artifacts.reanchor(anchor,duplicates).state,'needs-recheck');
  const moved='# Design\n## Other\nBefore.\n## Storage\nOne.\n';
  assert.equal(artifacts.reanchor(anchor,artifacts.indexSections(moved,digest(moved))).state,'current');
});

test('section excerpts are UTF-8 bounded without splitting emoji or mutating source Markdown',async t=>{
  const f=await fixture(t),text='# Heading\n'+ '🙂'.repeat(400);await writeFile(f.path,text);
  const a=await artifacts.registerArtifact(f.input,f.deps),read=await artifacts.readArtifact({session:f.session,id:a.id},f.deps);
  assert.ok(Buffer.byteLength(read.sections[0].excerpt)<=1024);
  assert.equal(read.sections[0].excerpt.includes('\ufffd'),false);
  assert.equal(await readFile(f.path,'utf8'),text);
});

test('explicit primary selection persists across new documents and stale event replay cannot undo unregister',async t=>{
  const f=await fixture(t),a=await artifacts.registerArtifact(f.input,f.deps);
  const second=join(f.root,'implementation.md');await writeFile(second,'# Implementation\n');
  const b=await artifacts.registerArtifact({...f.input,path:second,kind:'implementation',source:'opencode-tool:event-B'},f.deps);
  assert.equal((await artifacts.listArtifacts(f.session,f.deps))[0].id,b.id);
  assert.equal(await artifacts.setPrimaryArtifact({session:f.session,id:a.id,expectedRevision:a.revision},f.deps),true);
  assert.equal((await artifacts.listArtifacts(f.session,f.deps))[0].id,a.id);
  assert.equal(await artifacts.unregisterArtifact({session:f.session,id:b.id,expectedRevision:b.revision},f.deps),true);
  await artifacts.registerArtifact({...f.input,path:second,kind:'implementation',source:'opencode-tool:event-B'},f.deps);
  assert.deepEqual((await artifacts.listArtifacts(f.session,f.deps)).map(x=>x.id),[a.id]);
});

test('automatic discovery accepts only successful structured plan writes, never reads or output mentions',()=>{
  assert.equal(typeof evidence.extractPlanWrites,'function');
  const input={eventId:'msg_1:tool_2',tool:'functions.patch',input:{patchText:'*** Begin Patch\n*** Add File: /task/docs/superpowers/specs/review-design.md\n+# Design\n*** End Patch'}};
  assert.deepEqual(evidence.extractPlanWrites(input,'opencode'),[{path:'/task/docs/superpowers/specs/review-design.md',kind:'design',source:'opencode-tool:msg_1:tool_2:0'}]);
  assert.deepEqual(evidence.extractPlanWrites({...input,failed:true},'opencode'),[]);
  assert.deepEqual(evidence.extractPlanWrites({eventId:'read-1',tool:'read',input:{path:'/task/docs/superpowers/specs/review-design.md'}},'opencode'),[]);
  assert.deepEqual(evidence.extractPlanWrites({eventId:'shell-1',tool:'bash',input:{command:'echo /task/docs/superpowers/plans/plan.md'}},'opencode'),[]);
  assert.deepEqual(evidence.extractPlanWrites({eventId:'write-1',tool:'write',input:{filePath:'/task/README.md'}},'opencode'),[]);
  assert.deepEqual(evidence.extractPlanWrites({eventId:'write-2',tool:'Write',input:{file_path:'/home/example/.claude/plans/plan.md'}},'claude'),
    [{path:'/home/example/.claude/plans/plan.md',kind:'implementation',source:'claude-tool:write-2:0'}]);
});

test('owning TUI registers derived plan paths after its canonical root proof, not raw operation bodies',async()=>{
  const calls=[],id=ownerProof.session.id,path='/task/docs/superpowers/plans/work.md';
  const context={ui:{router:{current:()=>({type:'session',sessionID:id})}},
    client:{session:{get:async()=>({id,title:'Task'})}},data:{session:{root:x=>x,message:{list:()=>[
      {id:'msg_old',type:'assistant',time:{created:1,completed:2},content:[{id:'tool_old',type:'tool',name:'write',state:{status:'completed',input:{filePath:path,content:'# OLD PRIVATE'},content:[{type:'text',text:'done'}]}}]},
      {id:'msg_1',type:'assistant',time:{created:3,completed:4},content:[{id:'tool_1',type:'tool',name:'write',state:{status:'completed',input:{filePath:path,content:'# PRIVATE SOURCE'},content:[{type:'text',text:'done'}]}}]},
    ]}}}};
  const rpc=async request=>{calls.push(request);return {ok:true,value:request.op==='owner-reserve'?{token:'reservation'}:ownerProof};};
  const adapter=createOpenCodePlanAdapter(context,{rpc,scope:{host:'local',authority:'local'}});await adapter.refresh();
  const registered=calls.find(x=>x.op==='register');
  assert.equal(registered?.payload.path,path);
  assert.equal(registered?.payload.source,'opencode-tool:msg_1:tool_1:0');
  assert.equal(JSON.stringify(registered).includes('PRIVATE SOURCE'),false);
  await adapter.refresh();
  assert.equal(calls.filter(x=>x.op==='register').length,1);
});

test('published document choices use the same primary and latest-registration order as direct listing',async t=>{
  const f=await fixture(t),a=await artifacts.registerArtifact(f.input,f.deps);
  const second=join(f.root,'second.md');await writeFile(second,'# Second\n');
  const b=await artifacts.registerArtifact({...f.input,path:second},f.deps);
  createBindingLifecycle(f.db,f.deps);
  f.db.sql.prepare('INSERT INTO channel_bindings VALUES (?,?,?,?)').run('plan',bindingKey(f.proof),JSON.stringify(f.proof),'active');
  const runtime={...f.deps,appHome:join(f.root,'app')};
  const latest=await publishPlanView(runtime);
  assert.equal(latest.entries[0].artifacts[0].id,b.id);
  await artifacts.setPrimaryArtifact({session:f.session,id:a.id,expectedRevision:a.revision},f.deps);
  const primary=await publishPlanView(runtime);
  assert.equal(primary.entries[0].artifacts[0].id,a.id);
});

test('TUI invalidation fingerprint reads only message and completion identities, never large tool bodies',()=>{
  assert.equal(typeof planAdapter.planMessageFingerprint,'function');
  const tool={id:'tool_1',type:'tool',state:{status:'completed',get input(){throw Error('body scanned during fingerprint');}}};
  assert.equal(planAdapter.planMessageFingerprint('ses_A',[{id:'msg_1',type:'assistant',content:[tool]}]),'["ses_A",[["msg_1","assistant",["tool_1"]]]]');
});

test('owning TUI publishes normalized task observations once and never raw tool content',async()=>{
  const calls=[],id=ownerProof.session.id;
  const context={ui:{router:{current:()=>({type:'session',sessionID:id})}},client:{session:{get:async()=>({id})}},
    data:{session:{root:x=>x,message:{list:()=>[{id:'msg_tasks',type:'assistant',time:{created:1000},content:[
      {id:'tool_tasks',type:'tool',name:'todowrite',state:{status:'completed',input:{todos:[{id:'a',content:'Ship API',status:'in_progress'}],private:'DO NOT STORE'}}},
      {id:'failed',type:'tool',name:'todowrite',state:{status:'error',input:{todos:[]}}},
    ]}]}}}};
  const rpc=async request=>{calls.push(request);return {ok:true,value:request.op==='owner-reserve'?{token:'reservation'}:ownerProof};};
  const adapter=createOpenCodePlanAdapter(context,{rpc,scope:{host:'local',authority:'local'}});
  await adapter.refresh();await adapter.refresh();
  const updates=calls.filter(request=>request.op==='update-tasks');assert.equal(updates.length,1);
  assert.deepEqual(updates[0].payload.tasks,[{id:'a',title:'Ship API',status:'in_progress'}]);
  assert.equal(JSON.stringify(updates).includes('DO NOT STORE'),false);assert.deepEqual(updates[0].payload.session,ownerProof.session);
});
