import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { v2Fixture } from './helpers/v2-fixtures.mjs';
import { indexSections, registerArtifact } from '../integrations/session-metadata/src/plans/artifacts.mjs';
import { createPlanRuntime } from '../integrations/session-metadata/src/plans/runtime.mjs';

const api=await import('../integrations/session-metadata/src/plans/tasks.mjs').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const hash=text=>createHash('sha256').update(text).digest('hex');
function outline(text){assert.equal(typeof api.indexPlanTasks,'function');return api.indexPlanTasks(text,indexSections(text,hash(text)));}
const plan='# Build\n## Phase 1: Prepare\n### Task 1: Schema\n- [x] Design tables\n- [ ] Add indexes\n## Phase 2: Ship\n- [!] Run deployment\n';

test('Tasks nests task headings and their checklists under the containing phase',()=>{
  const result=outline(plan);
  assert.deepEqual(result.phases.map(phase=>[phase.title,phase.status,phase.completed,phase.total]),[
    ['Phase 1: Prepare','in_progress',0,1],['Phase 2: Ship','blocked',0,1]]);
  assert.equal(result.phases[0].tasks[0].title,'Task 1: Schema');
  assert.deepEqual(result.phases[0].tasks[0].children.map(task=>[task.title,task.status]),[['Design tables','completed'],['Add indexes','pending']]);
  assert.deepEqual(result.tasks,[]);
});

test('phase-free checklists stay flat with nested subtasks and explicit active status',()=>{
  const result=outline('# Plan\r\n- [x] Read\r\n- [-] Build\r\n  - [x] API\r\n  - [ ] UI\r\n');
  assert.equal(result.phases.length,0);
  assert.deepEqual(result.tasks.map(task=>[task.title,task.status]),[['Read','completed'],['Build','in_progress']]);
  assert.equal(result.tasks[1].children.length,2);
});

test('empty phases and examples never produce fabricated completed work',()=>{
  const result=outline('# Plan\n```md\n## Phase 0: Fake\n- [x] Fake task\n```\n<div>\n- [x] HTML example\n</div>\n\n## Phase 1: Empty\nSome prose.\n');
  assert.equal(result.phases.length,1);assert.equal(result.phases[0].status,'unknown');assert.equal(result.phases[0].total,0);
  assert.deepEqual(outline('No tasks yet.'),{phases:[],tasks:[]});
});

test('duplicate phase headings and Unicode tasks retain distinct deterministic identities',()=>{
  const text='# Plan\n## Phase 1: 工作\n- [ ] Ship 🚀\n## Phase 1: 工作\n- [ ] Ship 🚀\n';
  const a=outline(text),b=outline(text);
  assert.notEqual(a.phases[0].id,a.phases[1].id);assert.notEqual(a.phases[0].tasks[0].id,a.phases[1].tasks[0].id);
  assert.deepEqual(a,b);
});

async function fixture(t,text=plan){
  const f=await v2Fixture();t.after(f.cleanup);
  f.lifecycle={verify:async()=>true};f.proof=f.proof;const path=join(f.root,'plan.md');await writeFile(path,text);
  const artifact=await registerArtifact({session:f.session,proof:f.proof,path,kind:'implementation'},f);
  return {...f,text,artifact};
}
const task=(id,title,status,headingPath)=>({id,title,status,...(headingPath?{headingPath}:{})});
const snapshot=(f,tasks,extra={})=>({session:f.session,proof:f.proof,eventId:'event-1',observedAt:1000,tasks,plan:{path:f.artifact.path,documentHash:f.artifact.hash},...extra});
function read(f,artifact=f.artifact,text=f.text){return api.readPlanTasks(artifact,text,indexSections(text,artifact.hash),f);}

test('only exact-revision uniquely matched agent tasks overlay Markdown status',async t=>{
  const f=await fixture(t);assert.equal(typeof api.recordTaskSnapshot,'function');
  await api.recordTaskSnapshot(snapshot(f,[task('a','Task 1: Schema','completed'),task('b','Unrelated work','in_progress')]),f);
  const result=read(f);
  assert.equal(result.phases[0].tasks[0].status,'completed');assert.equal(result.phases[0].tasks[0].source,'agent');
  assert.equal(result.phases[0].completed,1);assert.equal(result.unassigned[0].title,'Unrelated work');assert.equal(result.observedAt,1000);
  const changed={...f.artifact,hash:'b'.repeat(64)};
  const stale=read(f,changed);assert.equal(stale.phases[0].tasks[0].status,'in_progress');assert.equal(stale.stale,true);
  assert.equal(stale.unassigned.length,2);
});

test('unlinked and ambiguous native tasks are Unassigned instead of guessed into phases',async t=>{
  const f=await fixture(t,'# Plan\n## Phase 1: A\n- [ ] Repeat\n## Phase 2: B\n- [ ] Repeat\n');
  assert.equal(typeof api.recordTaskSnapshot,'function');
  await api.recordTaskSnapshot(snapshot(f,[task('a','Repeat','completed')]),f);
  assert.equal(read(f).unassigned.length,1);assert.equal(read(f).phases[0].tasks[0].status,'pending');
  await api.recordTaskSnapshot(snapshot(f,[task('a','Repeat','completed')],{eventId:'event-2',observedAt:1001,plan:null}),{...f,clock:()=>1001});
  assert.equal(read(f).unassigned.length,1);assert.equal(read(f).phases[1].tasks[0].status,'pending');
});

test('task snapshots reject foreign owners, malformed tasks, duplicate IDs, stale and replayed events',async t=>{
  const f=await fixture(t);assert.equal(typeof api.recordTaskSnapshot,'function');
  const initial=snapshot(f,[task('a','Task 1: Schema','blocked')]);
  await assert.rejects(()=>api.recordTaskSnapshot({...initial,session:{...f.session,id:'ses_foreign'}},f),/owner/);
  await assert.rejects(()=>api.recordTaskSnapshot({...initial,tasks:[{id:'a',title:'Bad',status:'made-up'}]},f),/invalid-task/);
  await assert.rejects(()=>api.recordTaskSnapshot({...initial,tasks:[task('a','A','pending'),task('a','B','pending')]},f),/invalid-task/);
  await api.recordTaskSnapshot(initial,f);
  await api.recordTaskSnapshot({...initial,eventId:'older',observedAt:999,tasks:[]},f);
  await api.recordTaskSnapshot({...initial,observedAt:1002,tasks:[]},{...f,clock:()=>1002});
  assert.equal(read(f).phases[0].tasks[0].status,'blocked');
  await api.recordTaskSnapshot({...initial,eventId:'clear',observedAt:1003,tasks:[]},{...f,clock:()=>1003});
  assert.equal(read(f).phases[0].tasks[0].status,'in_progress');assert.equal(read(f).unassigned.length,0);
});

test('task evidence accepts only successful structured task tools and retains no raw payload',()=>{
  assert.equal(typeof api.extractTaskSnapshot,'function');
  const event={eventId:'tool-1',tool:'TodoWrite',at:1000,input:{todos:[{id:'a',content:'Build API',status:'in_progress',secret:'discard me'}],private:'discard me'}};
  assert.deepEqual(api.extractTaskSnapshot(event),{eventId:'tool-1',observedAt:1000,tasks:[{id:'a',title:'Build API',status:'in_progress'}],plan:null});
  assert.equal(api.extractTaskSnapshot({...event,failed:true}),null);assert.equal(api.extractTaskSnapshot({...event,tool:'read'}),null);
  assert.equal(api.extractTaskSnapshot({...event,input:{todos:[null]}}),null);
});

test('helper read includes phase-aware tasks and update-tasks uses the owned private bridge',async t=>{
  const f=await fixture(t),runtime=createPlanRuntime({HOME:f.root,HERDR_APP_HOME:join(f.root,'app')},{db:f.db,clock:f.clock});
  runtime.lifecycle.verify=async()=>true;
  const updated=await runtime.bridge.handle({op:'update-tasks',payload:snapshot(f,[task('a','Task 1: Schema','completed')])});
  assert.equal(updated.ok,true);
  const result=await runtime.bridge.handle({op:'read',payload:{session:f.session,proof:f.proof,id:f.artifact.id}});
  assert.equal(result.ok,true);assert.equal(result.value.tasks.phases[0].tasks[0].status,'completed');
  assert.deepEqual(result.value.artifact,f.artifact);
});

test('unlinked evidence never erases an explicit Markdown parent or phase status',async t=>{
  const f=await fixture(t,'# Plan\n## Phase 1: Release [blocked]\n### Task 1: Deploy\nStatus: blocked\n- [x] Build\n');
  await api.recordTaskSnapshot(snapshot(f,[task('other','Other work','completed')],{plan:null}),f);
  const result=read(f);assert.equal(result.phases[0].status,'blocked');assert.equal(result.phases[0].tasks[0].status,'blocked');
});

test('list-indented fenced examples cannot complete their containing task or create phases',()=>{
  const result=outline('# Plan\n- [ ] Real task\n    ```md\n    - [x] Example only\n  ## Phase 9: Example\n    ```\n');
  assert.equal(result.tasks[0].status,'pending');assert.equal(result.tasks[0].children.length,0);assert.equal(result.phases.length,0);
});

test('HTML figure examples cannot create tasks or phase headings',()=>{
  const result=outline('# Plan\n<figure>\n## Phase 9: Example\n- [x] HTML example\n</figure>\n\n- [ ] Actual task\n');
  assert.equal(result.phases.length,0);assert.deepEqual(result.tasks.map(task=>[task.title,task.status]),[['Actual task','pending']]);
});
