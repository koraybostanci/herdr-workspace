import { mkdtemp } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testTmpRoot } from '../helpers/tmp-root.mjs';
import { createPlanRuntime } from '../../integrations/session-metadata/src/plans/runtime.mjs';
import { decodeSession, decodeProof, sessionKey } from '../../integrations/session-metadata/src/protocol.mjs';
import { assertPlanOwner } from '../../integrations/session-metadata/src/plans/artifacts.mjs';

export function validateSmoke(options) {
  if(!['isolated','live-read'].includes(options.mode))throw Error('invalid-mode');
  if(options.send||options.resume||options.dispatch)throw Error('delivery-forbidden');
  if(options.mode==='isolated') {
    if(!/^herdr-plan-probe-[a-z0-9-]+$/.test(options.namespace??''))throw Error('invalid-owned-namespace');
    if(!decodeSession(options.session).ok||!options.ownedSessions?.includes(options.session.id))throw Error('non-owned-session');
  } else if(!decodeSession(options.session).ok||!decodeProof(options.proof).ok||options.proof.channel!=='plan'
    ||sessionKey(options.proof.session)!==sessionKey(options.session))throw Error('invalid-live-proof');
}
export async function runSmoke(options) {
  if(options.send||options.resume||options.dispatch)throw Error('delivery-forbidden');
  const checks=[],modifiedPaths=[];
  if(options.mode==='isolated') {
    const root=await mkdtemp(join(testTmpRoot(),'herdr-plan-probe-'));
    const namespace=root.split('/').pop().toLowerCase(),session={host:'local',authority:namespace,harness:'opencode-v2',id:'ses_'+namespace.replaceAll('-','_')};
    validateSmoke({...options,namespace,session,ownedSessions:[session.id]});
    const runtime=createPlanRuntime({...process.env,HC_SESSION:namespace,HERDR_APP_HOME:join(root,'app'),HERDR_METADATA_STATE_DIR:join(root,'state')});
    try {
      const init=await runtime.bridge.handle({op:'init',payload:{}}),view=await runtime.bridge.handle({op:'snapshot',payload:{}});
      checks.push({name:'private-helper',state:init.ok&&view.ok?'passed':'failed',evidence:root});
      checks.push({name:'owning-TUI-no-generation-delivery',state:'unavailable',evidence:'No independently owned connected TUI for this namespace. No prompt submitted; delivery gate remains disabled.'});
      modifiedPaths.push(root);
    } finally {runtime.db.close();}
  } else {
    if(options.mode!=='live-read'||!isAbsolute(options.document??'')||!decodeSession(options.session).ok)throw Error('invalid-live-target');
    const runtime=createPlanRuntime();
    try {
      const proof=await assertPlanOwner(options.session,runtime);
      validateSmoke({...options,proof});
      const kind=options.document.includes('/specs/')?'design':'implementation';
      const registered=await runtime.bridge.handle({op:'register',payload:{session:options.session,proof,path:options.document,kind,source:'explicit'}});
      if(!registered.ok)throw Error(registered.reason);
      checks.push({name:'exact-live-owner-registration',state:'passed',evidence:{session:options.session,artifact:registered.value}});
      modifiedPaths.push(runtime.db.path,join(runtime.appHome,'data/session-plans/view-v1.json'));
    } finally {runtime.db.close();}
  }
  return {checks,namingMode:'unchanged',modelCalls:0,modifiedPaths};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
  try {
    const unknown=args.filter(arg=>arg.startsWith('--')&&!['--mode','--session','--document','--json'].includes(arg));
    if(unknown.length)throw Error('delivery-or-unknown-option-forbidden');
    const result=await runSmoke({mode:get('--mode'),session:args.includes('--session')?JSON.parse(get('--session')):null,document:get('--document')});
    console.log(JSON.stringify(result,null,2));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
