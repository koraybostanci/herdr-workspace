import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { v2Fixture, proof, session, deferred } from './helpers/v2-fixtures.mjs';
import { bindingKey, sessionKey } from '../integrations/session-metadata/src/protocol.mjs';
import { registerArtifact, readArtifact } from '../integrations/session-metadata/src/plans/artifacts.mjs';
import { saveComment, listComments, listCommentConflicts, listSubmissions, resolveCommentConflict, createSubmission } from '../integrations/session-metadata/src/plans/reviews.mjs';
import * as deliveryApi from '../integrations/session-metadata/src/plans/delivery.mjs';
import { readPlanTasks, recordTaskSnapshot } from '../integrations/session-metadata/src/plans/tasks.mjs';
import { loadHerdrMod, modStorage } from './helpers/load-herdr-mod.mjs';
import { state as native, context, render, text, find } from './helpers/herdr-runtime.mjs';

const model=await import('../mods/plan/model.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const draftsModule=await import('../mods/plan/drafts.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const artifact={id:'doc-A',session,host:'local',path:'/task/plan.md',resolvedPath:'/task/plan.md',kind:'design',hash:'a'.repeat(64),revision:0,source:'explicit',primary:false};
function live() {
  const label=JSON.stringify({key:bindingKey(proof),generation:proof.generation,session:sessionKey(session),epoch:2});
  return {focused:{space:'sp',tab:'ta',pane:'pa',terminal:'t-plan',shown:null,agent:null},
    space:{id:'sp',active:true,tabs:[{id:'ta',active:true}]},
    agents:[{address:'t-plan',pane:'pa',space:'sp',tab:'ta',title:'Agent A',focused:true}],
    panes:[{pane:'pa',terminal:'t-plan',tab:'ta',focused:true}],
    terminals:[{address:'t-plan',state:'live',created_ms:100,labels:{'herdr.plan-binding':label}}],
    planView:{schema:1,owner:'herdr-session-plans',sequence:1,publishedAt:1000,entries:[{proof,artifacts:[artifact],capabilities:{send:false,reason:'unverified'}}],errors:[]},now:1000};
}

test('plan_panel_focus_retains_owner and manual titles cannot change document identity',()=>{
  assert.equal(typeof model.selectPlanOwner,'function');
  const data=live(),selected=model.selectPlanOwner(data);
  assert.equal(selected.owner.id,session.id);
  const after=model.selectPlanOwner({...data,focused:{space:'sp',tab:'ta',pane:null,terminal:null,agent:null},previous:selected});
  assert.equal(sessionKey(after.owner),sessionKey(selected.owner));
  const renamed=model.selectPlanOwner({...data,agents:[{...data.agents[0],title:'Human name'}],previous:after});
  assert.equal(renamed.epoch,after.epoch);
  assert.equal(model.planAvailable(renamed.owner,renamed.artifacts),true);
});

test('unbound selected agents, other tabs and reused terminals cannot borrow a neighboring plan',()=>{
  assert.equal(typeof model.selectPlanOwner,'function');
  const data=live(),selected=model.selectPlanOwner(data);
  const b={...data.agents[0],address:'t-other',pane:'pb'};
  const changed={...data,agents:[...data.agents,b],panes:[...data.panes,{pane:'pb',terminal:'t-other',tab:'ta'}],
    focused:{space:'sp',tab:'ta',terminal:'t-other'},previous:selected};
  assert.equal(model.selectPlanOwner(changed),null);
  assert.equal(model.selectPlanOwner({...data,terminals:[{...data.terminals[0],created_ms:101}],previous:selected}),null);
  assert.equal(model.selectPlanOwner({...data,focused:{space:'sp',tab:'other',terminal:null},previous:selected}),null);
  assert.equal(model.selectPlanOwner({...data,focused:{space:'other',tab:'ta',terminal:null},previous:selected}),null);
});

test('expired or malformed plan proof is isolated instead of freezing the healthy panel',()=>{
  assert.equal(typeof model.selectPlanOwner,'function');
  const data=live();
  assert.equal(model.selectPlanOwner({...data,now:46001}),null);
  const mixed={...data.planView,entries:[null,{proof:null},...data.planView.entries]};
  assert.equal(model.selectPlanOwner({...data,planView:mixed}).owner.id,session.id);
  assert.equal(model.selectPlanOwner({...data,planView:{...mixed,owner:'foreign'}}),null);
});

test('load acceptance rejects A-B-A stale responses using the request epoch and document identity',()=>{
  assert.equal(typeof model.acceptPlanLoad,'function');
  const first={ownerKey:sessionKey(session),artifactId:'doc-A',epoch:1,loadId:1};
  assert.equal(model.acceptPlanLoad(first,{...first}),true);
  assert.equal(model.acceptPlanLoad({...first,epoch:3,loadId:4},first),false);
  assert.equal(model.acceptPlanLoad({...first,artifactId:'doc-B'},first),false);
});

test('reader makes all image and HTML markup inert, including literal examples and ambiguous Markdown',()=>{
  assert.equal(typeof model.safePlanPresentation,'function');
  assert.equal(model.safePlanPresentation('# Plan\nNormal prose.').mode,'markdown');
  assert.equal(model.safePlanPresentation('![remote](https://example.com/a.png)').mode,'source');
  assert.equal(model.safePlanPresentation('<script>alert(1)</script>').mode,'source');
  assert.equal(model.safePlanPresentation('```html\n<img src="https://example.com/a.png">\n```').mode,'source');
  assert.equal(model.allowedPlanUrl('https://example.com/docs'),true);
  for(const url of ['javascript:alert(1)','file:///private/plan.md','https://name:password@example.com/','https://example.com/\n'])assert.equal(model.allowedPlanUrl(url),false);
  assert.equal(model.safePlanPresentation('`![image](https://example.com/a.png)``').mode,'source');
  assert.equal(model.safePlanPresentation('```bad`info\n![image](https://example.com/a.png)\n```').mode,'source');
  assert.equal(model.safePlanPresentation('Paragraph\n    ![image](https://example.com/a.png)').mode,'source');
  assert.equal(model.safePlanPresentation('`open\n` ![image](https://example.com/a.png) `close`').mode,'source');
});

async function draftFixture(t,intercept) {
  assert.equal(typeof draftsModule.ReviewDrafts,'function');
  const f=await v2Fixture();t.after(f.cleanup);
  const path=join(f.root,'plan.md');await writeFile(path,'# Plan\n');
  const a=await registerArtifact({session:f.session,proof:f.proof,path,kind:'design',source:'explicit'},
    {...f,proof:f.proof,lifecycle:{verify:async()=>true}});
  const client={call:async(op,payload)=>{
    if(intercept){const outcome=await intercept(op,payload);if(outcome)return outcome;}
    try {return {ok:true,value:op==='save-comment'?saveComment(payload,f.db):resolveCommentConflict(payload,f.db)};}
    catch(e){return {ok:false,reason:e.message};}
  }};
  return {...f,artifact:a,drafts:new draftsModule.ReviewDrafts(client)};
}

test('plan_failed_save_switch_retains_owner_tagged_text and Retry saves A, never the newly selected B',async t=>{
  let fail=true;const entered=deferred(),wait=deferred();
  const f=await draftFixture(t,async()=>{if(fail){entered.resolve();await wait.promise;return {ok:false,reason:'storage-failure'};}});
  const a=f.drafts.select(f.session,f.artifact);f.drafts.change(a.key,{text:'Keep this for A'});
  const pending=f.drafts.flush(a.key);await entered.promise;
  const b=f.drafts.select({...f.session,id:'ses_B'},{...f.artifact,id:'doc-B',session:{...f.session,id:'ses_B'}});
  wait.resolve();await pending;
  assert.equal(a.text,'Keep this for A');assert.ok(a.error);assert.equal(b.text,'');
  fail=false;await f.drafts.retry(a.key);
  assert.equal(a.error,null);assert.equal(a.dirty,false);
  assert.equal(listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'Keep this for A');
  assert.equal(b.text,'');
});

test('typing during an in-flight autosave retains newer text and uses the acknowledged revision next',async t=>{
  const entered=deferred(),wait=deferred();let first=true;
  const f=await draftFixture(t,async()=>{if(first){first=false;entered.resolve();await wait.promise;}});
  const row=f.drafts.select(f.session,f.artifact);f.drafts.change(row.key,{text:'First'});
  const pending=f.drafts.flush(row.key);await entered.promise;
  f.drafts.change(row.key,{text:'Newest text'});wait.resolve();await pending;
  assert.equal(row.text,'Newest text');assert.equal(row.dirty,true);
  await f.drafts.flush(row.key);
  assert.equal(row.dirty,false);assert.equal(row.revision,1);
  assert.equal(listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'Newest text');
});

test('conflict resolution uses the latest local text, including edits made after the conflicting attempt',async t=>{
  const f=await draftFixture(t);
  const original=saveComment({id:'known',session:f.session,artifactId:f.artifact.id,expectedRevision:null,text:'Initial',anchor:null,status:'open',documentHash:f.artifact.hash},f.db).comment;
  const row=f.drafts.select(f.session,f.artifact,original);
  f.drafts.change(row.key,{text:'My first attempt'});
  saveComment({...original,expectedRevision:0,text:'Other window'},f.db);
  await f.drafts.flush(row.key);assert.ok(row.conflict);
  f.drafts.change(row.key,{text:'My latest text'});
  await f.drafts.resolve(row.key,'mine');
  assert.equal(row.text,'My latest text');assert.equal(row.dirty,false);
  assert.equal(listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'My latest text');
});

test('a valid but mismatched save acknowledgement cannot mark different local text Saved',async t=>{
  const f=await draftFixture(t,async(_op,payload)=>({ok:true,value:{state:'saved',comment:{id:'server-id',session:payload.session,
    artifactId:payload.artifactId,revision:0,text:'Different server text',anchor:null,status:'open',documentHash:payload.documentHash}}}));
  const row=f.drafts.select(f.session,f.artifact);f.drafts.change(row.key,{text:'My intended text'});await f.drafts.flush(row.key);
  assert.equal(row.text,'My intended text');assert.equal(row.dirty,true);assert.equal(row.error,'invalid-save-response');
});

test('a conflict reply for another comment cannot retarget the active draft ID',async t=>{
  const f=await draftFixture(t,async(_op,payload)=>{
    const comment={id:'different-comment',session:payload.session,artifactId:payload.artifactId,revision:1,text:payload.text,anchor:null,status:'open',documentHash:payload.documentHash};
    return {ok:true,value:{state:'conflict',current:comment,attempt:comment,conflictId:'conflict-other'}};
  });
  const c=saveComment({id:'my-comment',session:f.session,artifactId:f.artifact.id,expectedRevision:null,text:'Initial',anchor:null,status:'open',documentHash:f.artifact.hash},f.db).comment;
  const row=f.drafts.select(f.session,f.artifact,c);f.drafts.change(row.key,{text:'Mine'});await f.drafts.flush(row.key);
  assert.equal(row.id,'my-comment');assert.equal(row.error,'invalid-save-response');
});

test('native helper client keeps comment bodies off argv and binds prepared writes to its owned directory',async()=>{
  let module;try{module=await loadHerdrMod('mods/plan','client.js');}catch(e){if(e.code!=='ENOENT')throw e;module={};}
  assert.equal(typeof module.PlanClient,'function');
  const id='11111111-1111-4111-8111-111111111111',nonce='22222222-2222-4222-8222-222222222222';
  const helper='/fixture/herdr/integrations/session-metadata/releases/33333333-3333-4333-8333-333333333333/bin/herdr-plan.mjs';
  const path='/fixture/herdr/data/session-plans/requests/'+id+'.json',commands=[];
  native.files={'/fixture/herdr/data/session-plans/runtime.json':JSON.stringify({schema:1,owner:'herdr-session-metadata',node:'/verified/node',helperPath:helper,stateRoot:'/fixture/state',buildHash:'a'.repeat(64)})};
  native.execute=async(command,args)=>{
    commands.push({command,args});
    if(args[1]==='prepare'){native.files[path]='';return {code:0,stdout:JSON.stringify({ok:true,value:{id,nonce,path,expected:''}}),stderr:''};}
    const request=JSON.parse(native.files[path]);
    assert.equal(request.payload.id,id);assert.equal(request.payload.text,'PRIVATE DRAFT TEXT');
    return {code:0,stdout:JSON.stringify({ok:true,value:{state:'saved',comment:{id}}}),stderr:''};
  };
  const result=await new module.PlanClient().call('save-comment',{text:'PRIVATE DRAFT TEXT'});
  assert.equal(result.ok,true);assert.equal(result.commentId,id);
  assert.equal(JSON.stringify(commands).includes('PRIVATE DRAFT TEXT'),false);
  assert.ok(commands.every(c=>c.args.includes('--state-root')&&c.args.includes('/fixture/state')));
  native.execute=null;native.files={};
});

test('native helper client refuses a runtime descriptor pointing at an unrelated executable script',async()=>{
  let module;try{module=await loadHerdrMod('mods/plan','client.js');}catch(e){if(e.code!=='ENOENT')throw e;module={};}
  assert.equal(typeof module.PlanClient,'function');let commands=0;
  native.files={'/fixture/herdr/data/session-plans/runtime.json':JSON.stringify({schema:1,owner:'herdr-session-metadata',node:'/verified/node',helperPath:'/unrelated/command.mjs',stateRoot:'/fixture/state',buildHash:'a'.repeat(64)})};
  native.execute=async()=>{commands++;return {code:1,stdout:'',stderr:''};};
  assert.equal((await new module.PlanClient().call('read',{})).ok,false);assert.equal(commands,0);
  native.execute=null;native.files={};
});

async function drain() {
  for(let round=0;native.tasks.length&&round<20;round++)await Promise.all(native.tasks.splice(0).map(task=>task()));
  assert.equal(native.tasks.length,0,'native tasks must settle without a render loop');
}
async function widgetFixture(t,folder='mods/plan') {
  let module;try{module=await loadHerdrMod(folder);}catch(e){if(e.code!=='ENOENT')throw e;module={};}
  assert.equal(typeof module.default,'function');
  const f=await draftFixture(t),data=live(),now=Date.now(),fresh={...proof,verifiedAt:now,leaseUntil:now+45000};
  data.space.name='Workspace';data.space.machine=null;data.space.folder=f.root;
  data.space.tabs[0]={...data.space.tabs[0],name:'Agent A',named:true,index:1,status:'idle'};
  data.panes[0].program={name:'OpenCode',key:'opencode',agent:true,icon:null};
  data.planView={...data.planView,publishedAt:now,entries:[{proof:fresh,artifacts:[f.artifact],capabilities:{send:false,reason:'unverified'}}]};
  native.data={allSpaces:[data.space],allAgents:data.agents,allPanes:data.panes,allTerminals:data.terminals,focused:data.focused,selectedSpace:'sp'};
  native.layout={id:'root',children:[{id:'sidebar',size:{px:320}},{id:'panel',hidden:false,children:[{id:'panel-body',active:'plan',children:[{id:'files'},{id:'changes'},{id:'plan'}]}]}]};
  native.files={'/fixture/herdr/data/session-plans/view-v1.json':JSON.stringify(data.planView),
    '/fixture/herdr/data/tabs/store.json':JSON.stringify({panels:JSON.stringify({sp:'files','sp-other':'changes'})})};
  native.tasks=[];native.timers=[];native.shared={};native.commands=[];native.openedUrls=[];native.sessionView=null;native.execute=null;
  modStorage(folder).clear();
  const view=new module.default();view.init({},context());
  const calls=[],admissions=[];
  if(folder==='mods/plan') {
    view.client={call:async(op,payload)=>{
      calls.push({op,payload});
      try {
        if(op==='read'){
          const document=await readArtifact(payload,{...f,proof:payload.proof??f.proof,lifecycle:{verify:async()=>true}});
          return {ok:true,value:document.state==='ready'?{...document,tasks:readPlanTasks(document.artifact,document.text,document.sections,f)}:document};
        }
        if(op==='comments')return {ok:true,value:{comments:listComments(payload,f.db),conflicts:listCommentConflicts(payload,f.db),submissions:listSubmissions(payload,f.db)}};
        if(op==='save-comment')return {ok:true,value:saveComment(payload,f.db)};
        if(op==='preview-review')return {ok:true,value:deliveryApi.previewReview(payload,f.db)};
        if(op==='submit')return {ok:true,value:createSubmission(payload,f.db)};
        if(op==='dispatch')return {ok:true,value:await deliveryApi.dispatchReview(payload.requestId,{...f,enabled:async()=>true,lifecycle:{verify:async()=>true},
          provider:{admit:async request=>{admissions.push(request);return {id:request.messageId,sessionID:request.session.id};},lookup:async()=> 'unknown'}})};
        return {ok:false,reason:'unsupported-test-operation'};
      } catch(e){return {ok:false,reason:e.message};}
    }};
    view.drafts.client=view.client;
  }
  await drain();render(view);await drain();
  return {...f,view,data,proof:fresh,calls,admissions};
}

test('native Plan reader renders the exact owned file and comments without resource creation or I/O in render',async t=>{
  const f=await widgetFixture(t),tree=render(f.view);
  assert.ok(text(tree).includes('# Plan\n'));
  assert.ok(find(tree,'plan-session').attributes.accessibility_label[0].includes(f.session.id));
  assert.equal(find(tree,'plan-composer'),undefined,'the initial reader is not squeezed above a permanent editor');
  find(tree,'plan-comments-toggle').attributes.on_click[0]({},context());assert.ok(find(render(f.view),'plan-composer'));
  assert.equal(f.calls.some(call=>['submit','dispatch'].includes(call.op)),false);
});

test('Plan shows only the selected session primary document, never the other registered plans or a remembered old choice',async t=>{
  const f=await widgetFixture(t),other={...f.artifact,id:'other-plan',path:'/task/other-plan.md',resolvedPath:'/task/other-plan.md',primary:false};
  f.view.planView.entries[0].artifacts=[other,{...f.artifact,primary:true}];
  modStorage('mods/plan').setItem('documents',JSON.stringify({[sessionKey(f.session)]:other.id}));
  if(f.view.documents)f.view.documents[sessionKey(f.session)]=other.id;
  render(f.view);await drain();const tree=render(f.view);
  assert.equal(f.calls.some(call=>call.op==='read'&&call.payload.id===other.id),false);
  assert.equal(f.view.document.artifact.id,f.artifact.id);
  assert.equal(find(tree,'plan-documents-trigger'),undefined);
  assert.equal(find(tree,'plan-documents-options'),undefined);
});

test('Source mode supplies a retained read-only selection/copy surface without changing the current plan or comments',async t=>{
  const f=await widgetFixture(t);f.view.composer.set_value('Keep my draft');
  const toggle=find(render(f.view),'plan-reader-mode');assert.ok(toggle);
  toggle.attributes.on_click[0]({},context());const source=find(render(f.view),'plan-source');assert.ok(source);
  assert.equal(find(render(f.view),'plan-document'),undefined);
  assert.equal(f.view.sourceEditor.value(),'# Plan\n');assert.equal(f.view.composer.value(),'Keep my draft');
  const editor=f.view.sourceEditor;
  find(render(f.view),'plan-reader-mode').attributes.on_click[0]({},context());
  assert.ok(find(render(f.view),'plan-document'));
  find(render(f.view),'plan-reader-mode').attributes.on_click[0]({},context());assert.equal(f.view.sourceEditor,editor);
});

test('native comment editor autosaves without submitting and can restore its acknowledged draft after reload',async t=>{
  const f=await widgetFixture(t);
  f.view.composer.set_value('Feedback from the native panel');f.view.flush(context());await drain();
  assert.equal(listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'Feedback from the native panel');
  assert.equal(f.calls.some(call=>['submit','dispatch'].includes(call.op)),false);
  assert.ok(text(render(f.view)).includes('Saved'));
  await f.view.close();const restored=new f.view.constructor();restored.init({},context());restored.client=f.view.client;restored.drafts.client=restored.client;
  await drain();render(restored);await drain();
  assert.equal(restored.composer.value(),'Feedback from the native panel');
});

test('plan_trigger_appears_before_panel_ever_mounts and cloned tabs preserve Files/Changes preferences',async t=>{
  const f=await widgetFixture(t,'mods/session-tabs'),tree=render(f.view);
  const button=find(tree,'panel-plan');assert.ok(button);
  assert.deepEqual(f.view.panels,{sp:'files','sp-other':'changes'});
  button.attributes.on_click[0]({},context());
  assert.ok(native.commands.some(command=>command.name==='layout.hide'));
  assert.deepEqual(f.view.panels,{sp:'files','sp-other':'changes'});
  native.data.focused={space:'sp',tab:'ta',terminal:'unbound'};
  assert.equal(find(render(f.view),'panel-plan'),undefined);
});

test('native Copy review uses only saved feedback and never admits a model turn',async t=>{
  const f=await widgetFixture(t);f.view.composer.set_value('Copy this review');f.view.flush(context());await drain();
  find(render(f.view),'plan-copy-review').attributes.on_click[0]({},context());await drain();
  assert.ok(native.clipboard.includes('Copy this review'));assert.ok(native.clipboard.includes(f.artifact.path));
  assert.equal(f.calls.some(call=>['submit','dispatch'].includes(call.op)),false);
});

test('native Send review requires a separate explicit confirmation and targets one frozen batch',async t=>{
  const f=await widgetFixture(t);f.view.planView.entries[0].capabilities.send=true;
  f.view.composer.set_value('Review before implementing');f.view.flush(context());await drain();
  find(render(f.view),'plan-send-review').attributes.on_click[0]({},context());await drain();
  assert.equal(f.calls.some(call=>call.op==='submit'),false);
  const confirm=find(render(f.view),'plan-confirm-send');assert.ok(confirm);
  confirm.attributes.on_click[0]({},context());await drain();
  assert.equal(f.admissions.length,1);assert.deepEqual(f.admissions[0].session,f.session);
  assert.equal(listSubmissions({session:f.session,artifactId:f.artifact.id},f.db).length,1);
});

test('a completed send for A cannot put its delivery status into the newly selected B panel',async t=>{
  const f=await widgetFixture(t);f.view.planView.entries[0].capabilities.send=true;
  f.view.composer.set_value('Send to A');f.view.flush(context());await drain();
  find(render(f.view),'plan-send-review').attributes.on_click[0]({},context());await drain();
  const entered=deferred(),wait=deferred(),original=f.view.client.call;
  f.view.client.call=async(op,payload)=>{if(op==='dispatch'){entered.resolve();await wait.promise;}return original(op,payload);};
  find(render(f.view),'plan-confirm-send').attributes.on_click[0]({},context());
  const work=native.tasks.splice(0).map(task=>task());await entered.promise;
  const owner={...f.session,id:'ses_plan_B'},proofB={...f.proof,session:owner,terminal:'t-other',createdMs:200,processPid:30,processStartedAt:'B-start',generation:'generation-B'};
  const path=join(f.root,'b.md');await writeFile(path,'# Plan B\n');
  const artifactB=await registerArtifact({session:owner,proof:proofB,path,kind:'design',source:'explicit'},{...f,proof:proofB,lifecycle:{verify:async()=>true}});
  native.data.allAgents.push({...native.data.allAgents[0],address:'t-other',pane:'pb',title:'Agent B',focused:true});
  native.data.allPanes.push({...native.data.allPanes[0],pane:'pb',terminal:'t-other'});
  native.data.allTerminals.push({address:'t-other',state:'live',created_ms:200,labels:{'herdr.plan-binding':JSON.stringify({key:bindingKey(proofB),generation:proofB.generation,session:sessionKey(owner),epoch:2})}});
  f.view.planView.entries.push({proof:proofB,artifacts:[artifactB],capabilities:{send:true}});native.data.focused={space:'sp',tab:'ta',terminal:'t-other'};
  render(f.view);await drain();wait.resolve();await Promise.all(work);await drain();
  assert.equal(f.admissions.length,1);assert.deepEqual(f.admissions[0].session,f.session);
  assert.equal(text(render(f.view)).includes('Accepted by harness'),false);
});

test('whole-document feedback keeps its earlier revision visible after a file update',async t=>{
  const f=await widgetFixture(t);f.view.composer.set_value('Earlier document comment');f.view.flush(context());await drain();
  await writeFile(f.artifact.path,'# Changed plan\n');f.view.load(context());await drain();
  assert.ok(text(render(f.view)).includes('Earlier revision'));
});

test('formatted reader overrides automatic link opening and send-focus restoration targets a rendered control',async t=>{
  const f=await widgetFixture(t),tree=render(f.view),document=find(tree,'plan-document');
  document.attributes.on_link_click[0]('file:///private/secrets',context());
  document.attributes.on_link_click[0]('javascript:alert(1)',context());
  document.attributes.on_link_click[0]('https://example.com/docs',context());
  assert.deepEqual(native.openedUrls,['https://example.com/docs']);
  assert.equal(find(tree,'plan-send-review').attributes.track_focus?.[0],f.view.sendFocus);
});

test('failed outgoing drafts have a recovery action even when the selected agent has no Plan',async t=>{
  const f=await widgetFixture(t),original=f.view.client.call;
  f.view.client.call=async(op,payload)=>op==='save-comment'?{ok:false,reason:'storage-failure'}:original(op,payload);
  f.view.composer.set_value('Unsaved text for A');f.view.flush(context());await drain();
  native.data.focused={space:'sp',tab:'ta',terminal:'unbound'};render(f.view);
  const tabs=await loadHerdrMod('mods/session-tabs'),bar=new tabs.default();bar.init({},context());await drain();
  const tree=render(bar);assert.equal(find(tree,'panel-plan'),undefined);
  const recovery=find(tree,'plan-draft-recovery');assert.ok(recovery);
  recovery.attributes.on_click[0]({},context());
  assert.ok(text(render(f.view)).includes('Draft recovery'));assert.equal(f.view.composer.value(),'Unsaved text for A');
  f.view.client.call=original;find(render(f.view),'plan-retry-save').attributes.on_click[0]({},context());await drain();
  assert.equal(listComments({session:f.session,artifactId:f.artifact.id},f.db)[0].text,'Unsaved text for A');
});

test('inert source reader retains its native editor entity across an unchanged refresh',async t=>{
  const f=await widgetFixture(t);await writeFile(f.artifact.path,'# Example\n```html\n<img src="https://example.com/a.png">\n```\n');
  f.view.load(context());await drain();const editor=f.view.sourceEditor;assert.ok(editor);
  assert.equal(find(render(f.view),'plan-document'),undefined);assert.ok(find(render(f.view),'plan-source'));
  f.view.load(context());await drain();assert.equal(f.view.sourceEditor,editor);
});

test('malformed reader and review entries cannot reach native controls or hide healthy comments',async t=>{
  const f=await widgetFixture(t),c=saveComment({id:'healthy',session:f.session,artifactId:f.artifact.id,expectedRevision:null,text:'Healthy feedback',anchor:null,status:'open',documentHash:f.artifact.hash},f.db).comment;
  const sub=createSubmission({session:f.session,artifactId:f.artifact.id,documentHash:f.artifact.hash,comments:[{id:c.id,revision:0}],confirmed:true,proof:f.proof},f.db);
  const original=f.view.client.call;
  f.view.client.call=async(op,payload)=>op==='comments'?{ok:true,value:{comments:[null,{},c],submissions:[null,{session:{bad:true}},sub]}}:original(op,payload);
  f.view.load(context());await assert.doesNotReject(drain());
  assert.equal(f.view.comments.length,1);assert.equal(f.view.submissions.length,1);
  find(render(f.view),'plan-copy-review').attributes.on_click[0]({},context());await assert.doesNotReject(drain());
  assert.ok(native.clipboard.includes('Healthy feedback'));
  f.view.client.call=async(op,payload)=>op==='read'?{ok:true,value:{artifact:f.artifact,state:'ready',text:123,sections:[]}}:original(op,payload);
  f.view.load(context());await drain();assert.doesNotThrow(()=>render(f.view));assert.equal(find(render(f.view),'plan-document'),undefined);
});

test('Plan and Tasks retain a private draft and place work under its actual phase',async t=>{
  const f=await widgetFixture(t);await writeFile(f.artifact.path,'# Plan\n## Phase 1: Prepare\n- [x] Read\n## Phase 2: Build\n- [-] API\n');
  f.view.load(context());await drain();f.view.composer.set_value('Keep this feedback');
  const tab=find(render(f.view),'plan-tab-tasks');assert.ok(tab);tab.attributes.on_click[0]({},context());
  const tree=render(f.view);assert.ok(find(tree,'plan-tasks'));
  const phases=f.view.document.tasks.phases;
  assert.ok(text(find(tree,'plan-phase-'+phases[0].id)).includes('Read'));
  assert.ok(text(find(tree,'plan-phase-'+phases[1].id)).includes('API'));
  assert.ok(text(tree).includes('In progress'));assert.equal(f.view.composer.value(),'Keep this feedback');
  find(tree,'plan-tab-document').attributes.on_click[0]({},context());assert.ok(find(render(f.view),'plan-document'));
  assert.equal(f.view.composer.value(),'Keep this feedback');assert.equal(f.admissions.length,0);
});

test('Tasks has a flat list without phases and a truthful empty state without tasks',async t=>{
  const f=await widgetFixture(t);find(render(f.view),'plan-tab-tasks')?.attributes.on_click[0]({},context());
  assert.ok(text(render(f.view)).includes('No tasks in this plan yet.'));
  await writeFile(f.artifact.path,'# Plan\n- [ ] Build API\n');f.view.load(context());await drain();
  const tree=render(f.view);assert.ok(find(tree,'plan-task-list'));assert.ok(text(tree).includes('Build API'));assert.equal(find(tree,'plan-phase-list'),undefined);
});

test('a section comment opens the review drawer anchored to the chosen section',async t=>{
  const f=await widgetFixture(t),tree=render(f.view),section=f.view.sections[0];
  const action=find(tree,'plan-comment-section-0');assert.ok(action);action.attributes.on_click[0]({},context());
  assert.ok(find(render(f.view),'plan-composer'));assert.deepEqual(f.view.drafts.rows.get(f.view.editKey).anchor.headingPath,section.headingPath);
  f.view.composer.set_value('Clarify this section');f.view.flush(context());await drain();
  find(render(f.view),'plan-comments-toggle').attributes.on_click[0]({},context());assert.equal(find(render(f.view),'plan-composer'),undefined);
  assert.ok(text(render(f.view)).some(value=>value.includes('Review (1)')));
});

test('Open Markdown splits a source-only owned file pane in the same agent tab',async t=>{
  const f=await widgetFixture(t);f.view.composer.set_value('Keep review context');
  const open=find(render(f.view),'plan-open-markdown');assert.ok(open);open.attributes.on_click[0]({},context());
  const command=native.commands.find(command=>command.name==='pane.split');assert.ok(command);
  assert.equal(command.args.pane,'pa');assert.equal(command.args.mod,'plan');assert.equal(command.args.props.file.artifactId,f.artifact.id);
  assert.deepEqual(command.args.props.file.session,f.session);assert.equal(command.args.props.file.terminal,'t-plan');
  native.data.allPanes.push({pane:'file-pane',terminal:null,mod:'plan',tab:'ta',focused:true});
  native.data.focused={space:'sp',tab:'ta',pane:'file-pane',terminal:null};
  render(f.view);await drain();assert.equal(f.view.composer.value(),'Keep review context');assert.equal(f.view.selection.owner.id,f.session.id);
  const file=new f.view.constructor();file.init(command.args.props,context());file.client=f.view.client;
  if(file.fileView)file.fileView.client=f.view.client;
  await drain();render(file);await drain();const tree=render(file);
  assert.ok(find(tree,'plan-file-source'));assert.equal(find(tree,'plan-composer'),undefined);assert.equal(find(tree,'plan-send-review'),undefined);
  assert.ok(text(tree).includes('# Plan\n'));
  native.data.focused={space:'sp',tab:'other',terminal:null};assert.equal(find(render(file),'plan-file-source'),undefined);
  await file.close();
});

test('one confirmed review batches multiple section comments and the general note',async t=>{
  const f=await widgetFixture(t);f.view.planView.entries[0].capabilities.send=true;
  const section=f.view.sections[0];
  saveComment({id:'section-one',session:f.session,artifactId:f.artifact.id,expectedRevision:null,text:'Section feedback',anchor:f.view.anchor(section),status:'open',documentHash:f.artifact.hash},f.db);
  f.view.composer.set_value('Overall review note');f.view.flush(context());await drain();
  find(render(f.view),'plan-send-review').attributes.on_click[0]({},context());await drain();
  find(render(f.view),'plan-confirm-send').attributes.on_click[0]({},context());await drain();
  assert.equal(f.admissions.length,1);assert.ok(f.admissions[0].text.includes('Section feedback'));assert.ok(f.admissions[0].text.includes('Overall review note'));
});

test('task-only metadata publication refreshes statuses without a Markdown revision change',async t=>{
  const f=await widgetFixture(t);await writeFile(f.artifact.path,'# Plan\n## Phase 1: Build\n- [ ] API\n');f.view.load(context());await drain();
  const current=f.view.document.artifact;
  await recordTaskSnapshot({session:f.session,proof:f.proof,eventId:'live-tasks',observedAt:1000,tasks:[{id:'a',title:'API',status:'completed'}],plan:{path:current.path,documentHash:current.hash}},
    {...f,lifecycle:{verify:async()=>true}});
  find(render(f.view),'plan-tab-tasks').attributes.on_click[0]({},context());f.view.planView.sequence++;
  render(f.view);await drain();assert.ok(text(render(f.view)).includes('Done'));
});

test('phase controls collapse work and open the corresponding document section',async t=>{
  const f=await widgetFixture(t);await writeFile(f.artifact.path,'# Plan\n## Phase 1: Prepare\n- [ ] Read\n## Phase 2: Ship\n- [ ] Deploy\n');
  f.view.load(context());await drain();find(render(f.view),'plan-tab-tasks').attributes.on_click[0]({},context());
  const phase=f.view.document.tasks.phases[1];
  find(render(f.view),'plan-phase-toggle-'+phase.id).attributes.on_click[0]({},context());
  assert.equal(text(find(render(f.view),'plan-phase-'+phase.id)).includes('Deploy'),false);
  find(render(f.view),'plan-phase-open-'+phase.id).attributes.on_click[0]({},context());
  const tree=render(f.view);assert.ok(text(tree).some(value=>value.includes('Deploy')));assert.equal(text(tree).some(value=>value.includes('Read')),false);
  assert.ok(find(tree,'plan-full-document'));
});

test('malformed task entries are isolated without hiding healthy phase tasks',async t=>{
  const f=await widgetFixture(t);await writeFile(f.artifact.path,'# Plan\n## Phase 1: Build\n- [ ] API\n');f.view.load(context());await drain();
  f.view.document.tasks.phases.push(null,{});f.view.document.tasks.phases[0].tasks.push(null,{title:123});
  find(render(f.view),'plan-tab-tasks').attributes.on_click[0]({},context());assert.doesNotThrow(()=>render(f.view));assert.ok(text(render(f.view)).includes('API'));
});

test('editing an earlier local comment retains that exact draft through refresh',async t=>{
  const f=await widgetFixture(t);f.view.composer.set_value('First feedback');f.view.flush(context());await drain();
  const first=f.view.drafts.rows.get(f.view.editKey).id;
  find(render(f.view),'plan-new-comment').attributes.on_click[0]({},context());
  f.view.composer.set_value('Second feedback');f.view.flush(context());await drain();
  find(render(f.view),'plan-edit-'+first).attributes.on_click[0]({},context());assert.equal(f.view.composer.value(),'First feedback');
  f.view.load(context());await drain();assert.equal(f.view.composer.value(),'First feedback');
  f.view.composer.set_value('Revised first feedback');f.view.flush(context());await drain();
  const comments=listComments({session:f.session,artifactId:f.artifact.id},f.db);
  assert.equal(comments.find(comment=>comment.id===first).text,'Revised first feedback');
  assert.ok(comments.some(comment=>comment.text==='Second feedback'));
});

test('an unchanged metadata heartbeat preserves the frozen review confirmation',async t=>{
  const f=await widgetFixture(t);f.view.planView.entries[0].capabilities.send=true;
  f.view.composer.set_value('Confirm this feedback');f.view.flush(context());await drain();
  find(render(f.view),'plan-send-review').attributes.on_click[0]({},context());await drain();const preview=f.view.preview;assert.ok(preview);
  const renewed={...f.view.planView.entries[0].proof,verifiedAt:Date.now(),leaseUntil:Date.now()+45000};f.view.planView.entries[0].proof=renewed;
  f.view.planView.sequence++;render(f.view);await drain();assert.equal(f.view.preview,preview);
  find(render(f.view),'plan-confirm-send').attributes.on_click[0]({},context());await drain();assert.equal(f.admissions.length,1);
  assert.deepEqual(f.calls.find(call=>call.op==='submit').payload.proof,renewed);
});

test('native retry of unknown delivery warns about duplicates and requires a new explicit confirmation',async t=>{
  const f=await widgetFixture(t);f.view.planView.entries[0].capabilities.send=true;
  const original=f.view.client.call;let lose=true;
  f.view.client.call=async(op,payload)=>op==='dispatch'&&lose?{ok:true,value:await deliveryApi.dispatchReview(payload.requestId,{...f,enabled:async()=>true,lifecycle:{verify:async()=>true},
    provider:{admit:async request=>{f.admissions.push(request);throw Error('lost acknowledgement');},lookup:async()=> 'unknown'}})}:original(op,payload);
  f.view.composer.set_value('Retry explicitly');f.view.flush(context());await drain();
  find(render(f.view),'plan-send-review').attributes.on_click[0]({},context());await drain();find(render(f.view),'plan-confirm-send').attributes.on_click[0]({},context());await drain();
  assert.equal(f.view.delivery.state,'unknown');assert.equal(f.admissions.length,1);
  const retry=find(render(f.view),'plan-retry-review');assert.ok(retry);retry.attributes.on_click[0]({},context());await drain();
  assert.ok(text(render(f.view)).some(value=>value.includes('duplicates')));assert.equal(f.admissions.length,1);
  lose=false;find(render(f.view),'plan-confirm-send').attributes.on_click[0]({},context());await drain();
  assert.equal(f.admissions.length,2);assert.notEqual(f.admissions[0].messageId,f.admissions[1].messageId);
});

test('stale native comment controls reject a switched context instead of editing or throwing for another agent',async t=>{
  const f=await widgetFixture(t),comment=saveComment({id:'old-control',session:f.session,artifactId:f.artifact.id,expectedRevision:null,text:'Keep owner A',anchor:null,status:'open',documentHash:f.artifact.hash},f.db).comment;
  f.view.load(context());await drain();find(render(f.view),'plan-comments-toggle').attributes.on_click[0]({},context());
  const click=find(render(f.view),'plan-edit-'+comment.id).attributes.on_click[0];
  native.data.focused={space:'sp',tab:'ta',terminal:'unbound'};render(f.view);
  assert.doesNotThrow(()=>click({},context()));assert.equal(f.view.editKey,null);
});

test('a malformed submission acknowledgement cannot make the native view dispatch an unvalidated batch',async t=>{
  const f=await widgetFixture(t);f.view.planView.entries[0].capabilities.send=true;
  f.view.composer.set_value('Validate this batch');f.view.flush(context());await drain();
  find(render(f.view),'plan-send-review').attributes.on_click[0]({},context());await drain();
  const original=f.view.client.call;
  f.view.client.call=async(op,payload)=>{const result=await original(op,payload);return op==='submit'&&result.ok?{ok:true,value:{...result.value,artifactId:'different-document'}}:result;};
  find(render(f.view),'plan-confirm-send').attributes.on_click[0]({},context());await drain();
  assert.equal(f.admissions.length,0);
});
