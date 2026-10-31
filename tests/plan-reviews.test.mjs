import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { v2Fixture } from './helpers/v2-fixtures.mjs';
import { registerArtifact, readArtifact } from '../integrations/session-metadata/src/plans/artifacts.mjs';
import { openDatabase, processStamp } from '../integrations/session-metadata/src/database.mjs';
import { createPlanRuntime } from '../integrations/session-metadata/src/plans/runtime.mjs';
import * as deliveryApi from '../integrations/session-metadata/src/plans/delivery.mjs';

const reviews=await import('../integrations/session-metadata/src/plans/reviews.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
async function fixture(t) {
  assert.equal(typeof reviews.saveComment,'function');
  const f=await v2Fixture();t.after(f.cleanup);
  const path=join(f.root,'design.md');await writeFile(path,'# Design\nPlan source.\n');
  const deps={...f,host:'local',proof:f.proof,lifecycle:{verify:async()=>true}};
  const artifact=await registerArtifact({session:f.session,proof:f.proof,path,kind:'design',source:'explicit'},deps);
  const input={id:'comment-A',session:f.session,artifactId:artifact.id,expectedRevision:null,text:'Use a transaction.',anchor:null,status:'open',documentHash:artifact.hash};
  return {...f,path,artifact,deps,input};
}

test('plan_draft_survives_acknowledged_save_and_restart without modifying the source',async t=>{
  const f=await fixture(t);
  const saved=reviews.saveComment(f.input,f.db);
  assert.equal(saved.state,'saved');assert.equal(saved.comment.revision,0);
  f.db.close();const reopened=openDatabase({root:join(f.root,'v2')});t.after(()=>reopened.close());
  assert.equal(reviews.listComments({session:f.session,artifactId:f.artifact.id},reopened)[0].text,'Use a transaction.');
  assert.equal(await readFile(f.path,'utf8'),'# Design\nPlan source.\n');
});

test('stale draft edits preserve both versions and explicit conflict resolution checks the latest revision',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  reviews.saveComment({...f.input,expectedRevision:0,text:'Window A'},f.db);
  const conflict=reviews.saveComment({...f.input,expectedRevision:0,text:'Window B'},f.db);
  assert.equal(conflict.state,'conflict');assert.equal(conflict.current.text,'Window A');assert.equal(conflict.attempt.text,'Window B');
  const conflicts=reviews.listCommentConflicts({session:f.session,artifactId:f.artifact.id},f.db);
  assert.equal(conflicts.length,1);assert.equal(conflicts[0].attempt.text,'Window B');
  reviews.saveComment({...f.input,expectedRevision:1,text:'Window A newer'},f.db);
  const stillConflicted=reviews.resolveCommentConflict({session:f.session,artifactId:f.artifact.id,conflictId:conflict.conflictId,choice:'mine',expectedRevision:1},f.db);
  assert.equal(stillConflicted.state,'conflict');assert.equal(stillConflicted.current.text,'Window A newer');
  const resolved=reviews.resolveCommentConflict({session:f.session,artifactId:f.artifact.id,conflictId:conflict.conflictId,choice:'mine',expectedRevision:2},f.db);
  assert.equal(resolved.state,'saved');assert.equal(resolved.comment.text,'Window B');
  assert.deepEqual(reviews.listCommentConflicts({session:f.session,artifactId:f.artifact.id},f.db),[]);
});

test('different session authority cannot read or overwrite a comment by reusing its ID',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  const session={...f.session,authority:'other'},proof={...f.proof,session};
  const a=await registerArtifact({session,proof,path:f.path,kind:'design',source:'explicit'},{...f.deps,proof});
  assert.throws(()=>reviews.saveComment({...f.input,session,artifactId:a.id,text:'other'},f.db),/comment-unavailable/);
  assert.deepEqual(reviews.listComments({session,artifactId:a.id},f.db),[]);
  assert.equal(reviews.listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'Use a transaction.');
});

test('plan_review_requires_explicit_confirmed_send and resolving or editing never creates a submission',async t=>{
  const f=await fixture(t),c=reviews.saveComment(f.input,f.db).comment;
  const input={session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:c.id,revision:0}],confirmed:false,proof:f.proof};
  assert.throws(()=>reviews.createSubmission(input,f.db),/confirmation/);
  assert.throws(()=>reviews.createSubmission({...input,confirmed:true,comments:[]},f.db),/comments-required/);
  assert.throws(()=>reviews.createSubmission({...input,confirmed:true,proof:{...f.proof,session:{...f.session,id:'wrong'}}},f.db),/owner/);
  reviews.saveComment({...f.input,expectedRevision:0,status:'resolved'},f.db);
  assert.deepEqual(reviews.listSubmissions({session:f.session,artifactId:f.artifact.id},f.db),[]);
});

test('immutable review batches deduplicate double clicks and retain the submitted comment revision',async t=>{
  const f=await fixture(t),c=reviews.saveComment(f.input,f.db).comment;
  const input={session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:c.id,revision:0}],confirmed:true,proof:f.proof};
  const a=reviews.createSubmission(input,f.db),b=reviews.createSubmission(input,f.db);
  assert.equal(a.requestId,b.requestId);
  reviews.saveComment({...f.input,expectedRevision:0,text:'Changed after send'},f.db);
  assert.equal(reviews.getSubmission(a.requestId,f.db).comments[0].text,'Use a transaction.');
  assert.equal(reviews.listSubmissions({session:f.session,artifactId:f.artifact.id},f.db).length,1);
  assert.throws(()=>reviews.createSubmission({...input,comments:[{id:c.id,revision:0}]},f.db),/comment-revision/);
});

test('old document revisions require an additional explicit review confirmation',async t=>{
  const f=await fixture(t),c=reviews.saveComment(f.input,f.db).comment;
  await writeFile(f.path,'# Changed design\n');await readArtifact({session:f.session,id:f.artifact.id},f.deps);
  const input={session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:c.id,revision:0}],confirmed:true,proof:f.proof};
  assert.throws(()=>reviews.createSubmission(input,f.db),/stale-review/);
  assert.equal(reviews.createSubmission({...input,confirmedEarlierRevision:true},f.db).documentHash,f.artifact.hash);
});

test('plan_submission_double_click_claims_once and acceptance does not change the document or comments',async t=>{
  const f=await fixture(t),c=reviews.saveComment(f.input,f.db).comment;
  const submission=reviews.createSubmission({session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:c.id,revision:0}],confirmed:true,proof:f.proof},f.db);
  const actor={pid:process.pid,startedAt:processStamp(process.pid)};
  assert.equal(reviews.claimSubmission(submission.requestId,actor,f.db),true);
  assert.equal(reviews.claimSubmission(submission.requestId,actor,f.db),false);
  assert.equal(reviews.updateDelivery(submission.requestId,'sending',{state:'accepted',requestId:submission.requestId,providerId:'msg_accepted'},f.db),true);
  assert.equal(reviews.updateDelivery(submission.requestId,'sending',{state:'failed',requestId:submission.requestId},f.db),false);
  assert.equal(reviews.getSubmission(submission.requestId,f.db).delivery.state,'accepted');
  assert.equal(await readFile(f.path,'utf8'),'# Design\nPlan source.\n');
});

test('independent processes racing a saved revision preserve one edit and one conflict',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  const children=[fork(new URL('./helpers/v2-store-worker.mjs',import.meta.url),[join(f.root,'v2'),'comment'],{silent:true}),
    fork(new URL('./helpers/v2-store-worker.mjs',import.meta.url),[join(f.root,'v2'),'comment'],{silent:true})];
  t.after(()=>children.forEach(c=>c.kill()));
  await Promise.all(children.map(c=>once(c,'message')));
  const results=children.map(c=>once(c,'message'));
  children[0].send({save:{...f.input,expectedRevision:0,text:'Process A'}});
  children[1].send({save:{...f.input,expectedRevision:0,text:'Process B'}});
  const states=(await Promise.all(results)).map(([message])=>message.value.state).sort();
  assert.deepEqual(states,['conflict','saved']);
  assert.equal(reviews.listCommentConflicts({session:f.session,artifactId:f.artifact.id},f.db).length,1);
});

test('failed persistence produces no Saved acknowledgement and prevents submission',async t=>{
  const f=await fixture(t);
  reviews.listComments({session:f.session,artifactId:f.artifact.id},f.db);
  f.db.sql.exec("CREATE TRIGGER deny_comment BEFORE INSERT ON plan_comments BEGIN SELECT RAISE(ABORT,'storage-failure'); END");
  assert.throws(()=>reviews.saveComment(f.input,f.db),/storage-failure/);
  assert.deepEqual(reviews.listComments({session:f.session,artifactId:f.artifact.id},f.db),[]);
  assert.throws(()=>reviews.createSubmission({session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:f.input.id,revision:0}],confirmed:true,proof:f.proof},f.db),/comment-revision/);
});

test('a missing submission cannot leave an orphan live actor claim',async t=>{
  const f=await fixture(t),actor={pid:process.pid,startedAt:processStamp(process.pid)};
  assert.throws(()=>reviews.claimSubmission('missing',actor,f.db),/submission-unavailable/);
  const claim=f.db.claim('submission:missing',actor);
  assert.ok(claim);f.db.release('submission:missing',claim.token);
});

test('corrupted foreign conflict and submission proof records are isolated from healthy review content',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  reviews.saveComment({...f.input,expectedRevision:0,text:'Current'},f.db);
  const conflict=reviews.saveComment({...f.input,expectedRevision:0,text:'Attempt'},f.db);
  const foreign={...conflict.attempt,session:{...f.session,authority:'other'}};
  f.db.sql.prepare('UPDATE plan_comment_conflicts SET attempt=? WHERE id=?').run(JSON.stringify(foreign),conflict.conflictId);
  assert.deepEqual(reviews.listCommentConflicts({session:f.session,artifactId:f.artifact.id},f.db),[]);
  const sub=reviews.createSubmission({session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:f.input.id,revision:1}],confirmed:true,proof:f.proof},f.db);
  const row=f.db.sql.prepare('SELECT data FROM plan_submissions WHERE request_id=?').get(sub.requestId),data=JSON.parse(row.data);
  data.proof.session={...f.session,id:'wrong-target'};
  f.db.sql.prepare('UPDATE plan_submissions SET data=? WHERE request_id=?').run(JSON.stringify(data),sub.requestId);
  assert.deepEqual(reviews.listSubmissions({session:f.session,artifactId:f.artifact.id},f.db),[]);
  assert.equal(reviews.listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'Current');
});

test('deliberate resend requires separate confirmation and duplicate resend clicks share one new attempt',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  const input={session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:f.input.id,revision:0}],confirmed:true,proof:f.proof};
  const first=reviews.createSubmission(input,f.db);
  assert.throws(()=>reviews.createSubmission({...input,retryOf:first.requestId},f.db),/resend-confirmation/);
  const second=reviews.createSubmission({...input,retryOf:first.requestId,confirmedRetry:true},f.db);
  assert.notEqual(second.requestId,first.requestId);
  assert.equal(reviews.createSubmission({...input,retryOf:first.requestId,confirmedRetry:true},f.db).requestId,second.requestId);
});

test('malformed stored delivery states do not become apparently healthy submissions',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  const sub=reviews.createSubmission({session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:f.input.id,revision:0}],confirmed:true,proof:f.proof},f.db);
  f.db.sql.prepare('UPDATE plan_submissions SET delivery=? WHERE request_id=?').run(JSON.stringify({state:'invented',requestId:sub.requestId}),sub.requestId);
  assert.deepEqual(reviews.listSubmissions({session:f.session,artifactId:f.artifact.id},f.db),[]);
});

test('private helper saves and lists owner-scoped drafts even after live agent proof has expired',async t=>{
  const f=await fixture(t);
  const runtime=createPlanRuntime({...process.env,HERDR_APP_HOME:join(f.root,'app')},{db:f.db,run:f.run,clock:f.clock});
  const saved=await runtime.bridge.handle({op:'save-comment',payload:f.input});
  assert.equal(saved.ok,true);assert.equal(saved.value.state,'saved');
  const read=await runtime.bridge.handle({op:'comments',payload:{session:f.session,artifactId:f.artifact.id}});
  assert.equal(read.value.comments[0].text,'Use a transaction.');
  assert.deepEqual(read.value.submissions,[]);
});

test('helper submission verifies current document bytes instead of trusting a stale displayed hash',async t=>{
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  const runtime=createPlanRuntime({...process.env,HERDR_APP_HOME:join(f.root,'app')},{db:f.db,run:f.run,clock:f.clock});
  runtime.lifecycle={verify:async()=>true};
  const input={session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:f.input.id,revision:0}],confirmed:true,proof:f.proof};
  const first=await runtime.bridge.handle({op:'submit',payload:input});assert.equal(first.ok,true);
  await writeFile(f.path,'# New bytes\n');
  const stale=await runtime.bridge.handle({op:'submit',payload:input});
  assert.equal(stale.ok,false);assert.equal(stale.reason,'stale-review');
});

test('review preview is owner scoped and read-only until explicit submission confirmation',async t=>{
  assert.equal(typeof deliveryApi.previewReview,'function');
  const f=await fixture(t);reviews.saveComment(f.input,f.db);
  const input={session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:f.input.id,revision:0}]};
  const preview=deliveryApi.previewReview(input,f.db);
  assert.ok(preview.text.includes('Use a transaction.'));assert.equal(preview.earlierRevision,false);
  assert.deepEqual(reviews.listSubmissions({session:f.session,artifactId:f.artifact.id},f.db),[]);
  assert.throws(()=>deliveryApi.previewReview({...input,session:{...f.session,id:'other'}},f.db),/artifact-unavailable/);
});
