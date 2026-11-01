import { randomUUID } from 'node:crypto';
import { mkdir, lstat, open, unlink, chmod } from 'node:fs/promises';
import { constants, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { processStamp } from '../database.mjs';
import { decodeProof, decodeArtifact, sessionKey } from '../protocol.mjs';

const operations=new Set(['init','snapshot','register','unregister','select-document','list','read','update-tasks','save-comment','comments','resolve-conflict','preview-review','submit','dispatch','receipt',
  'owner-reserve','owner-commit','owner-heartbeat','owner-release','owner-end','owner-snapshot','owner-review','owner-review-result']);
const safeId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const failure=reason=>({ok:false,reason});
export function createPlanBridge(runtime,{operations:handlers={}}={}) {
  const {db}=runtime, clock=runtime.clock??Date.now;
  db.transaction(sql=>sql.exec('CREATE TABLE IF NOT EXISTS bridge_requests (id TEXT PRIMARY KEY, operation TEXT NOT NULL, nonce TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, response TEXT)'));
  const directory=join(runtime.appHome,'data/session-plans/requests');
  const actor={pid:process.pid,startedAt:processStamp(process.pid)};
  async function ensure() {
    await mkdir(directory,{recursive:true,mode:0o700});
    if(!(await lstat(directory)).isDirectory())throw Error('invalid-request-directory');
    await chmod(directory,0o700);
  }
  const bridge={
    async handle(request) {
      if(!request || !operations.has(request.op) || !request.payload || typeof request.payload!=='object' || Array.isArray(request.payload))return failure('invalid-operation');
      const handler=handlers[request.op];
      if(!handler)return failure('operation-unavailable');
      try {return {ok:true,value:await handler(request.payload)};}
      catch(e) {return failure(/^[a-z][a-z-]+$/.test(e.message)?e.message:'operation-failed');}
    },
    async prepare(operation) {
      if(!operations.has(operation) || !handlers[operation])throw Error('invalid-operation');
      await ensure();
      db.sql.prepare("DELETE FROM bridge_requests WHERE id IN (SELECT id FROM bridge_requests WHERE state='complete' AND created_at<? LIMIT 100)").run(clock()-86400000);
      const id=randomUUID(),nonce=randomUUID(),path=join(directory,id+'.json');
      const file=await open(path,'wx',0o600);await file.close();
      db.sql.prepare('INSERT INTO bridge_requests VALUES (?,?,?,?,?,NULL)').run(id,operation,nonce,clock(),'prepared');
      return {id,path,nonce,expected:''};
    },
    async apply(id) {
      if(!safeId(id))return failure('invalid-request');
      const row=db.sql.prepare('SELECT * FROM bridge_requests WHERE id=?').get(id);
      if(!row)return failure('invalid-request');
      if(row.response)return JSON.parse(row.response);
      if(row.state!=='prepared')return failure('request-delivery-unknown');
      if(clock()-row.created_at>86400000 || clock()<row.created_at)return failure('expired-request');
      const resource='bridge:'+id,claim=db.claim(resource,actor);
      if(!claim)return failure('request-busy');
      const path=join(directory,id+'.json');
      try {
        const latest=db.sql.prepare('SELECT * FROM bridge_requests WHERE id=?').get(id);
        if(latest.response)return JSON.parse(latest.response);
        if(latest.state!=='prepared')return failure('request-delivery-unknown');
        let request,file;
        try {
          if(!(await lstat(directory)).isDirectory())return failure('invalid-request-directory');
          file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
          const info=await file.stat();if(!info.isFile()||info.size>1048576)return failure('invalid-request-file');
          const bytes=Buffer.alloc(1048577),{bytesRead}=await file.read(bytes,0,bytes.length,0);
          if(bytesRead>1048576)return failure('request-too-large');
          request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));
        } catch {return failure('invalid-request-file');}
        finally {await file?.close();}
        if(!request || typeof request!=='object' || Array.isArray(request) || request.nonce!==row.nonce
          || Object.keys(request).some(k=>!['nonce','payload'].includes(k)))return failure('invalid-request-nonce');
        db.sql.prepare("UPDATE bridge_requests SET state='running' WHERE id=?").run(id);
        const response=await bridge.handle({op:row.operation,payload:request.payload});
        db.sql.prepare("UPDATE bridge_requests SET state='complete',response=? WHERE id=?").run(JSON.stringify(response),id);
        await unlink(path);
        return response;
      } finally {db.release(resource,claim.token);}
    },
  };
  return bridge;
}
export function handlePlanRequest(request,runtime) {return createPlanBridge(runtime,{operations:runtime.operations}).handle(request);}

function snapshotArtifacts(db,proof) {
  if(!db.sql.prepare("SELECT name FROM sqlite_master WHERE name='plan_artifacts'").get())return [];
  return db.sql.prepare('SELECT data FROM plan_artifacts WHERE session_key=? AND active=1 ORDER BY sequence DESC').all(sessionKey(proof.session))
    .flatMap(row=>{
      try {const artifact=JSON.parse(row.data);return decodeArtifact(artifact).ok&&sessionKey(artifact.session)===sessionKey(proof.session)?[artifact]:[];}
      catch{return [];}
    }).sort((a,b)=>Number(b.primary)-Number(a.primary));
}
function snapshotTaskRevision(db,proof) {
  if(!db.sql.prepare("SELECT name FROM sqlite_master WHERE name='plan_task_snapshots'").get())return null;
  const value=db.sql.prepare('SELECT observed_at FROM plan_task_snapshots WHERE session_key=?').get(sessionKey(proof.session))?.observed_at;
  return Number.isSafeInteger(value)&&value>=0?value:null;
}

export async function publishPlanView(runtime) {
  const {db,lifecycle}=runtime,clock=runtime.clock??Date.now;
  const sequence=db.transaction(sql=>{
    sql.prepare("INSERT INTO plan_sequences VALUES ('publication',1) ON CONFLICT(name) DO UPDATE SET value=value+1").run();
    return sql.prepare("SELECT value FROM plan_sequences WHERE name='publication'").get().value;
  });
  const entries=[],errors=[];
  for(const row of db.sql.prepare("SELECT * FROM channel_bindings WHERE channel='plan' AND state='active'").all()) {
    try {
      const proof=JSON.parse(row.proof);
      if(!decodeProof(proof).ok || !await lifecycle.verify(proof))continue;
      const capabilities=runtime.deliveryCapability?await runtime.deliveryCapability(proof):{send:false,reason:'delivery-not-verified'};
      entries.push({proof,artifacts:[],capabilities});
    } catch {errors.push({reason:'invalid-plan-entry'});}
  }
  const directory=join(runtime.appHome,'data/session-plans'),path=join(directory,'view-v1.json');
  mkdirSync(directory,{recursive:true,mode:0o700});
  return db.transaction(sql=>{
    let previous=null;
    try {previous=JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('invalid-plan-view');}
    if(previous && previous.owner!=='herdr-session-plans')throw Error('foreign-plan-view');
    const published=sql.prepare("SELECT value FROM plan_sequences WHERE name='published'").get()?.value??0;
    if(Math.max(published,previous?.sequence??0)>=sequence)return previous;
    const current=entries.filter(entry=>{
      const row=sql.prepare('SELECT proof,state FROM channel_bindings WHERE channel=? AND binding_key=?').get('plan',JSON.stringify([entry.proof.coreHost,entry.proof.coreSession,entry.proof.terminal,entry.proof.createdMs]));
      return row?.state==='active' && row.proof===JSON.stringify(entry.proof) && clock()>=entry.proof.verifiedAt && clock()<=entry.proof.leaseUntil;
    }).map(entry=>({...entry,artifacts:snapshotArtifacts(db,entry.proof),taskRevision:snapshotTaskRevision(db,entry.proof)}));
    const view={schema:1,owner:'herdr-session-plans',sequence,publishedAt:clock(),entries:current,errors};
    const temp=path+'.'+randomUUID()+'.tmp';
    try {writeFileSync(temp,JSON.stringify(view),{flag:'wx',mode:0o600});renameSync(temp,path);}
    finally {try{unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
    sql.prepare("INSERT INTO plan_sequences VALUES ('published',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(sequence);
    const hint=join(directory,'changed-v1.json'),hintTemp=hint+'.'+randomUUID()+'.tmp';
    try {writeFileSync(hintTemp,JSON.stringify({owner:view.owner,sequence}),{flag:'wx',mode:0o600});renameSync(hintTemp,hint);}
    finally {try{unlinkSync(hintTemp);}catch(e){if(e.code!=='ENOENT')throw e;}}
    return view;
  });
}
