import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHerdrMod,modStorage } from './helpers/load-herdr-mod.mjs';
import { state,context,render,find } from './helpers/herdr-runtime.mjs';

async function tabs({active='files',saved={one:'files'},legacy=null}={}){
  const module=await loadHerdrMod('mods/session-tabs');
  const storage=modStorage('mods/session-tabs');storage.clear();
  if(saved!==null)storage.setItem('panels',JSON.stringify(saved));
  state.data={allSpaces:[{id:'one',active:true,tabs:[{id:'tb1',name:'Session',active:true}]}],allPanes:[],allAgents:[],allTerminals:[]};
  state.layout={id:'root',children:[{id:'panel',hidden:false,children:[{id:'panel-body',active}]}]};
  state.commands=[];state.tasks=[];state.timers=[];
  state.shared={'session-plans.draft-errors':[{instanceId:'old',rowKey:'old',seenAt:Date.now()}]};
  state.files=legacy?{'/fixture/herdr/data/tabs/store.json':JSON.stringify({panels:JSON.stringify(legacy)})}:{};
  const view=new module.default();view.init({},context());return {view,storage};
}

test('tabs start no Plan polling or background session selection',async()=>{
  const {view}=await tabs();render(view);
  assert.deepEqual(state.timers,[]);
  assert.deepEqual(state.tasks,[]);
  assert.equal(state.shared['session-plans.selection'],undefined);
});

test('stale Plan recovery state cannot expose review controls',async()=>{
  const {view}=await tabs(),tree=render(view);
  assert.equal(find(tree,'panel-plan'),undefined);
  assert.equal(find(tree,'plan-draft-recovery'),undefined);
  assert.ok(find(tree,'panel-files'));assert.ok(find(tree,'panel-changes'));
});

test('a saved Plan panel restores the previous Files choice without overwriting it',async()=>{
  const {view,storage}=await tabs({active:'plan'});render(view);
  assert.deepEqual(state.commands,[{name:'layout.select',args:{stack:'panel-body',child:'files'}},{name:'layout.show',args:{id:'panel'}}]);
  assert.deepEqual(JSON.parse(storage.getItem('panels')),{one:'files'});
});

test('Files and Changes remain toggleable and remembered for the current space',async()=>{
  const {view,storage}=await tabs();
  find(render(view),'panel-changes').attributes.on_click[0]();
  assert.deepEqual(state.commands,[{name:'layout.select',args:{stack:'panel-body',child:'changes'}},{name:'layout.show',args:{id:'panel'}}]);
  assert.deepEqual(JSON.parse(storage.getItem('panels')),{one:'changes'});
});

test('legacy Files and Changes preferences migrate without a Plan controller',async()=>{
  const {view,storage}=await tabs({saved:null,legacy:{one:'changes',other:'files',obsolete:'plan'}});
  await Promise.all(state.tasks.splice(0).map(task=>task()));render(view);
  assert.deepEqual(JSON.parse(storage.getItem('panels')),{one:'changes',other:'files'});
  assert.deepEqual(state.timers,[]);
});
