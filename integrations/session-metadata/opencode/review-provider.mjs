import { watch } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { sessionKey } from '../src/protocol.mjs';

export function createOpenCodeReviewHandler(context,{rpc,scope,now=()=>performance.now(),active=()=>true,currentProof=()=>null}) {
  return async hint=>{
    const started=now();
    const authorization=await rpc({op:'owner-review',payload:{...hint,providerVersion:context.app.version}});
    if(!authorization.ok)return;
    const grant=authorization.value;
    const options=()=>({signal:AbortSignal.timeout(Math.max(1,Math.floor(grant.remainingMs-(now()-started))))});
    let result,admitted=false;
    try {
      if(grant.session.harness!=='opencode-v2'||grant.session.host!==scope.host||grant.session.authority!==scope.authority)throw Error('target-changed');
      if(grant.operation==='admit') {
        const response=await context.client.session.get({sessionID:grant.session.id},options()),info=response?.data??response;
        const route=context.ui.router.current(),live=currentProof();
        if(!active()||now()-started>=grant.remainingMs||route?.type!=='session'||route.sessionID!==grant.session.id
          ||info?.id!==grant.session.id||info.parentID||context.data.session.root(grant.session.id)!==grant.session.id
          ||!live||sessionKey(live.session)!==sessionKey(grant.session)
          ||['generation','coreHost','coreSession','terminal','createdMs','processPid','processStartedAt'].some(key=>live[key]!==grant.proof[key]))throw Error('target-changed');
        admitted=true;
        const promptResponse=await context.client.session.prompt({sessionID:grant.session.id,id:grant.messageId,text:grant.text,
          delivery:'queue',resume:grant.resume,metadata:{herdrReview:grant.review}},options());
        const accepted=promptResponse?.data??promptResponse;
        result=accepted?.id===grant.messageId&&accepted.sessionID===grant.session.id
          ?{kind:'accepted',id:accepted.id,sessionID:accepted.sessionID}:{kind:'unknown'};
      } else {
        if(!active()||now()-started>=grant.remainingMs)throw Error('expired-provider-request');
        const response=await context.client.session.inbox.list({sessionID:grant.session.id},options());
        const pending=response?.data??response;
        if(!Array.isArray(pending))throw Error('invalid-inbox-response');
        const input=pending.find(item=>item.id===grant.messageId&&item.sessionID===grant.session.id);
        if(input)result={kind:'lookup',receipt:'pending'};
        else {
          try {
            if(!active()||now()-started>=grant.remainingMs)throw Error('expired-provider-request');
            const response=await context.client.session.message.get({sessionID:grant.session.id,messageID:grant.messageId},options());
            const message=response?.data??response;
            result={kind:'lookup',receipt:message?.id===grant.messageId&&message.type==='user'?'delivered':'unknown'};
          } catch {result={kind:'lookup',receipt:'unknown'};}
        }
      }
    } catch {result=grant.operation==='lookup'?{kind:'lookup',receipt:'unknown'}:{kind:admitted?'unknown':'rejected'};}
    await rpc({op:'owner-review-result',payload:{...hint,authorizationToken:grant.authorizationToken,result}});
  };
}
export function createSerialRequestQueue(handle) {
  const pending=new Map();let tail=Promise.resolve(),closed=false;
  return {
    enqueue(key) {
      if(closed)return Promise.resolve();
      if(pending.has(key))return pending.get(key);
      const work=tail.then(()=>closed?undefined:handle(key)).finally(()=>pending.delete(key));
      pending.set(key,work);tail=work.catch(()=>{});
      return work;
    },
    close(){closed=true;},
  };
}
export async function startReviewMailbox(directory,handle) {
  const processing=new Set();let closed=false;
  async function take(name) {
    if(closed||!/^[a-f0-9-]{36}\.request\.json$/.test(name)||processing.has(name))return;
    processing.add(name);let file;
    try {
      file=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await file.stat();if(!stat.isFile()||stat.size>16384)return;
      const hint=JSON.parse(await file.readFile('utf8'));
      if(hint.id+'.request.json'!==name||typeof hint.nonce!=='string')return;
      await handle(hint);
    } catch {} // A malformed/expired request never reaches a client method.
    finally {await file?.close();processing.delete(name);}
  }
  const queue=createSerialRequestQueue(take);
  const watcher=watch(directory,(_event,name)=>{void queue.enqueue(String(name)).catch(()=>{});});
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.request.json')).slice(0,256))void queue.enqueue(name).catch(()=>{});
  return ()=>{closed=true;queue.close();watcher.close();};
}
