import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { validWorkScope } from './contracts.mjs';

const path=value=>typeof value==='string'&&isAbsolute(value)&&!/[\x00-\x1f\x7f]/.test(value);
const planArtifact=value=>/\/(?:docs\/superpowers\/(?:plans|specs)|\.claude\/plans)\//.test(value);
export function operationScope(input={}) {
  if(input.failed)return null;
  const tool=String(input.tool??'').split(/[.:]/).at(-1).toLowerCase();
  let files=[];
  if(['write','edit','multiedit'].includes(tool))files=[input.filePath??input.file_path??input.path];
  if(['patch','apply_patch'].includes(tool))files=[...String(input.patchText??input.patch??'').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match=>match[1]);
  files=files.filter(path).filter(file=>!planArtifact(file));
  if(files.length)return {kind:'file',paths:[...new Set(files)].slice(0,128),source:'successful-file-work'};
  // A workdir is an execution location, not proof that a diagnostic command owns the task.
  if(!['shell','bash','exec'].includes(tool))return null;
  let command=String(input.command??'').trim(),cwd=input.workdir??input.cwd;
  const cd=command.match(/^cd\s+(?:"([^"$`]+)"|'([^']+)'|([^\s&;$`]+))\s*&&\s*(.+)$/s);
  if(cd){const target=cd[1]??cd[2]??cd[3];cwd=path(target)?target:path(cwd)?resolve(cwd,target):null;command=cd[4];}
  const git=command.match(/^git\s+-C\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;$`]+))\s+(.+)$/s);
  if(git){const target=git[1]??git[2]??git[3];cwd=path(target)?target:path(cwd)?resolve(cwd,target):null;command='git '+git[4];}
  if(!path(cwd)||/[$`|;\n]|&&|\|\|/.test(command))return null;
  const work=/^(?:node\s+--test\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|pytest\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check)\b|(?:cargo|go)\s+(?:test|build)\b|make\s+(?:test|check|build)\b|git\s+(?:add|commit|switch|checkout|cherry-pick|merge)\b|gh\s+pr\s+(?:create|edit|checkout)\b)/.test(command);
  return work?{kind:'directory',paths:[cwd],source:'successful-task-command'}:null;
}
async function governedDirectory(file,host) {
  const parent=dirname(file);
  if(host!=='local')return parent; // Never interpret a peer path on this machine.
  let directory=parent,packageRoot=null;
  for(let depth=0;depth<24;depth++) {
    for(const marker of ['AGENTS.md','.git','package.json','pyproject.toml','go.mod']) {
      try {
        const info=await lstat(resolve(directory,marker));
        if(marker==='AGENTS.md'&&info.isFile()||marker==='.git'&&(info.isDirectory()||info.isFile()))return directory;
        if(info.isFile()&&!packageRoot)packageRoot=directory;
      } catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
    }
    const next=dirname(directory);if(next===directory)break;directory=next;
  }
  return packageRoot;
}
export async function selectWorkScope(observation,previous,canonicalDirectory,homeDirectory=homedir()) {
  const host=observation.session.host,input=observation.payload??{};
  let scope=validWorkScope(previous)&&previous.host===host?previous:null;
  // Editing global agent instructions must not replace this session's project.
  const instructions=resolve(homeDirectory,'.agents');
  const inside=value=>path(value)&&(resolve(value)===instructions||resolve(value).startsWith(instructions+sep));
  const instructionTask=inside(canonicalDirectory)||scope?.source!=='successful-file-work'&&inside(scope?.path);
  const auxiliary=value=>host==='local'&&!instructionTask&&inside(value);
  if(scope?.source==='successful-file-work'&&(auxiliary(scope.path)||await governedDirectory(resolve(scope.path,'__scope__'),host)!==scope.path))scope=null;
  let candidates=[];
  if(observation.kind==='location'&&path(input.cwd))candidates=[{operation:{kind:'directory',paths:[input.cwd],source:'session-location'},eventId:observation.eventId,eventAt:observation.observedAt}];
  else if(observation.kind==='tool')candidates=[{operation:operationScope(input),eventId:observation.eventId,eventAt:observation.observedAt}];
  else if(observation.kind==='title')candidates=Array.isArray(input.scopeEvidence)?input.scopeEvidence:[input.scopeEvidence];
  for(const candidate of candidates.filter(Boolean).sort((a,b)=>b.eventAt-a.eventAt)) {
    const evidence=candidate.operation,{eventId,eventAt}=candidate;
    if(!evidence||scope&&eventAt<scope.eventAt||!['file','directory'].includes(evidence.kind)||!Array.isArray(evidence.paths)||!evidence.paths.length)continue;
    const paths=evidence.paths.filter(path).filter(file=>evidence.kind!=='file'||!auxiliary(file));
    const directories=await Promise.all(paths.map(file=>evidence.kind==='file'?governedDirectory(file,host):file));
    if(directories.length&&directories[0]&&directories.every(directory=>directory===directories[0])){
      if(evidence.kind==='file'&&instructionTask&&inside(scope?.path)&&inside(directories[0]))break;
      scope={version:1,host,path:directories[0],source:evidence.source,eventId,eventAt};break;
    }
  }
  if(!scope) {
    const initial=path(canonicalDirectory)?canonicalDirectory:observation.kind==='task'&&path(input.cwd)?input.cwd:null;
    if(initial)scope={version:1,host,path:initial,source:'session-location',eventId:observation.eventId,eventAt:0};
  }
  return scope;
}
