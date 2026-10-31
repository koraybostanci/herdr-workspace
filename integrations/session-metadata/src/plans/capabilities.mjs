import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { OWNER, decodeProof } from '../protocol.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export async function readDeliveryCapability(proof,runtime,options={}) {
  const unavailable=reason=>({send:false,probeAllowed:false,reason});
  if(!decodeProof(proof).ok||proof.session.harness!=='opencode-v2')return unavailable('unsupported-provider');
  try {
    const root=runtime.bundleRoot??fileURLToPath(new URL('../../',import.meta.url));
    const manifest=JSON.parse(await readFile(join(root,'build-manifest.json'),'utf8'));
    if(manifest.schema!==1||manifest.owner!==OWNER||manifest.protocol!==2||!manifest.files||Array.isArray(manifest.files))return unavailable('unverified-runtime');
    const files=Object.entries(manifest.files).sort(([a],[b])=>a<b?-1:a>b?1:0);
    if(!files.length||files.length>2000||sha(JSON.stringify(files))!==manifest.buildHash)return unavailable('unverified-runtime');
    for(const [path,expected] of files) {
      if(!path||isAbsolute(path)||path.split(/[\\/]/).some(part=>part==='..')||/[\x00-\x1f\x7f]/.test(path)
        ||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))return unavailable('unverified-runtime');
      const file=join(root,path);
      if(!(await lstat(file)).isFile()||sha(await readFile(file))!==expected)return unavailable('runtime-changed');
    }
    const registry=JSON.parse(await readFile(join(runtime.appHome,'data/session-plans/delivery-capabilities.json'),'utf8'));
    if(registry.schema!==1||registry.owner!==OWNER||!Array.isArray(registry.entries))return unavailable('unverified-delivery');
    const version=options.providerVersion??runtime.ownerVersion?.(proof);
    const entry=registry.entries.find(e=>e&&e.host===proof.session.host&&e.authority===proof.session.authority&&e.harness===proof.session.harness
      &&e.buildHash===manifest.buildHash&&typeof version==='string'&&e.providerVersion===version);
    if(!entry)return unavailable('unverified-delivery');
    if(entry.mode==='probe')return {send:false,probeAllowed:options.resume===false&&proof.coreSession.startsWith('herdr-plan-probe-')
      &&Array.isArray(entry.probeSessions)&&entry.probeSessions.includes(proof.session.id),reason:'probe-only'};
    if(entry.mode!=='send'||entry.probeReceived!==true||entry.noModelCalls!==true)return unavailable('unverified-delivery');
    return {send:true,probeAllowed:false};
  } catch {return unavailable('unverified-runtime');}
}
