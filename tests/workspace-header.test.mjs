import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadHerdrMod } from './helpers/load-herdr-mod.mjs';
import { state,context,render,text,find } from './helpers/herdr-runtime.mjs';

async function header(window={},width=320){
  const module=await loadHerdrMod('mods/workspace-header');
  state.window=window;state.layout={id:'sidebar',size:{px:width}};
  state.shared={};state.commands=[];
  return new module.default();
}

test('the shipped layout uses the owned header without replacing the native footer',async()=>{
  const layout=JSON.parse(await readFile(new URL('../layouts/herdr-workspace.json',import.meta.url),'utf8'));
  const sidebar=layout.children.find(node=>node.id==='sidebar');
  assert.equal(sidebar.children.find(node=>node.id==='brand').content.mod,'workspace-header');
  assert.equal(sidebar.children.find(node=>node.id==='sidebar-footer').content.mod,'workspace-chrome');
});

test('fullscreen header left aligns the brand without reserving hidden traffic lights',async()=>{
  const tree=render(await header({fullscreen:true}));
  assert.deepEqual(tree.attributes.pl,[14]);
  assert.ok(text(tree).includes('Herdr'));
  assert.ok(find(tree,'search'));assert.ok(find(tree,'sidebar-toggle'));
});

test('windowed macOS header leaves the native window buttons clear',async()=>{
  assert.deepEqual(render(await header()).attributes.pl,[76]);
});

test('system titlebar and non-macOS headers need no traffic-light inset',async()=>{
  for(const window of [{titlebar:'system'},{platform:'linux'}])
    assert.deepEqual(render(await header(window)).attributes.pl,[14]);
});

test('header search opens the native picker without starting a window drag',async()=>{
  const search=find(render(await header({fullscreen:true})),'search');
  let stopped=false;
  search.attributes.on_mouse_down[1]({}, {...context(),stop_propagation(){stopped=true;}});
  search.attributes.on_click[0]();
  assert.equal(stopped,true);
  assert.deepEqual(state.commands,[{name:'mod.open',args:{name:'picker'}}]);
});

test('header sidebar toggle remembers expanded width and restores it',async()=>{
  const view=await header({fullscreen:true},360);
  find(render(view),'sidebar-toggle').attributes.on_click[0]();
  assert.equal(state.shared['sidebar.width'],360);
  assert.deepEqual(state.commands,[{name:'layout.resize',args:{id:'sidebar',px:76}}]);
  state.layout.size.px=76;state.window.platform='linux';
  find(render(view),'sidebar-toggle').attributes.on_click[0]();
  assert.deepEqual(state.commands[1],{name:'layout.resize',args:{id:'sidebar',px:360}});
});

test('collapsed macOS header keeps the rail clear of brand and controls',async()=>{
  const tree=render(await header({},76));
  assert.equal(text(tree).includes('Herdr'),false);
  assert.equal(find(tree,'search'),undefined);
  assert.equal(find(tree,'sidebar-toggle'),undefined);
});
