import { execFile } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { openDatabase } from '../database.mjs';
import { createBindingLifecycle } from '../binding-lifecycle.mjs';
import { decodeSession, sessionKey } from '../protocol.mjs';
import { createPlanBridge, publishPlanView } from './bridge.mjs';
import { registerArtifact, unregisterArtifact, setPrimaryArtifact, listArtifacts, readArtifact } from './artifacts.mjs';
import { saveComment, listComments, listCommentConflicts, resolveCommentConflict, createSubmission, listSubmissions, getSubmission } from './reviews.mjs';
import { dispatchReview, reconcileReview, previewReview } from './delivery.mjs';
import { ensureProviderMailbox, createMailboxProvider, authorizeProviderRequest, recordProviderResult } from './provider-mailbox.mjs';
import { readDeliveryCapability } from './capabilities.mjs';
import { recordTaskSnapshot, readPlanTasks } from './tasks.mjs';

export function createPlanRuntime(env=process.env,overrides={}) {
  const root=overrides.db?dirname(overrides.db.root):env.HERDR_METADATA_STATE_DIR??join(env.XDG_STATE_HOME??join(env.HOME,'.local/state'),'herdr-agent-metadata');
  const appHome=env.HERDR_APP_HOME??join(env.HOME,'.config/herdr-app');
  const db=overrides.db??openDatabase({root:join(root,'v2')});
  const run=overrides.run??((host,command,args,options={})=>new Promise(resolve=>{
    if(host!=='local')return resolve({code:1,stdout:'',stderr:'peer-unavailable'});
    const child=execFile(command,args,{env:{...env,...options.env},cwd:options.cwd,timeout:8000,maxBuffer:2*1048576},(error,stdout,stderr)=>resolve({code:error?1:0,stdout:stdout??'',stderr:stderr??''}));
    child.stdin.on('error',()=>{});child.stdin.end(options.input);
  }));
  const runtime={root,appHome,db,run,clock:overrides.clock??Date.now,env,producerPid:overrides.producerPid??process.ppid};
  const lifecycle=runtime.lifecycle=createBindingLifecycle(db,runtime);
  db.transaction(sql=>sql.exec('CREATE TABLE IF NOT EXISTS plan_owner_versions (generation TEXT PRIMARY KEY, version TEXT NOT NULL)'));
  const recordVersion=(proof,version)=>{
    if(typeof version==='string'&&/^v?2\.[\w.+-]+$/.test(version)&&version.length<128)
      db.sql.prepare('INSERT OR REPLACE INTO plan_owner_versions VALUES (?,?)').run(proof.generation,version);
  };
  runtime.ownerVersion=proof=>db.sql.prepare('SELECT version FROM plan_owner_versions WHERE generation=?').get(proof.generation)?.version;
  runtime.deliveryCapability=(proof,options)=>readDeliveryCapability(proof,runtime,options);
  runtime.enabled=async(_session,proof,options)=>{
    const capability=await runtime.deliveryCapability(proof,options);
    return capability.send||capability.probeAllowed;
  };
  runtime.provider=createMailboxProvider(runtime);
  const scopedRequest=payload=>{
    const submission=getSubmission(payload.requestId,db);
    if(!decodeSession(payload.session).ok||sessionKey(submission.session)!==sessionKey(payload.session))throw Error('submission-unavailable');
    return submission;
  };
  async function terminal() {
    if(!env.HC_TERMINAL_ID)throw Error('owner-unavailable');
    const response=await run('local','hc',['get',env.HC_TERMINAL_ID,'--json'],{env:{HC_SESSION:env.HC_SESSION??'default'}});
    if(response.code!==0)throw Error('owner-unavailable');
    const value=JSON.parse(response.stdout);
    return {coreHost:'local',coreSession:env.HC_SESSION??'default',terminal:env.HC_TERMINAL_ID,createdMs:value.created_ms};
  }
  runtime.operations={
    init:async()=>{
      const directory=join(appHome,'data/session-plans/requests');await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
      return {initialized:true,node:process.execPath,mailbox:await ensureProviderMailbox(runtime)};
    },
    snapshot:()=>publishPlanView(runtime),
    register:async payload=>{
      const artifact=await registerArtifact(payload,{...runtime,proof:payload.proof});await publishPlanView(runtime);return artifact;
    },
    unregister:async payload=>{
      const removed=await unregisterArtifact(payload,{...runtime,proof:payload.proof});await publishPlanView(runtime);return removed;
    },
    'select-document':async payload=>{
      const selected=await setPrimaryArtifact(payload,{...runtime,proof:payload.proof});await publishPlanView(runtime);return selected;
    },
    list:payload=>listArtifacts(payload.session,{...runtime,proof:payload.proof}),
    read:async payload=>{
      const document=await readArtifact(payload,{...runtime,proof:payload.proof});
      const scope={...payload,artifactId:document.artifact.id};
      return {...document,...(document.state==='ready'?{tasks:readPlanTasks(document.artifact,document.text,document.sections,runtime)}:{}),
        ...(payload.review===true?{review:{comments:listComments(scope,db),conflicts:listCommentConflicts(scope,db),submissions:listSubmissions(scope,db)}}:{})};
    },
    'update-tasks':async payload=>{const result=await recordTaskSnapshot(payload,runtime);if(result.updated)await publishPlanView(runtime);return result;},
    // Draft persistence is scoped to a previously registered artifact, not the current process lifetime.
    'save-comment':payload=>saveComment(payload,db),
    comments:payload=>({comments:listComments(payload,db),conflicts:listCommentConflicts(payload,db),submissions:listSubmissions(payload,db)}),
    'resolve-conflict':payload=>resolveCommentConflict(payload,db),
    'preview-review':payload=>previewReview(payload,db),
    submit:async payload=>{
      const document=await readArtifact({session:payload.session,id:payload.artifactId},{...runtime,proof:payload.proof});
      if(document.state!=='ready')throw Error('document-unavailable');
      return createSubmission(payload,db);
    },
    dispatch:payload=>{scopedRequest(payload);return dispatchReview(payload.requestId,runtime);},
    receipt:payload=>{
      const submission=scopedRequest(payload);
      return payload.reconcile===true?reconcileReview(payload.requestId,runtime):submission.delivery;
    },
    'owner-review':payload=>authorizeProviderRequest(payload,runtime),
    'owner-review-result':payload=>recordProviderResult(payload,runtime),
    'owner-reserve':async payload=>{
      if(!decodeSession(payload.session).ok)throw Error('invalid-session');
      const target=await terminal();
      const stamp=await run('local','ps',['-o','lstart=','-p',String(runtime.producerPid)]);
      if(stamp.code!==0||!stamp.stdout.trim())throw Error('owner-unavailable');
      const previous=lifecycle.current('plan',target);
      // Restoring the same exact owner after a plugin reload is not a session replacement.
      const restored=previous && sessionKey(previous.session)===sessionKey(payload.session)
        && previous.processPid===runtime.producerPid && previous.processStartedAt===stamp.stdout.trim();
      if(restored) {
        const reservation=lifecycle.reservation('plan',target);
        if(reservation?.token===previous.generation)return reservation;
      }
      if(previous && !restored && payload.expectedGeneration===null && previous.processPid===runtime.producerPid
        && previous.processStartedAt===stamp.stdout.trim()) {
        // An unproven same-process conversation switch removes old authority; it never borrows its plan.
        await lifecycle.invalidate(previous,previous.generation);await publishPlanView(runtime);return null;
      }
      const expectedGeneration=payload.expectedGeneration??(restored?previous.generation:null);
      return lifecycle.reserve({channel:'plan',session:payload.session,terminal:target,
        producer:{pid:runtime.producerPid,startedAt:stamp.stdout.trim()},expectedGeneration});
    },
    'owner-commit':async({reservation,session,providerVersion})=>{
      if(!reservation || !decodeSession(session).ok || sessionKey(session)!==sessionKey(reservation.session) || reservation.producer?.pid!==runtime.producerPid)throw Error('invalid-owner');
      const now=runtime.clock();
      const proof={channel:'plan',session,...reservation.terminal,processPid:reservation.producer.pid,processStartedAt:reservation.producer.startedAt,
        generation:reservation.token,epoch:2,verifiedAt:now,leaseUntil:now+45000};
      if(!await lifecycle.commit(reservation,proof))throw Error('registration-unavailable');
      recordVersion(proof,providerVersion);
      await publishPlanView(runtime);return proof;
    },
    'owner-heartbeat':async({proof,providerVersion})=>{
      if(proof?.processPid!==runtime.producerPid)throw Error('invalid-owner');
      const next=await lifecycle.heartbeat(proof);if(!next)throw Error('owner-unavailable');
      recordVersion(next,providerVersion);
      await publishPlanView(runtime);return next;
    },
    'owner-release':async({proof})=>{
      if(proof?.processPid!==runtime.producerPid)throw Error('invalid-owner');
      await lifecycle.invalidate(proof,proof.generation);await publishPlanView(runtime);return {released:true};
    },
    'owner-end':async({session})=>{
      if(!decodeSession(session).ok)throw Error('invalid-session');
      for(const row of db.sql.prepare("SELECT data FROM registration_reservations WHERE channel='plan'").all()) {
        let reservation;try{reservation=JSON.parse(row.data);}catch{continue;}
        if(reservation.producer?.pid===runtime.producerPid && sessionKey(reservation.session)===sessionKey(session))
          await lifecycle.invalidate({channel:'plan',...reservation.terminal},reservation.token);
      }
      await publishPlanView(runtime);return {ended:true};
    },
    'owner-snapshot':()=>publishPlanView(runtime),
  };
  runtime.bridge=createPlanBridge(runtime,{operations:runtime.operations});
  return runtime;
}
