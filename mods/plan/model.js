import { decodeProof, decodeArtifact, sessionKey, bindingKey } from './protocol.js';

export function planEntries(raw,terminals,now=Date.now()) {
  if(!raw||raw.schema!==1||raw.owner!=='herdr-session-plans'||!Array.isArray(raw.entries)
    ||!Number.isSafeInteger(raw.sequence)||raw.sequence<1)return [];
  const entries=[];
  for(const entry of raw.entries) {
    const proof=entry?.proof;
    if(!decodeProof(proof).ok||proof.channel!=='plan'||now<proof.verifiedAt||now>proof.leaseUntil)continue;
    const terminal=terminals.find(t=>t.address===proof.terminal&&t.created_ms===proof.createdMs&&t.state==='live');
    if(!terminal)continue;
    let label;try{label=JSON.parse(terminal.labels?.['herdr.plan-binding']??'null');}catch{continue;}
    if(label?.epoch!==2||label.key!==bindingKey(proof)||label.generation!==proof.generation||label.session!==sessionKey(proof.session))continue;
    const artifacts=(Array.isArray(entry.artifacts)?entry.artifacts:[]).filter(a=>decodeArtifact(a).ok&&sessionKey(a.session)===sessionKey(proof.session));
    const capabilities={send:entry.capabilities?.send===true,reason:typeof entry.capabilities?.reason==='string'?entry.capabilities.reason:null};
    const taskRevision=Number.isSafeInteger(entry.taskRevision)&&entry.taskRevision>=0?entry.taskRevision:null;
    entries.push({proof,artifacts,capabilities,taskRevision});
  }
  return entries;
}
export function selectPlanOwner({focused,agents=[],panes=[],terminals=[],space,previous,planView,now=Date.now()}) {
  if(!space||focused?.space&&focused.space!==space.id)return null;
  const tab=focused?.tab??space.tabs?.find(t=>t.active)?.id;
  if(!tab||!space.tabs?.some(t=>t.id===tab))return null;
  const addresses=new Set([...agents.filter(a=>a.space===space.id&&a.tab===tab).map(a=>a.address),
    ...panes.filter(p=>p.tab===tab&&p.terminal).map(p=>p.terminal)]);
  const entries=planEntries(planView,terminals,now).filter(e=>addresses.has(e.proof.terminal));
  const explicit=focused?.shown??focused?.terminal??focused?.agent;
  let address=explicit;
  if(!address&&previous?.space===space.id&&previous?.tab===tab&&addresses.has(previous.address))address=previous.address;
  if(!address)address=panes.find(p=>p.tab===tab&&p.focused)?.terminal??agents.find(a=>a.space===space.id&&a.tab===tab&&a.focused)?.address;
  const entry=address?entries.find(e=>e.proof.terminal===address):entries.length===1?entries[0]:null;
  if(!entry)return null;
  const owner=entry.proof.session;
  const same=previous?.owner&&sessionKey(previous.owner)===sessionKey(owner)&&previous.proof?.generation===entry.proof.generation
    &&previous.space===space.id&&previous.tab===tab;
  const title=agents.find(a=>a.address===entry.proof.terminal)?.title??panes.find(p=>p.terminal===entry.proof.terminal)?.title??owner.id;
  return {owner,proof:entry.proof,artifacts:entry.artifacts,capabilities:entry.capabilities,taskRevision:entry.taskRevision,address:entry.proof.terminal,
    space:space.id,tab,title,epoch:same?previous.epoch:(previous?.epoch??0)+1};
}
export function planAvailable(owner,artifacts) {
  try{return Array.isArray(artifacts)&&artifacts.some(a=>decodeArtifact(a).ok&&sessionKey(a.session)===sessionKey(owner));}catch{return false;}
}
export function acceptPlanLoad(current,requested) {
  return Boolean(current&&requested&&['ownerKey','artifactId','epoch','loadId'].every(key=>current[key]===requested[key]));
}
export function allowedPlanUrl(url) {
  return typeof url==='string'&&!/[\s\x00-\x1f\x7f\\]/.test(url)
    &&/^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d{1,5})?(?:[/?#].*)?$/i.test(url);
}
export function safePlanPresentation(text) {
  // Without a native images/HTML-disable API, do not trust a partial Markdown lexer as a security boundary.
  return {mode:/!\[|<\/?[a-z][\w:-]*(?:\s|\/?>)|<!|<\?/i.test(text)?'source':'markdown',text};
}
