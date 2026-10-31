import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHerdrMod } from './helpers/load-herdr-mod.mjs';
import { state,context,render,text,find } from './helpers/herdr-runtime.mjs';
import { agentCards } from '../mods/space-agents/model.js';

const model=await import('../mods/compact-spaces/model.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const local={id:'sp-local',machine:null,name:'Project',folder:'/task',active:true,status:'blocked',tabs:[{id:'tab-local'}]};
const remote={id:'devbox/sp-remote',machine:'devbox',name:'Project',folder:'/task',active:false,status:'idle',tabs:[{id:'devbox/tab-remote'}]};
const machine={name:'devbox',layout:'ready',state:'connected'};
const live={spaces:[local,remote],machines:[machine],ordered:[{w:local,tree:null},{w:remote,tree:null}],selectedId:local.id};
function rows(data=live){assert.equal(typeof model.spaceMenuRows,'function');return model.spaceMenuRows(data);}

test('space_identity_uses_machine_qualified_id despite identical labels',()=>{
  const options=rows().filter(row=>row.kind==='space');
  assert.deepEqual(options.map(row=>row.id),['sp-local','devbox/sp-remote']);assert.notEqual(options[0].key,options[1].key);
  assert.deepEqual(model.resolveSpaceAction(options[1].key,live),{command:'space.select',args:{id:remote.id}});
});
test('removed_space_never_selects_reused_index',()=>{
  const key=rows().find(row=>row.id===local.id).key;
  assert.equal(model.resolveSpaceAction(key,{...live,spaces:[{...local,id:'replacement'},remote]}),null);
});
test('unavailable_machine_action_fails_without_local_fallback',()=>{
  const options=rows(),offline={...live,machines:[{...machine,layout:'unavailable',state:'disconnected'}]};
  for(const row of options.filter(row=>row.machine==='devbox'&&['space','create'].includes(row.kind)))assert.equal(model.resolveSpaceAction(row.key,offline),null);
  assert.ok(rows(offline).some(row=>row.machine==='devbox'&&row.kind==='unavailable'));
});
test('empty_spaces_offer_create_without_selecting_other',()=>{
  const empty=rows({spaces:[],machines:[],ordered:[],selectedId:null});
  assert.equal(empty.some(row=>row.kind==='space'),false);
  assert.deepEqual(model.resolveSpaceAction(empty.find(row=>row.kind==='create').key,{spaces:[],machines:[]}),{command:'space.new',args:{}});
});
test('per-machine create actions retain their exact ready machine',()=>{
  const create=rows().filter(row=>row.kind==='create');
  assert.deepEqual(create.map(row=>model.resolveSpaceAction(row.key,live)),[{command:'space.new',args:{}},{command:'space.new',args:{machine:'devbox'}}]);
});
test('menu preserves ordered worktree nesting and selected identity',()=>{
  const tree={...local,id:'tree',name:'Feature',active:false},ordered=[{w:local,tree:null},{w:tree,tree:'└─'},{w:remote,tree:null}];
  const options=rows({...live,spaces:[local,tree,remote],ordered}).filter(row=>row.kind==='space');
  assert.deepEqual(options.map(row=>row.id),['sp-local','tree','devbox/sp-remote']);assert.equal(options[1].tree,'└─');assert.equal(options[0].selected,true);
});
test('compact layout changes only the Spaces mod and its fixed height/minimum',()=>{
  assert.equal(typeof model.compactSpacesLayout,'function');
  const before={id:'root',children:[{id:'spaces',content:{mod:'spaces'},size:{px:180},min:90},{id:'agents',size:{weight:1},min:90},
    {id:'panel-body',active:'plan',children:[{id:'plan',content:{mod:'plan'}},{id:'files',content:{mod:'files'}}]}]};
  const after=model.compactSpacesLayout(before);
  assert.deepEqual(after,{...before,children:[{...before.children[0],content:{mod:'compact-spaces'},size:{px:44},min:44},...before.children.slice(1)]});
  assert.equal(before.children[0].size.px,180);
});

async function widget(){
  const module=await loadHerdrMod('mods/compact-spaces');
  state.data={allSpaces:[structuredClone(local),structuredClone(remote)],allMachines:[machine],allPanes:[],allAgents:[],allTerminals:[],selectedSpace:local.id};
  state.tasks=[];state.timers=[];state.shared={'space.colors':{[local.id]:'ansi3'}};state.commands=[];
  state.layout={id:'sidebar',size:{px:320}};state.focusedHandle=null;
  const view=new module.default();view.init({},context());return view;
}
test('collapsed_selector_keeps_accessible_current_name and uses a native focused trigger',async()=>{
  const view=await widget();state.layout.size.px=44;
  const trigger=find(render(view),'space-selector-trigger');assert.ok(trigger);
  assert.ok(trigger.attributes.accessibility_label[0].includes('Project'));assert.equal(trigger.attributes.track_focus[0],view.triggerFocus);
  assert.ok(trigger.attributes.focus);assert.deepEqual(state.commands,[]);
});

test('space popup anchors its top-left corner so it expands downward from the trigger',async()=>{
  const view=await widget();
  assert.deepEqual(find(render(view),'space-selector').attributes.anchor,['top_left']);
});
test('dropdown keyboard highlight survives insertion and activates only its stable space ID',async()=>{
  const view=await widget();view.open=true;view.menuFocus.focus();
  let tree=render(view),menu=find(tree,'space-selector-menu');assert.ok(menu);assert.equal(menu.attributes.track_focus[0],view.menuFocus);
  menu.attributes.on_key_down[0]({key:'down'},context());
  const key=view.highlightedKey;
  state.data.allSpaces.unshift({...local,id:'new',name:'Inserted',active:false});
  render(view);assert.equal(view.highlightedKey,key);
  const expected=model.resolveSpaceAction(key,{spaces:state.data.allSpaces,machines:state.data.allMachines});
  menu=find(render(view),'space-selector-menu');menu.attributes.on_key_down[0]({key:'enter'},context());
  assert.deepEqual(state.commands,[{name:expected.command,args:expected.args}]);assert.equal(view.open,false);assert.equal(state.focusedHandle,view.triggerFocus.id);
});
test('stale option click and stale remote create refuse removed/unavailable live targets',async()=>{
  const view=await widget();view.open=true;const tree=render(view);
  const option=find(tree,'space-option-'+remote.id);assert.ok(option);
  state.data.allMachines=[{...machine,layout:'unavailable'}];option.attributes.on_click[0]({},context());assert.deepEqual(state.commands,[]);
  state.data.allSpaces=[];find(tree,'space-option-'+local.id).attributes.on_click[0]({},context());assert.deepEqual(state.commands,[]);
});
test('opening/cancelling selector does not change real space selection or selected-space agent filtering',async()=>{
  const view=await widget();state.data.allAgents=[{address:'a',space:local.id,tab:'tab-local',title:'Local task'},{address:'b',space:remote.id,tab:'devbox/tab-remote',title:'Remote task'}];
  const before=agentCards(state.data).map(card=>card.address);
  const popover=find(render(view),'space-selector');assert.ok(popover);
  popover.attributes.on_open_change[0](true,context());view.menuFocus.focus();
  const menu=find(render(view),'space-selector-menu');menu.attributes.on_key_down[0]({key:'escape'},context());
  assert.deepEqual(agentCards(state.data).map(card=>card.address),before);assert.deepEqual(before,['a']);assert.deepEqual(state.commands,[]);
});
test('compact trigger preserves avatar color and attention, and create targets current space machine',async()=>{
  const view=await widget(),tree=render(view),trigger=find(tree,'space-selector-trigger');
  assert.ok(text(trigger).includes('Project'));assert.ok(find(trigger,'space-current-attention'));
  state.data.selectedSpace=remote.id;find(render(view),'space-new').attributes.on_click[0]({},context());
  assert.deepEqual(state.commands,[{name:'space.new',args:{machine:'devbox'}}]);
});

test('removing the highlighted space does not silently activate the replacement on Enter',async()=>{
  const view=await widget();view.open=true;view.menuFocus.focus();render(view);
  state.data.allSpaces=[{...local,id:'replacement',active:true},remote];
  const menu=find(render(view),'space-selector-menu');menu.attributes.on_key_down[0]({key:'enter'},context());
  assert.deepEqual(state.commands,[]);
});

test('stale current-space create never falls back locally after a selected remote space disappears',async()=>{
  const view=await widget();state.data.selectedSpace=remote.id;
  const create=find(render(view),'space-new').attributes.on_click[0];
  state.data.allSpaces=[local];create({},context());assert.deepEqual(state.commands,[]);
});
