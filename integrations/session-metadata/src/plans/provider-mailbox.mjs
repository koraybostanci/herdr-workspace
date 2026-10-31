import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, lstat, chmod, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { actorState, processStamp } from '../database.mjs';
import { getSubmission, updateDelivery } from './reviews.mjs';
import { readArtifact } from './artifacts.mjs';
import { formatReview, reviewMessageId } from './delivery.mjs';
import { decodeProof, sessionKey } from '../protocol.mjs';

const monotonic = runtime => (runtime.monotonic??process.hrtime.bigint)();
const validId = value => typeof value==='string' && /^[a-f0-9-]{36}$/.test(value);
const directoryFor = runtime => join(runtime.root??dirname(runtime.db.root),'v2/provider-mailbox');
export async function ensureProviderMailbox(runtime) {
  runtime.db.transaction(sql=>sql.exec(`CREATE TABLE IF NOT EXISTS plan_provider_requests
    (id TEXT PRIMARY KEY, nonce TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL,
     state TEXT NOT NULL, authorization_token TEXT, result TEXT)`));
  const directory=directoryFor(runtime);
  await mkdir(directory,{recursive:true,mode:0o700});
  if(!(await lstat(directory)).isDirectory())throw Error('invalid-mailbox-directory');
  await chmod(directory,0o700);
  if(runtime.db.sql.prepare("SELECT name FROM sqlite_master WHERE name='plan_submissions'").get()) {
    const rows=runtime.db.sql.prepare(`SELECT p.id FROM plan_provider_requests p JOIN plan_submissions s ON s.request_id=p.request_id
      WHERE p.result IS NOT NULL
      AND json_extract(CASE WHEN json_valid(s.delivery) THEN s.delivery ELSE '{}' END,'$.state') IN ('accepted','failed')
      AND typeof(json_extract(CASE WHEN json_valid(p.data) THEN p.data ELSE '{}' END,'$.createdAt'))='integer'
      AND json_extract(CASE WHEN json_valid(p.data) THEN p.data ELSE '{}' END,'$.createdAt') < ?
      ORDER BY p.rowid LIMIT 100`).all((runtime.clock??Date.now)()-86400000);
    for(const row of rows) {
      if(!validId(row.id))continue;
      for(const suffix of ['.request.json','.ack.json'])await unlink(join(directory,row.id+suffix)).catch(e=>{if(e.code!=='ENOENT')throw e;});
      runtime.db.sql.prepare('DELETE FROM plan_provider_requests WHERE id=?').run(row.id);
    }
  }
  return directory;
}
async function atomic(path,value) {
  const temp=path+'.'+randomUUID()+'.tmp';
  try {await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temp,path);}
  finally {await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
function requestRow(hint,runtime) {
  if(!validId(hint?.id)||!validId(hint?.nonce))throw Error('invalid-provider-request');
  const row=runtime.db.sql.prepare('SELECT * FROM plan_provider_requests WHERE id=? AND nonce=?').get(hint.id,hint.nonce);
  if(!row)throw Error('invalid-provider-request');
  return row;
}
async function verifyOwner(data,runtime) {
  if(runtime.producerPid!==data.proof.processPid)throw Error('invalid-provider-owner');
  const response=await runtime.run('local','ps',['-o','lstart=','-p',String(runtime.producerPid)]);
  if(response.code!==0||response.stdout.trim()!==data.proof.processStartedAt)throw Error('invalid-provider-owner');
}
export async function prepareProviderRequest(requestId,operation,runtime,{resume=true}={}) {
  const directory=await ensureProviderMailbox(runtime),submission=getSubmission(requestId,runtime.db);
  if(!['admit','lookup'].includes(operation)||operation==='admit'&&submission.delivery.state!=='sending'||typeof resume!=='boolean')throw Error('invalid-provider-operation');
  const id=randomUUID(),nonce=randomUUID();
  let proof=submission.proof;
  if(operation==='lookup'&&runtime.db.sql.prepare("SELECT name FROM sqlite_master WHERE name='channel_bindings'").get()) {
    for(const row of runtime.db.sql.prepare("SELECT proof FROM channel_bindings WHERE channel='plan' AND state='active'").all()) {
      try {
        const candidate=JSON.parse(row.proof);
        if(decodeProof(candidate).ok&&sessionKey(candidate.session)===sessionKey(submission.session)&&await runtime.lifecycle.verify(candidate)){proof=candidate;break;}
      } catch {} // Corrupt or different-session candidates cannot authorize a receipt lookup.
    }
  }
  const data={requestId,operation,proof,resume,createdAt:(runtime.clock??Date.now)(),
    sender:{pid:process.pid,startedAt:processStamp(process.pid)},deadlineNs:String(monotonic(runtime)+5000000000n)};
  runtime.db.sql.prepare('INSERT INTO plan_provider_requests VALUES (?,?,?,?,?,NULL,NULL)').run(id,nonce,requestId,JSON.stringify(data),'prepared');
  const hint={id,nonce};await atomic(join(directory,id+'.request.json'),hint);
  return hint;
}
export async function authorizeProviderRequest(hint,runtime) {
  const row=requestRow(hint,runtime),data=JSON.parse(row.data);
  if(row.state!=='prepared')throw Error('request-already-authorized');
  const remaining=BigInt(data.deadlineNs)-monotonic(runtime);
  if(remaining<=0n||remaining>5000000000n)throw Error('expired-provider-request');
  if(actorState(data.sender)!=='live')throw Error('sender-unavailable');
  const submission=getSubmission(row.request_id,runtime.db);
  if(!decodeProof(data.proof).ok||sessionKey(data.proof.session)!==sessionKey(submission.session))throw Error('invalid-provider-request');
  await verifyOwner(data,runtime);
  if(!await runtime.enabled?.(submission.session,data.proof,{resume:data.resume,providerVersion:hint.providerVersion}))throw Error('delivery-unavailable');
  let text;
  if(data.operation==='admit') {
    if(submission.delivery.state!=='sending'||!await runtime.lifecycle.verify(submission.proof))throw Error('target-changed');
    const document=await readArtifact({session:submission.session,id:submission.artifactId},{...runtime,proof:submission.proof});
    if(document.state!=='ready'||document.artifact.hash!==submission.documentHash&&!submission.confirmedEarlierRevision)throw Error('document-changed');
    text=formatReview(submission,document.artifact);
    if(Buffer.byteLength(text)>1048576)throw Error('review-too-large');
  }
  const now=monotonic(runtime),remainingMs=Math.floor(Number(BigInt(data.deadlineNs)-now)/1000000);
  if(remainingMs<=0||remainingMs>5000)throw Error('expired-provider-request');
  const authorizationToken=randomUUID();
  runtime.db.transaction(sql=>{
    const current=requestRow(hint,runtime);
    if(current.state!=='prepared')throw Error('request-already-authorized');
    sql.prepare("UPDATE plan_provider_requests SET state='authorized',authorization_token=? WHERE id=?").run(authorizationToken,hint.id);
  });
  return {operation:data.operation,session:submission.session,proof:data.proof,messageId:reviewMessageId(submission.requestId),
    text,resume:data.resume,review:{requestId:submission.requestId,artifactId:submission.artifactId,documentHash:submission.documentHash},
    remainingMs,authorizationToken};
}
export async function recordProviderResult(payload,runtime) {
  const row=requestRow(payload,runtime),data=JSON.parse(row.data);
  const submission=getSubmission(row.request_id,runtime.db);
  if(!decodeProof(data.proof).ok||sessionKey(data.proof.session)!==sessionKey(submission.session))throw Error('invalid-provider-request');
  await verifyOwner(data,runtime);
  if(row.state!=='authorized'||payload.authorizationToken!==row.authorization_token)throw Error('invalid-provider-authorization');
  if(row.result)return JSON.parse(row.result);
  const result=payload.result,requestId=submission.requestId;
  if(!result||!['accepted','rejected','unknown','lookup'].includes(result.kind))throw Error('invalid-provider-result');
  if(result.kind==='accepted'&&(data.operation!=='admit'||result.id!==reviewMessageId(requestId)||result.sessionID!==submission.session.id))throw Error('invalid-acknowledgement');
  if(result.kind==='lookup'&&(data.operation!=='lookup'||!['pending','delivered','absent','unknown'].includes(result.receipt)))throw Error('invalid-provider-result');
  runtime.db.transaction(sql=>{
    const current=requestRow(payload,runtime);
    if(current.result)return;
    if(data.operation==='admit') {
      const state=getSubmission(requestId,runtime.db).delivery.state;
      if(['sending','unknown'].includes(state)) {
        const delivery=result.kind==='accepted'?{state:'accepted',requestId,providerId:result.id}
          :result.kind==='rejected'?{state:'failed',requestId,reason:'target-changed'}:{state:'unknown',requestId,reason:'acknowledgement-unavailable'};
        // An unknown result may already have been recorded by the timed-out sender.
        if(!(state==='unknown'&&delivery.state==='unknown'))updateDelivery(requestId,state,delivery,runtime.db);
      }
    }
    sql.prepare('UPDATE plan_provider_requests SET result=? WHERE id=?').run(JSON.stringify(result),payload.id);
  });
  await atomic(join(directoryFor(runtime),payload.id+'.ack.json'),{id:payload.id});
  return result;
}
async function requestOwner(requestId,operation,runtime,options) {
  const directory=await ensureProviderMailbox(runtime);
  let hint,watcher,timer,finish;
  const result=new Promise(resolve=>{finish=resolve;});
  const check=()=>{
    if(!hint)return;
    try {const row=requestRow(hint,runtime);if(row.result)finish(JSON.parse(row.result));}
    catch {finish({kind:'unknown'});}
  };
  try {
    watcher=watch(directory,(_event,name)=>{if(hint&&String(name)===hint.id+'.ack.json')check();});
    hint=await prepareProviderRequest(requestId,operation,runtime,options);
    timer=setTimeout(()=>finish({kind:'unknown'}),5000);
    check();return await result;
  } finally {
    clearTimeout(timer);watcher?.close();
    if(hint)for(const suffix of ['.request.json','.ack.json'])await unlink(join(directory,hint.id+suffix)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
}
export function createMailboxProvider(runtime) {
  return {
    async admit(request) {
      const result=await requestOwner(request.review.requestId,'admit',runtime,{resume:request.resume});
      if(result.kind==='accepted')return {id:result.id,sessionID:result.sessionID};
      const error=Error('provider-unavailable');error.definite=result.kind==='rejected';throw error;
    },
    async lookup(request) {
      const result=await requestOwner(request.requestId,'lookup',runtime);
      return result.kind==='lookup'?result.receipt:'unknown';
    },
  };
}
