import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { scratch } from './helpers/v2-fixtures.mjs';

const setup=await import('../integrations/session-metadata/src/plans/setup.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const smoke=await import('./smoke/plan-review.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
async function fixture(t) {
  assert.equal(typeof setup.planUiInstall,'function');
  const root=await mkdtemp(join(scratch,'herdr-plan-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const appHome=join(root,'app'),integration=join(appHome,'integrations/session-metadata');
  const options={appHome,stateRoot:join(root,'state'),node:process.execPath,releasePath:join(integration,'releases/11111111-1111-4111-8111-111111111111'),buildHash:'a'.repeat(64),
    layoutPath:join(appHome,'layouts/herdr-workspace.json'),opencodePath:join(root,'cli.json'),claudePath:join(root,'claude.json'),runtimePath:join(appHome,'data/session-plans/runtime.json')};
  const layout={id:'root',children:[{id:'spaces',size:{px:180},content:{mod:'spaces'}},{id:'tabs',content:{mod:'tabs'}},
    {id:'panel-body',type:'stack',active:'files',children:[{id:'files',type:'block',content:{mod:'files'}},{id:'changes',type:'block',content:{mod:'changes'}}]}]};
  const hook={type:'command',command:process.execPath,args:[join(integration,'bin/herdr-session-meta.mjs'),'hook','claude'],timeout:10,onFailure:'continue'};
  const events=['SessionStart','UserPromptSubmit','PostToolUse','CwdChanged','Stop','SessionEnd'];
  const current={layout:JSON.stringify(layout,null,2)+'\n',opencode:'{\n  // keep my settings\n  "theme": {"name":"mine"},\n  "plugins": ["other-plugin", '+JSON.stringify({package:integration,options:{metadataVersion:3}})+']\n}\n',
    claude:JSON.stringify({env:{USER_SETTING:'keep'},hooks:Object.fromEntries(events.map(name=>[name,[{hooks:[{type:'command',command:'unrelated-hook'},hook]}]]))},null,2)+'\n',runtime:null};
  return {root,options,current,layout};
}
async function files(f) {
  for(const [name,path] of [['layout',f.options.layoutPath],['opencode',f.options.opencodePath],['claude',f.options.claudePath]]){
    await mkdir(join(path,'..'),{recursive:true});await writeFile(path,f.current[name]);
  }
}

test('Plan installation preserves unrelated layout, JSONC settings, hooks and metadata options',async t=>{
  const f=await fixture(t),edits=setup.planUiInstall(f.current,f.options);
  const layout=JSON.parse(edits.find(e=>e.path===f.options.layoutPath).afterText);
  assert.deepEqual(layout.children[0],f.layout.children[0]);assert.equal(layout.children[1].content.mod,'session-tabs');
  assert.equal(layout.children[2].active,'files');assert.equal(layout.children[2].children.at(-1).content.mod,'plan');
  const cli=edits.find(e=>e.path===f.options.opencodePath).afterText;
  assert.ok(cli.includes('// keep my settings'));assert.ok(cli.includes('other-plugin'));assert.ok(cli.includes('metadataVersion'));
  const cc=JSON.parse(edits.find(e=>e.path===f.options.claudePath).afterText);
  assert.equal(cc.env.USER_SETTING,'keep');assert.equal(cc.hooks.Stop[0].hooks[0].command,'unrelated-hook');
  assert.equal(cc.hooks.Stop[0].hooks[1].args.at(-1),'--plans');
});

test('owned config rollback preserves later user edits and restores only the integration references',async t=>{
  const f=await fixture(t);await files(f);
  const edits=setup.planUiInstall(f.current,f.options),journal=join(f.root,'install.json');
  await setup.applyPlanUiInstall(edits,{journalPath:journal});
  const cli=(await readFile(f.options.opencodePath,'utf8')).replace('"other-plugin"','"later-user-plugin", "other-plugin"');
  await writeFile(f.options.opencodePath,cli);
  await setup.rollbackPlanUiInstall(journal);
  const after=await readFile(f.options.opencodePath,'utf8');
  assert.ok(after.includes('later-user-plugin'));assert.ok(after.includes('other-plugin'));assert.ok(after.includes('// keep my settings'));
  assert.equal(after.includes('planNode'),false);assert.equal(after.includes('/releases/'),false);
  assert.equal(JSON.parse(await readFile(f.options.layoutPath,'utf8')).children[1].content.mod,'tabs');
});

test('interrupted config application can resume without losing the first edit ownership',async t=>{
  const f=await fixture(t);await files(f);const edits=setup.planUiInstall(f.current,f.options),journal=join(f.root,'install.json');let writes=0;
  await assert.rejects(setup.applyPlanUiInstall(edits,{journalPath:journal,writeText:async(path,text,expected)=>{
    if(++writes===2)throw Error('injected-failure');return setup.atomicConfigText(path,text,expected);
  }}),/injected-failure/);
  await setup.applyPlanUiInstall(edits,{journalPath:journal});await setup.rollbackPlanUiInstall(journal);
  assert.equal(JSON.parse(await readFile(f.options.layoutPath,'utf8')).children[1].content.mod,'tabs');
  assert.equal((await readFile(f.options.opencodePath,'utf8')).includes('/releases/'),false);
});

test('installation refuses changed files and foreign Plan node ownership rather than overwriting them',async t=>{
  const f=await fixture(t);await files(f);const edits=setup.planUiInstall(f.current,f.options);
  await writeFile(f.options.layoutPath,f.current.layout+' ');
  await assert.rejects(setup.applyPlanUiInstall(edits,{journalPath:join(f.root,'install.json')}),/concurrent|changed/);
  const foreign={...f.layout,children:f.layout.children.map(node=>node.id==='panel-body'?{...node,children:[...node.children,{id:'plan',content:{mod:'user-owned-plan'}}]}:node)};
  assert.throws(()=>setup.planUiInstall({...f.current,layout:JSON.stringify(foreign)},f.options),/foreign|owned/);
});

test('release builder copies only code into an immutable private bundle and refuses a reused ID',async t=>{
  assert.equal(typeof setup.createPlanRelease,'function');
  const f=await fixture(t),source=join(f.root,'source');await mkdir(join(source,'src'),{recursive:true});await mkdir(join(source,'node_modules'));
  await writeFile(join(source,'src/runtime.mjs'),'export const value = 1;');await writeFile(join(source,'package.json'),'{"type":"module"}');
  await writeFile(join(source,'node_modules/secret.txt'),'DO NOT COPY DEPENDENCIES');
  const release=await setup.createPlanRelease({sourceIntegration:source,appHome:f.options.appHome,id:'22222222-2222-4222-8222-222222222222'});
  assert.equal((await stat(release.releasePath)).mode&0o777,0o700);
  assert.equal((await stat(join(release.releasePath,'src/runtime.mjs'))).mode&0o777,0o600);
  assert.equal(release.manifest.files['src/runtime.mjs'].length,64);assert.equal(Object.keys(release.manifest.files).some(key=>key.includes('node_modules')),false);
  await assert.rejects(setup.createPlanRelease({sourceIntegration:source,appHome:f.options.appHome,id:'22222222-2222-4222-8222-222222222222'}),/exist|owned/);
});

test('isolated Plan smoke refuses non-owned namespaces and sessions before any mutation',()=>{
  assert.equal(typeof smoke.validateSmoke,'function');
  const session={host:'local',authority:'local',harness:'opencode-v2',id:'ses_owned'};
  assert.throws(()=>smoke.validateSmoke({mode:'isolated',namespace:'default',session,ownedSessions:['ses_owned']}),/namespace/);
  assert.throws(()=>smoke.validateSmoke({mode:'isolated',namespace:'herdr-plan-probe-test',session,ownedSessions:[]}),/owned-session/);
});

test('live Plan smoke refuses delivery flags and wrong exact session proof',()=>{
  assert.equal(typeof smoke.validateSmoke,'function');
  const session={host:'local',authority:'local',harness:'opencode-v2',id:'ses_owned'};
  assert.throws(()=>smoke.validateSmoke({mode:'live-read',session,send:true}),/delivery/);
  assert.throws(()=>smoke.validateSmoke({mode:'live-read',session,proof:{session:{...session,id:'ses_other'}}}),/proof/);
});

test('owned native protocol, client and owner-model copies remain byte identical',async()=>{
  for(const [a,b] of [['integrations/session-metadata/src/protocol.mjs','mods/plan/protocol.js'],['mods/plan/protocol.js','mods/session-tabs/protocol.js'],
    ['mods/plan/client.js','mods/session-tabs/client.js'],['mods/plan/model.js','mods/session-tabs/plan-model.js']])assert.equal(await readFile(a,'utf8'),await readFile(b,'utf8'));
});
