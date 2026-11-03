import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyObservation } from '../integrations/session-metadata/src/engine.mjs';
import { projectSessionCard } from '../mods/space-agents/session-metadata.js';
import { createOpenCodeAdapter } from '../integrations/session-metadata/opencode/adapter.mjs';
import { bindingKey } from '../integrations/session-metadata/src/contracts.mjs';
import { isolatedFixture } from './helpers/session-metadata-fixtures.mjs';

async function fixture(t) {
  const f=await isolatedFixture();t.after(f.cleanup);
  assert.equal(await f.store.bind(f.binding,null),true);
  const directory=join(f.root,'herdr-app');await mkdir(join(directory,'mods/agents'),{recursive:true});await writeFile(join(directory,'AGENTS.md'),'# Herdr\n');
  const calls=[];
  const run=async(host,command,args,options={})=>{
    calls.push({host,command,args,cwd:options.cwd});
    if(command==='git'&&options.cwd==='/diagnostics/incident-docs') {
      const text=args.includes('--show-toplevel')?'/diagnostics/incident-docs':args.includes('--show-prefix')?'':args[0]==='config'?'git@github.com:team/incident-docs.git':args.includes('--git-dir')?'/diagnostics/incident-docs/.git\n/diagnostics/incident-docs/.git':'feature/incident';
      return {code:0,stdout:text,stderr:''};
    }
    if(command==='gh')return {code:0,stdout:JSON.stringify([{number:6029,state:'OPEN',url:'https://github.com/team/incident-docs/pull/6029',headRefName:'feature/incident',headRepository:{name:'incident-docs'},headRepositoryOwner:{login:'team'}}]),stderr:''};
    return {code:1,stdout:'',stderr:'not a git repository'};
  };
  const access={...f.access,get:async()=>({key:f.key,title:'configure-herdr',parentId:null,lookupDir:directory})};
  const deps={store:f.store,run,access,clock:()=>5000,activationMode:async()=> 'observe',validateBinding:async()=>true,hasAuthority:async()=>true};
  const observe=(eventId,payload,kind='tool',observedAt=1000)=>applyObservation({...f.observation,eventId,kind,observedAt,payload},f.binding,deps);
  return {...f,directory,run,calls,deps,observe};
}

test('read-only inspection cannot attach incident-docs and its PR to a non-Git Herdr session',async t=>{
  const f=await fixture(t);
  await f.observe('probe',{tool:'functions.shell',workdir:'/diagnostics/incident-docs',command:'git status'});
  const record=await f.store.read(f.key);
  assert.equal(record.activeRepo,null);
  const card=projectSessionCard({title:'old',cwd:'/launch',directory:'launch',branch:null},record);
  assert.equal(card.cwd,f.directory);assert.equal(card.branch,null);assert.equal(card.sessionPr,null);assert.equal(card.projectRepo,null);
});

test('structured config work clears legacy active Git while keeping its historical association',async t=>{
  const f=await fixture(t);
  const old={...f.record,canonicalTitle:'configure-herdr',bindings:[{key:bindingKey(f.binding),generation:f.binding.generation}]};
  await f.store.write(old,null);
  await f.observe('config-write',{tool:'functions.patch',patchText:`*** Begin Patch\n*** Update File: ${f.directory}/mods/agents/main.js\n@@\n-old\n+new\n*** End Patch`});
  const record=await f.store.read(f.key);assert.equal(record.activeRepo,null);
  assert.ok(record.contexts['github.com/team/repo-a']);
  const card=projectSessionCard({title:'old',cwd:'/launch',directory:'launch',branch:'stale-pane-branch'},record);
  assert.equal(card.directory,'herdr-app');assert.equal(card.cwd,f.directory);assert.equal(card.branch,null);assert.equal(card.suppressTitlePr,true);
  assert.equal(record.canonicalTitle,'configure-herdr');
});

test('a title refresh cannot resurrect legacy Git from its own stale workdir payload',async t=>{
  const f=await fixture(t);await f.store.write({...f.record,bindings:[{key:bindingKey(f.binding),generation:f.binding.generation}]},null);
  await f.observe('poll',{cwd:'/parent/repo-a'},'title');
  assert.equal((await f.store.read(f.key)).activeRepo,null);
  assert.equal(f.calls.some(c=>c.cwd==='/parent/repo-a'),false);
});

test('explicit non-Git location change removes the active PR and leaves canonical names alone',async t=>{
  const f=await fixture(t);await f.observe('git-task',{cwd:'/diagnostics/incident-docs'},'location');
  assert.equal((await f.store.read(f.key)).activeRepo,'github.com/team/incident-docs');
  await f.observe('move-back',{cwd:f.directory},'location',2000);
  const record=await f.store.read(f.key);assert.equal(record.activeRepo,null);assert.equal(record.canonicalTitle,'configure-herdr');
  assert.ok(record.contexts['github.com/team/incident-docs']);
});

test('failed tools and plan artifacts cannot displace established task scope',async t=>{
  const f=await fixture(t);await f.observe('task',{cwd:f.directory},'location');
  await f.observe('failed',{tool:'functions.shell',workdir:'/diagnostics/incident-docs',command:'npm test',failed:true},'tool',2000);
  await f.observe('plan',{tool:'write',filePath:'/other-project/docs/superpowers/plans/plan.md'},'tool',3000);
  assert.equal((await f.store.read(f.key)).activeRepo,null);
  assert.equal(projectSessionCard({cwd:'/launch'},await f.store.read(f.key)).cwd,f.directory);
});

test('OpenCode refresh derives work scope from successful operations, not diagnostic workdirs',async t=>{
  const f=await fixture(t),id=f.key.id;
  const messages=[{type:'assistant',id:'msg-work',time:{created:1000,completed:1001},content:[
    {type:'tool',id:'edit',name:'functions.patch',time:{completed:1000},state:{status:'completed',input:{patchText:`*** Begin Patch\n*** Update File: ${f.directory}/mods/agents/main.js\n@@\n-a\n+b\n*** End Patch`},content:[]}},
    {type:'tool',id:'probe',name:'functions.shell',time:{completed:1001},state:{status:'completed',input:{workdir:'/diagnostics/incident-docs',command:'git status'},content:[]}},
  ]}];
  const context={app:{version:'2.test'},ui:{router:{current:()=>({type:'session',sessionID:id})}},
    client:{session:{get:async()=>({id,title:'configure-herdr',location:{directory:'/launch'},time:{updated:2000}})}},
    data:{session:{root:x=>x,message:{sync:async()=>{},list:()=>messages}}}};
  const adapter=createOpenCodeAdapter(context,{...f.deps,identity:{enabled:true,verify:async()=>f.binding,commit:async()=>true,release:async()=>{},validate:async()=>true},engine:applyObservation});
  await adapter.refresh();
  const record=await f.store.read(f.key);assert.equal(record.activeRepo,null);
  assert.equal(projectSessionCard({cwd:'/launch'},record).cwd,f.directory);
  await adapter.dispose();
});

test('unknown tool output cannot attach a foreign PR even when it quotes a PR-creation command',async t=>{
  const f=await fixture(t);
  await f.observe('quoted-command',{tool:'read',command:'gh pr create',output:'https://github.com/team/incident-docs/pull/6029'});
  assert.equal((await f.store.read(f.key)).activeRepo,null);
});

test('literal task-command targets take precedence over the outer launch directory',async t=>{
  const f=await fixture(t);
  await f.observe('actual-task',{tool:'functions.shell',workdir:f.directory,command:'cd /diagnostics/incident-docs && npm test'});
  const record=await f.store.read(f.key);assert.equal(record.activeRepo,'github.com/team/incident-docs');
  const card=projectSessionCard({cwd:'/launch'},record);assert.equal(card.sessionPr.number,6029);
  await f.observe('probe-other',{tool:'functions.shell',workdir:f.directory,command:'git status'},'tool',2000);
  assert.equal((await f.store.read(f.key)).activeRepo,'github.com/team/incident-docs');
});

test('a failed tool cannot clear a legitimate Git scope or its verified PR',async t=>{
  const f=await fixture(t);await f.observe('git-work',{cwd:'/diagnostics/incident-docs'},'location');
  await f.observe('failed-test',{tool:'functions.shell',workdir:f.directory,command:'npm test',failed:true},'tool',2000);
  const record=await f.store.read(f.key);assert.equal(record.activeRepo,'github.com/team/incident-docs');
  const card=projectSessionCard({cwd:'/launch'},record);assert.equal(card.branch,'feature/incident');assert.equal(card.sessionPr.number,6029);
});

test('ungoverned temporary report output cannot replace confirmed project scope',async t=>{
  const f=await fixture(t);await f.observe('config',{tool:'write',filePath:join(f.directory,'mods/agents/main.js')});
  await f.observe('report',{tool:'write',filePath:join(f.root,'report.md')},'tool',2000);
  assert.equal(projectSessionCard({cwd:'/launch'},await f.store.read(f.key)).cwd,f.directory);
});

test('refresh repairs an ungoverned file scope using the newest governed work rather than a later report',async t=>{
  const f=await fixture(t);
  await f.store.write({...f.record,workScope:{version:1,host:'local',path:f.root,source:'successful-file-work',eventId:'old-report',eventAt:2000}},null);
  await f.observe('refresh',{scopeEvidence:[
    {eventId:'real-work',eventAt:1000,operation:{kind:'file',paths:[join(f.directory,'mods/agents/main.js')],source:'successful-file-work'}},
    {eventId:'later-report',eventAt:2000,operation:{kind:'file',paths:[join(f.root,'report.md')],source:'successful-file-work'}},
  ]},'title',3000);
  assert.equal(projectSessionCard({cwd:'/launch'},await f.store.read(f.key)).cwd,f.directory);
});

async function globalInstructions(f) {
  const home=join(f.root,'home'),directory=join(home,'.agents');
  await mkdir(directory,{recursive:true});await writeFile(join(directory,'AGENTS.md'),'# Global agent instructions\n');
  f.deps.homeDirectory=home;
  return directory;
}

test('incidental global agent instruction edits cannot replace the established project',async t=>{
  const f=await fixture(t),instructions=await globalInstructions(f);
  await f.observe('project',{cwd:'/diagnostics/incident-docs'},'location');
  await f.observe('global-rule',{tool:'functions.patch',patchText:`*** Begin Patch\n*** Update File: ${instructions}/AGENTS.md\n@@\n-old\n+new\n*** End Patch`},'tool',2000);
  const record=await f.store.read(f.key);
  assert.equal(record.workScope.path,'/diagnostics/incident-docs');
  assert.equal(record.activeRepo,'github.com/team/incident-docs');
});

test('refresh repairs an old global-instruction scope using earlier project work',async t=>{
  const f=await fixture(t),instructions=await globalInstructions(f);
  await f.store.write({...f.record,activeRepo:null,workScope:{version:1,host:'local',path:instructions,source:'successful-file-work',eventId:'global-rule',eventAt:2000}},null);
  await f.observe('repair',{scopeEvidence:[
    {eventId:'project-work',eventAt:1000,operation:{kind:'directory',paths:['/diagnostics/incident-docs'],source:'successful-task-command'}},
    {eventId:'global-rule',eventAt:2000,operation:{kind:'file',paths:[join(instructions,'AGENTS.md')],source:'successful-file-work'}},
  ]},'title',3000);
  const record=await f.store.read(f.key);
  assert.equal(record.workScope.path,'/diagnostics/incident-docs');
  assert.equal(projectSessionCard({cwd:'/launch'},record).directory,'incident-docs');
});

test('an explicit global-instructions location remains valid primary work',async t=>{
  const f=await fixture(t),instructions=await globalInstructions(f);
  await f.observe('explicit-config-work',{cwd:instructions},'location');
  await f.observe('edit-config',{tool:'write',filePath:join(instructions,'AGENTS.md')},'tool',2000);
  await f.observe('refresh-config',{},'title',3000);
  assert.equal((await f.store.read(f.key)).workScope.path,instructions);
});

test('an explicit nested global-instructions task survives an edit governed by the parent',async t=>{
  const f=await fixture(t),instructions=await globalInstructions(f),directory=join(instructions,'skills');
  await mkdir(join(directory,'find-skills'),{recursive:true});
  await f.observe('explicit-skill-work',{cwd:directory},'location');
  await f.observe('edit-skill',{tool:'write',filePath:join(directory,'find-skills','SKILL.md')},'tool',2000);
  await f.observe('refresh-skill',{},'title',3000);
  assert.equal((await f.store.read(f.key)).workScope.path,directory);
});

test('project-local agent instructions are still project work',async t=>{
  const f=await fixture(t);await globalInstructions(f);
  await mkdir(join(f.directory,'.agents'),{recursive:true});
  await f.observe('project',{cwd:'/diagnostics/incident-docs'},'location');
  await f.observe('project-rule',{tool:'write',filePath:join(f.directory,'.agents','rules.md')},'tool',2000);
  assert.equal((await f.store.read(f.key)).workScope.path,f.directory);
});

test('a task command run in a plain OS scratch directory is not adopted as the task project',async t=>{
  const f=await fixture(t);
  const scratch=join(f.root,'fs-track.XYZ');await mkdir(scratch,{recursive:true});
  await f.observe('scratch-command',{tool:'functions.shell',workdir:scratch,command:'gh pr edit 6159 --body-file body.md'});
  const record=await f.store.read(f.key);
  assert.notEqual(record.workScope?.path,scratch);
  assert.equal(record.workScope?.path,f.directory);
});

test('refresh repairs a stored scratch-directory scope from an earlier task command',async t=>{
  const f=await fixture(t);
  const scratch=join(f.root,'fs-track.OLD');await mkdir(scratch,{recursive:true});
  await f.store.write({...f.record,workScope:{version:1,host:'local',path:scratch,source:'successful-task-command',eventId:'old',eventAt:900}},null);
  await f.observe('refresh-scratch',{},'title',3000);
  assert.equal((await f.store.read(f.key)).workScope.path,f.directory);
});

test('a package.json in an OS scratch directory is not adopted as the task project',async t=>{
  const f=await fixture(t);
  const scratch=join(f.root,'fs-track.ABC');await mkdir(scratch,{recursive:true});await writeFile(join(scratch,'package.json'),'{}');
  await f.observe('scratch-write',{tool:'functions.write',filePath:join(scratch,'checklist.md')});
  const record=await f.store.read(f.key);
  assert.notEqual(record.workScope?.path,scratch);
});
