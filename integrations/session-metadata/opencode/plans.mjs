import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractPlanWrites } from '../src/plans/evidence.mjs';
import { extractTaskSnapshot } from '../src/plans/tasks.mjs';
import { createOpenCodeReviewHandler, startReviewMailbox } from './review-provider.mjs';

function planEvents(context,id) {
  const events=[];
  const messages=context.data.session.message?.list?.(id)??[];
  for(const message of messages.slice(-500)) {
    if(message.type!=='assistant')continue;
    for(const tool of message.content??[]) {
      if(tool.type==='tool' && tool.state?.status==='completed') events.push({eventId:`${message.id}:${tool.id}`,tool:tool.name,input:tool.state.input,
        at:tool.time?.completed??message.time?.completed??message.time?.created??0});
    }
  }
  return events.sort((a,b)=>a.at-b.at).slice(-500);
}
export function planMessageFingerprint(id,messages) {
  return JSON.stringify([id,messages.slice(-8).map(message=>[message.id,message.type,
    (message.content??[]).filter(part=>part.type==='tool'&&part.state?.status==='completed').map(part=>part.id)])]);
}

export function createOpenCodePlanAdapter(context,{rpc,scope}) {
  let proof=null,disposed=false,running=null,rerun=false,releaseWork=Promise.resolve();
  const registeredSources=new Map();
  const route=()=>{const r=context.ui.router.current();return r?.type==='session'?r.sessionID:null;};
  const current=id=>!disposed&&route()===id;
  async function publishWrites(id) {
    if(!proof||!current(id))return;
    const events=planEvents(context,id),paths=new Map();
    for(const artifact of events.flatMap(event=>extractPlanWrites(event,'opencode')))paths.set(artifact.path,artifact);
    for(const artifact of paths.values()) {
      if(!current(id))return;
      const key=JSON.stringify([scope.host,scope.authority,id,artifact.source]);
      if(registeredSources.has(key))continue;
      const result=await rpc({op:'register',payload:{...artifact,session:proof.session,proof}});
      if(result.ok){registeredSources.set(key,true);if(registeredSources.size>1000)registeredSources.delete(registeredSources.keys().next().value);}
    }
    const tasks=events.map(extractTaskSnapshot).filter(Boolean).at(-1);
    if(tasks&&proof&&current(id)) {
      const key=JSON.stringify([scope.host,scope.authority,id,'tasks',tasks.eventId]);
      if(!registeredSources.has(key)) {
        const result=await rpc({op:'update-tasks',payload:{...tasks,session:proof.session,proof}});
        if(result.ok){registeredSources.set(key,true);if(registeredSources.size>1000)registeredSources.delete(registeredSources.keys().next().value);}
      }
    }
  }
  async function refreshNow() {
      const id=route();
      if(disposed)return;
      if(!id) {if(proof)await rpc({op:'owner-release',payload:{proof}});proof=null;return;}
      if(proof && proof.session.id!==id){await rpc({op:'owner-release',payload:{proof}});proof=null;}
      const session={...scope,harness:'opencode-v2',id};
      if(proof) {
        const response=await context.client.session.get({sessionID:id}),info=response?.data??response;
        if(!current(id)||info?.id!==id||info.parentID)return;
        const renewed=await rpc({op:'owner-heartbeat',payload:{proof,providerVersion:context.app?.version}});
        if(current(id))proof=renewed.ok?renewed.value:null;
        await publishWrites(id);
        return;
      }
      const reservation=await rpc({op:'owner-reserve',payload:{session,expectedGeneration:proof?.generation??null}});
      if(!reservation.ok || !reservation.value || !current(id))return;
      const response=await context.client.session.get({sessionID:id});
      const info=response?.data??response;
      if(!current(id) || info?.id!==id || info.parentID || context.data.session.root?.(id)!==id)return;
      const committed=await rpc({op:'owner-commit',payload:{reservation:reservation.value,session,providerVersion:context.app?.version}});
      if(committed.ok&&committed.value) {
        if(current(id)){proof=committed.value;await publishWrites(id);}
        else await rpc({op:'owner-release',payload:{proof:committed.value}});
      }
  }
  const adapter={
    refresh() {
      if(proof&&route()!==proof.session.id) {
        const old=proof;proof=null;
        releaseWork=releaseWork.catch(()=>{}).then(()=>rpc({op:'owner-release',payload:{proof:old}}));
      }
      if(running){rerun=true;return running;}
      running=releaseWork.then(refreshNow).finally(()=>{running=null;if(rerun&&!disposed){rerun=false;void adapter.refresh().catch(()=>{});}});
      return running;
    },
    currentProof(){return proof&&current(proof.session.id)?proof:null;},
    async dispose() {disposed=true;if(proof)await rpc({op:'owner-release',payload:{proof}});proof=null;registeredSources.clear();},
  };
  return adapter;
}

export async function startOpenCodePlans(context,{node,scope,appHome,stateRoot}) {
  if(typeof node!=='string'||!node.startsWith('/')||!process.env.HC_TERMINAL_ID)return ()=>{};
  const helper=fileURLToPath(new URL('../bin/herdr-plan.mjs',import.meta.url));
  const rpc=request=>new Promise(resolve=>{
    const flags=[...(appHome?['--app-home',appHome]:[]),...(stateRoot?['--state-root',stateRoot]:[])];
    const child=execFile(node,[helper,'rpc',...flags],{env:process.env,timeout:8000,maxBuffer:2*1048576},(error,stdout)=>{
      try {resolve(JSON.parse(stdout));}catch{resolve({ok:false,reason:'helper-unavailable'});}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
  const adapter=createOpenCodePlanAdapter(context,{rpc,scope});
  let active=true,stopProvider=()=>{};
  const initialized=await rpc({op:'init',payload:{}});
  if(initialized.ok&&typeof initialized.value?.mailbox==='string') {
    stopProvider=await startReviewMailbox(initialized.value.mailbox,createOpenCodeReviewHandler(context,{rpc,scope,active:()=>active,currentProof:()=>adapter.currentProof()})).catch(()=>()=>{});
  }
  let fingerprint='';
  const request=()=>{
    const route=context.ui.router.current(),id=route?.type==='session'?route.sessionID:null;
    const next=planMessageFingerprint(id,id?(context.data.session.message?.list?.(id)??[]):[]);
    if(next===fingerprint)return;fingerprint=next;
    void adapter.refresh().catch(()=>{});
  };
  const stop=context.data.listen(request);
  const timer=setInterval(()=>{void adapter.refresh().catch(()=>{});},15000);
  await adapter.refresh().catch(()=>{});
  const dispose=async()=>{active=false;clearInterval(timer);stop();stopProvider();await adapter.dispose();};
  dispose.onRouteChange=request;
  return dispose;
}
