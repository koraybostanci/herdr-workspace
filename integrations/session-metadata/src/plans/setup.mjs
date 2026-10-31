import { readFile, writeFile, mkdir, rename, unlink, lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { OWNER } from '../protocol.mjs';

export const configHash=text=>createHash('sha256').update(text===null?'\0':text).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function read(path){try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function doc(text){const errors=[],value=parse(text??'{}',errors,{allowTrailingComma:true});if(errors.length||!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid-config');return value;}
function change(text,path,value){return applyEdits(text??'{}\n',modify(text??'{}\n',path,value,{formattingOptions:{insertSpaces:true,tabSize:2,eol:text?.includes('\r\n')?'\r\n':'\n'}}));}
function find(node,id,path=[]){if(node?.id===id)return {node,path};for(const [index,child] of (node?.children??[]).entries()){const result=find(child,id,[...path,'children',index]);if(result)return result;}return null;}
function hooks(value,event,script){const result=[];for(const [g,group] of (value.hooks?.[event]??[]).entries())for(const [h,hook] of (group.hooks??[]).entries())if(Array.isArray(hook.args)&&hook.args.includes(script))result.push({hook,path:['hooks',event,g,'hooks',h]});return result;}
function applyActions(text,actions,reverse=false) {
  for(const action of reverse?[...actions].reverse():actions) {
    let value=doc(text);
    if(action.type==='layout-tabs') {
      const found=find(value,'tabs'),before=reverse?action.after:action.before;
      if(found?.node.content?.mod===before)text=change(text,[...found.path,'content','mod'],reverse?action.before:action.after);
    } else if(action.type==='layout-plan') {
      const found=find(value,'panel-body');if(!found)throw Error('layout-shape-changed');
      const index=(found.node.children??[]).findIndex(node=>node.id==='plan');
      if(!reverse&&index<0)text=change(text,[...found.path,'children',found.node.children.length],action.after);
      if(reverse&&index>=0&&equal(found.node.children[index],action.after))text=change(text,[...found.path,'children',index],undefined);
    } else if(action.type==='plugin') {
      const target=reverse?action.afterPackage:action.beforePackage;
      const index=(value.plugins??[]).findIndex(entry=>(typeof entry==='string'?entry:entry?.package)===target);
      if(index<0)continue;
      const entry=value.plugins[index];
      if(!reverse&&typeof entry==='string')text=change(text,['plugins',index],{package:action.afterPackage,options:{}});
      else text=change(text,['plugins',index,'package'],reverse?action.beforePackage:action.afterPackage);
      for(const field of action.options) {
        value=doc(text);const current=value.plugins[index]?.options??{};
        if(!reverse||equal(current[field.key],field.after))text=change(text,['plugins',index,'options',field.key],reverse?(field.beforeExists?field.before:undefined):field.after);
      }
      value=doc(text);
      if(reverse&&!action.beforeOptions&&Object.keys(value.plugins[index]?.options??{}).length===0)text=change(text,['plugins',index,'options'],undefined);
      value=doc(text);
      if(reverse&&action.originalString&&Object.keys(value.plugins[index]).every(key=>key==='package'))text=change(text,['plugins',index],action.beforePackage);
    } else if(action.type==='hook') {
      const script=reverse?action.afterHelper:action.beforeHelper;
      for(const found of hooks(value,action.event,script)) {
        const index=found.hook.args.indexOf(script);
        text=change(text,[...found.path,'args',index],reverse?action.beforeHelper:action.afterHelper);
        const command=reverse?action.afterCommand:action.beforeCommand;
        if(found.hook.command===command)text=change(text,[...found.path,'command'],reverse?action.beforeCommand:action.afterCommand);
        const fresh=doc(text),args=found.path.reduce((v,key)=>v?.[key],fresh).args;
        if(action.addedPlans&&!reverse&&!args.includes('--plans'))text=change(text,[...found.path,'args',args.length],'--plans');
        if(action.addedPlans&&reverse&&args.includes('--plans'))text=change(text,[...found.path,'args',args.indexOf('--plans')],undefined);
      }
    } else if(action.type==='runtime') {
      for(const field of action.fields) {
        value=doc(text);
        if(!reverse||equal(value[field.key],field.after))text=change(text,[field.key],reverse?(field.beforeExists?field.before:undefined):field.after);
      }
      if(reverse&&action.created&&Object.keys(doc(text)).length===0)text=null;
    }
  }
  return text;
}
export function planUiInstall(current,options) {
  const edits=[],integration=join(options.appHome,'integrations/session-metadata'),beforePackage=options.previousRelease??integration;
  const push=(path,text,actions)=>{const afterText=applyActions(text,actions);if(afterText!==text)edits.push({path,beforeHash:configHash(text),afterHash:configHash(afterText),afterText,ownedValues:actions});};
  const layout=doc(current.layout),tabs=find(layout,'tabs'),body=find(layout,'panel-body');
  if(!tabs||!body||!Array.isArray(body.node.children)||!['tabs','session-tabs'].includes(tabs.node.content?.mod))throw Error('foreign-layout-owned-node');
  const existing=body.node.children.find(node=>node.id==='plan');if(existing&&existing.content?.mod!=='plan')throw Error('foreign-plan-node');
  const layoutActions=[];
  if(tabs.node.content.mod!=='session-tabs')layoutActions.push({type:'layout-tabs',before:tabs.node.content.mod,after:'session-tabs'});
  if(!existing)layoutActions.push({type:'layout-plan',after:{id:'plan',type:'block',content:{mod:'plan'}}});
  push(options.layoutPath,current.layout,layoutActions);
  const cli=doc(current.opencode),plugins=cli.plugins;
  if(!Array.isArray(plugins))throw Error('owned-plugin-missing');
  const matches=plugins.filter(entry=>[beforePackage,options.releasePath].includes(typeof entry==='string'?entry:entry?.package));
  if(matches.length!==1)throw Error('owned-plugin-ambiguous');
  const original=matches[0],packagePath=typeof original==='string'?original:original.package,oldOptions=original.options??{};
  const values={planNode:options.node,planAppHome:options.appHome,planStateRoot:options.stateRoot};
  push(options.opencodePath,current.opencode,[{type:'plugin',beforePackage:packagePath,afterPackage:options.releasePath,originalString:typeof original==='string',beforeOptions:Object.hasOwn(original,'options'),
    options:Object.entries(values).map(([key,after])=>({key,beforeExists:Object.hasOwn(oldOptions,key),before:oldOptions[key],after}))}]);
  const claude=doc(current.claude),hookActions=[];
  const oldHelper=join(beforePackage,'bin/herdr-session-meta.mjs'),newHelper=join(options.releasePath,'bin/herdr-session-meta.mjs');
  for(const event of ['SessionStart','UserPromptSubmit','PostToolUse','CwdChanged','Stop','SessionEnd']) {
    const found=hooks(claude,event,oldHelper);if(found.length!==1)throw Error('owned-hook-missing-or-ambiguous');
    hookActions.push({type:'hook',event,beforeHelper:oldHelper,afterHelper:newHelper,beforeCommand:found[0].hook.command,afterCommand:options.node,addedPlans:!found[0].hook.args.includes('--plans')});
  }
  push(options.claudePath,current.claude,hookActions);
  const runtime=current.runtime===null?{}:doc(current.runtime);
  if(current.runtime!==null&&(runtime.owner!==OWNER||runtime.schema!==1))throw Error('foreign-runtime-descriptor');
  const descriptor={schema:1,owner:OWNER,node:options.node,helperPath:join(options.releasePath,'bin/herdr-plan.mjs'),stateRoot:options.stateRoot,buildHash:options.buildHash};
  push(options.runtimePath,current.runtime,[{type:'runtime',created:current.runtime===null,fields:Object.entries(descriptor).map(([key,after])=>({key,beforeExists:Object.hasOwn(runtime,key),before:runtime[key],after}))}]);
  return edits;
}
export async function atomicConfigText(path,text,expectedHash) {
  const before=await read(path);if(configHash(before)!==expectedHash)throw Error('config-changed-concurrently');
  if(before!==null&&!(await lstat(path)).isFile())throw Error('foreign-config-path');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  if(text===null){await unlink(path);return;}
  const temp=path+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temp,text,{flag:'wx',mode:0o600});
    if(configHash(await read(path))!==expectedHash)throw Error('config-changed-concurrently');
    await rename(temp,path);
  } finally {await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function journalAt(path){const text=await read(path);if(text===null)return null;const value=JSON.parse(text);if(value.owner!==OWNER||value.schema!==1)throw Error('foreign-install-journal');return value;}
async function saveJournal(path,value){await atomicConfigText(path,JSON.stringify(value,null,2)+'\n',configHash(await read(path)));}
export async function applyPlanUiInstall(edits,{journalPath,expectedHashes,writeText=atomicConfigText}) {
  let journal=await journalAt(journalPath);
  if(!journal)journal={owner:OWNER,schema:1,id:randomUUID(),phase:'planned',edits:edits.map(({afterText,...edit})=>({...edit,applied:false}))};
  for(const edit of journal.edits) {
    const hash=configHash(await read(edit.path));
    if(hash!==edit.beforeHash&&hash!==edit.afterHash)throw Error('config-changed-concurrently');
    if(expectedHashes?.[edit.path]&&expectedHashes[edit.path]!==edit.beforeHash)throw Error('config-changed-concurrently');
  }
  await saveJournal(journalPath,journal);
  for(const edit of journal.edits) {
    const before=await read(edit.path),hash=configHash(before);
    if(hash===edit.afterHash){edit.applied=true;continue;}
    journal.phase='applying';journal.pending=edit.path;await saveJournal(journalPath,journal);
    const afterText=applyActions(before,edit.ownedValues);
    if(configHash(afterText)!==edit.afterHash)throw Error('install-plan-drift');
    await writeText(edit.path,afterText,edit.beforeHash);edit.applied=true;await saveJournal(journalPath,journal);
  }
  journal.phase='installed';journal.pending=null;await saveJournal(journalPath,journal);return journal;
}
export async function rollbackPlanUiInstall(journalPath) {
  const journal=await journalAt(journalPath);if(!journal)throw Error('install-journal-unavailable');
  for(const edit of [...journal.edits].reverse()) {
    const before=await read(edit.path);if(before===null)continue;
    if(!edit.applied&&configHash(before)!==edit.afterHash)continue;
    const after=applyActions(before,edit.ownedValues,true);
    if(after!==before)await atomicConfigText(edit.path,after,configHash(before));
  }
  journal.phase='rolled-back';await saveJournal(journalPath,journal);return journal;
}
export async function createPlanRelease({sourceIntegration,appHome,id=randomUUID()}) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid-release-id');
  const releasePath=join(appHome,'integrations/session-metadata/releases',id);
  await mkdir(dirname(releasePath),{recursive:true,mode:0o700});
  try {await mkdir(releasePath,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('release-already-exists');throw e;}
  const files={};
  async function copy(source,target) {
    const info=await lstat(source);if(info.isSymbolicLink())throw Error('release-source-symlink');
    if(info.isDirectory()) {await mkdir(target,{mode:0o700});for(const name of await readdir(source))await copy(join(source,name),join(target,name));}
    else if(info.isFile()) {const bytes=await readFile(source);await writeFile(target,bytes,{flag:'wx',mode:0o600});files[relative(releasePath,target).replaceAll('\\','/')]=createHash('sha256').update(bytes).digest('hex');}
  }
  for(const name of ['src','bin','opencode','claude','package.json','package-lock.json']) {
    const source=join(sourceIntegration,name);try {await lstat(source);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    await copy(source,join(releasePath,name));
  }
  const entries=Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0),manifest={owner:OWNER,schema:1,protocol:2,files,buildHash:configHash(JSON.stringify(entries))};
  await writeFile(join(releasePath,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {releasePath,manifest};
}
