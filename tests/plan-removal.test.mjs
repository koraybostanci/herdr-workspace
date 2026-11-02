import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installHome,NODE } from './helpers/install-home.mjs';
import { planInstall } from '../src/install-plan.mjs';
import { applyInstall,uninstall } from '../src/install-journal.mjs';
import { ABSENT,hashOf } from '../src/install-common.mjs';
import { runCli } from '../src/cli.mjs';

const planOf=h=>planInstall({bundle:h.bundle,sourceRoot:h.sourceRoot,appHome:h.appHome,stateRoot:h.stateRoot,node:NODE,
  harnesses:{opencodePath:h.opencodePath,claudePath:h.claudePath},configureHarnesses:['opencode','claude']});

test('fresh installations expose only the metadata helper and do not create a Plan store',async t=>{
  const h=await installHome(t),plan=await planOf(h);
  const receipt=await applyInstall(plan,{run:h.run});
  const descriptor=JSON.parse(await h.read(join(h.appHome,'data/space-agents/runtime.json'))??'null');
  assert.equal(descriptor?.helperPath,join(plan.roots.releaseDir,'bin/herdr-session-meta.mjs'));
  assert.equal(await h.read(join(h.appHome,'data/session-plans/runtime.json')),null);
  assert.equal(await h.read(join(h.appHome,'mods/plan/main.js')),null);
  assert.equal(await h.read(join(h.stateRoot,'v2/state.sqlite')),null);
  const plugin=JSON.parse(await h.read(h.opencodePath)).plugins[0];
  assert.deepEqual(plugin,{package:plan.roots.releaseDir,options:{appHome:h.appHome,stateRoot:h.stateRoot}});
  const hooks=JSON.parse(await h.read(h.claudePath)).hooks;
  for(const groups of Object.values(hooks))assert.deepEqual(groups[0].hooks[0].args,[join(plan.roots.releaseDir,'bin/herdr-session-meta.mjs'),'hook','claude']);
  await uninstall(receipt);
});

async function legacyInstall(t){
  const h=await installHome(t),receipt=await applyInstall(await planOf(h),{run:h.run});
  const obsolete=['mods/plan/main.js','mods/session-tabs/plan-controller.js','data/session-plans/runtime.json'];
  for(const path of obsolete){
    const dest=join(h.appHome,path),text='legacy '+path+'\n';await h.write(dest,text);
    receipt.steps=receipt.steps.filter(step=>step.dest!==dest);
    receipt.steps.push({kind:'file',dest,hash:hashOf(text),beforeHash:ABSENT,mode:0o600,backup:null,applied:true});
  }
  for(const step of receipt.steps.filter(step=>step.kind==='config')){
    step.value=structuredClone(step.value);
    if(step.harness==='opencode')step.value.options={planNode:NODE,planAppHome:h.appHome,planStateRoot:h.stateRoot};
    else step.value.hooks[0].args.push('--plans');
    const config=JSON.parse(await h.read(step.path));
    const parent=step.at.slice(0,-1).reduce((value,key)=>value[key],config);
    parent[step.at.at(-1)]=[step.value];
    const text=JSON.stringify(config);await h.write(step.path,text);
    receipt.configFiles[step.path].afterHash=hashOf(text);
  }
  receipt.id='legacy-plan-install';
  await h.write(receipt.roots.journalPath,JSON.stringify(receipt));
  await h.write(join(h.stateRoot,'v2/state.sqlite'),'saved reviews');
  return {...h,obsolete};
}

test('upgrades retire unchanged owned Plan files while retaining saved reviews',async t=>{
  const h=await legacyInstall(t),plan=await planOf(h);
  assert.deepEqual(plan.blockers,[]);
  await applyInstall(plan,{run:h.run});
  for(const path of h.obsolete)assert.equal(await h.read(join(h.appHome,path)),null,path);
  assert.equal(await h.read(join(h.stateRoot,'v2/state.sqlite')),'saved reviews');
  assert.deepEqual(JSON.parse(await h.read(h.opencodePath)).plugins[0].options,{appHome:h.appHome,stateRoot:h.stateRoot});
  for(const groups of Object.values(JSON.parse(await h.read(h.claudePath)).hooks))assert.equal(groups[0].hooks[0].args.includes('--plans'),false);
  assert.ok((await planOf(h)).files.every(file=>file.action==='unchanged'));
});

test('retiring Plan requires explicit opt-in to upgrade previously configured harnesses',async t=>{
  const h=await legacyInstall(t);
  const plan=await planInstall({bundle:h.bundle,sourceRoot:h.sourceRoot,appHome:h.appHome,stateRoot:h.stateRoot,node:NODE});
  assert.deepEqual([...new Set(plan.blockers.filter(b=>b.rule==='plan-removal-needs-harness-upgrade').map(b=>b.harness))].sort(),['claude','opencode']);
  assert.deepEqual(plan.configEdits,[]);
  await assert.rejects(applyInstall(plan,{run:h.run}),/install-blocked/);
});

test('already missing Plan files are retired without leaving failed doctor checks',async t=>{
  const h=await legacyInstall(t);
  const {unlink}=await import('node:fs/promises');
  await unlink(join(h.appHome,'mods/plan/main.js'));
  await applyInstall(await planOf(h),{run:h.run});
  const out=[];
  assert.equal(await runCli(['doctor','--app-home',h.appHome,'--state-root',h.stateRoot],{run:h.run,node:NODE,platform:'darwin',env:{HOME:h.home},
    stdout:s=>out.push(s),stderr:()=>{},sourceRoot:h.sourceRoot}),0,out.join(''));
});

test('retirement keeps user-modified Plan files rather than deleting their changes',async t=>{
  const h=await legacyInstall(t),file=join(h.appHome,'mods/plan/main.js');
  await h.write(file,'user edits');
  const plan=await planOf(h);await applyInstall(plan,{run:h.run});
  assert.equal(await h.read(file),'user edits');
  assert.ok(plan.warnings.some(w=>w.path===file));
  const out=[];
  assert.equal(await runCli(['doctor','--app-home',h.appHome,'--state-root',h.stateRoot],{run:h.run,node:NODE,platform:'darwin',env:{HOME:h.home},
    stdout:s=>out.push(s),stderr:()=>{},sourceRoot:h.sourceRoot}),0,out.join(''));
});

test('a changed retirement target stops an upgrade without deleting the concurrent edit',async t=>{
  const h=await legacyInstall(t),plan=await planOf(h),file=join(h.appHome,'mods/plan/main.js');
  await h.write(file,'concurrent edit');
  await assert.rejects(applyInstall(plan,{run:h.run}),/changed-concurrently/);
  assert.equal(await h.read(file),'concurrent edit');
});

test('uninstall after a failed upgrade retires old Plan files and restores adopted originals',async t=>{
  const h=await legacyInstall(t),journal=JSON.parse(await h.read(join(h.appHome,'data/herdr-workspace/install-journal.json')));
  const adopted=join(h.appHome,'mods/plan/main.js'),backup=join(h.home,'original-plan.bak');
  await h.write(backup,'original user mod');
  journal.steps.find(step=>step.dest===adopted).backup={path:backup,hash:hashOf('original user mod')};
  await h.write(journal.roots.journalPath,JSON.stringify(journal));
  await rm(join(journal.roots.releaseDir,'node_modules'),{recursive:true});
  h.run.failNpm=true;
  await assert.rejects(applyInstall(await planOf(h),{run:h.run}),/dependency-install-failed/);
  await uninstall(JSON.parse(await h.read(journal.roots.journalPath)));
  assert.equal(await h.read(adopted),'original user mod');
  for(const path of h.obsolete.filter(path=>path!=='mods/plan/main.js'))assert.equal(await h.read(join(h.appHome,path)),null,path);
  assert.equal(await h.read(join(h.stateRoot,'v2/state.sqlite')),'saved reviews');
});

test('edited Plan-enabled hooks block retirement rather than leaving an old observer configured',async t=>{
  const h=await legacyInstall(t),doc=JSON.parse(await h.read(h.claudePath));
  doc.hooks.Stop[0].hooks[0].timeout=20;
  const text=JSON.stringify(doc);await h.write(h.claudePath,text);
  const plan=await planOf(h);
  assert.ok(plan.blockers.some(b=>b.rule==='modified-plan-harness-entry'&&b.path===h.claudePath));
  await assert.rejects(applyInstall(plan,{run:h.run}),/install-blocked/);
  assert.equal(await h.read(h.claudePath),text);
});

test('configuring a different harness file does not bypass retirement of the original entry',async t=>{
  const h=await legacyInstall(t);
  const plan=await planInstall({bundle:h.bundle,sourceRoot:h.sourceRoot,appHome:h.appHome,stateRoot:h.stateRoot,node:NODE,
    harnesses:{opencodePath:join(h.home,'other-cli.json'),claudePath:h.claudePath},configureHarnesses:['opencode','claude']});
  assert.ok(plan.blockers.some(b=>b.rule==='plan-removal-needs-harness-upgrade'&&b.path===h.opencodePath));
  await assert.rejects(applyInstall(plan,{run:h.run}),/install-blocked/);
});
