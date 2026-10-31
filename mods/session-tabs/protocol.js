// Pure contracts shared with owned native mods. Keep this module host-independent.
export const OWNER = 'herdr-session-metadata';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0 && !/[\x00-\x1f\x7f]/.test(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const fields = (x, names) => object(x) && Object.keys(x).every(k => names.includes(k)) && names.every(k => Object.hasOwn(x,k));
const path = x => text(x) && /^(?:\/|[A-Za-z]:[\\/])/.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const result = (valid,value,reason) => valid ? {ok:true,value} : {ok:false,reason};
export function utf8Length(value) {
  let count = 0;
  for (const char of value) { const n=char.codePointAt(0); count += n<128?1:n<2048?2:n<65536?3:4; }
  return count;
}
export function decodeSession(value) {
  return result(fields(value,['host','authority','harness','id']) && text(value.host) && text(value.authority)
    && ['opencode-v2','claude'].includes(value.harness) && text(value.id) && /^[\w-]+$/.test(value.id), value,'invalid-session');
}
export function sessionKey(value) {
  if (!decodeSession(value).ok) throw new Error('Invalid session identity');
  return JSON.stringify([value.host,value.authority,value.harness,value.id]);
}
export function bindingKey(value) {
  if (!object(value) || ![value.coreHost,value.coreSession,value.terminal].every(text)
    || !integer(value.createdMs) || value.createdMs===0) throw new Error('Invalid terminal identity');
  return JSON.stringify([value.coreHost,value.coreSession,value.terminal,value.createdMs]);
}
export function decodeProof(value) {
  const names=['channel','session','coreHost','coreSession','terminal','createdMs','processPid','processStartedAt','generation','epoch','verifiedAt','leaseUntil'];
  return result(fields(value,names) && ['plan','metadata'].includes(value.channel) && decodeSession(value.session).ok
    && [value.coreHost,value.coreSession,value.terminal,value.processStartedAt,value.generation].every(text)
    && integer(value.createdMs) && value.createdMs>0 && integer(value.processPid) && value.processPid>0 && value.epoch===2
    && integer(value.verifiedAt) && integer(value.leaseUntil) && value.leaseUntil>value.verifiedAt
    && value.leaseUntil-value.verifiedAt<=45000, value,'invalid-proof');
}
export function decodeArtifact(value) {
  return result(fields(value,['id','session','host','path','resolvedPath','kind','hash','revision','source','primary'])
    && decodeSession(value.session).ok && value.host===value.session.host && [value.id,value.source].every(text)
    && path(value.path) && path(value.resolvedPath) && ['design','implementation'].includes(value.kind)
    && hash(value.hash) && integer(value.revision) && typeof value.primary==='boolean', value,'invalid-artifact');
}
export function decodeAnchor(value) {
  if (value===null) return {ok:true,value};
  return result(fields(value,['documentHash','headingPath','occurrence','sectionHash','excerpt'])
    && hash(value.documentHash) && hash(value.sectionHash) && integer(value.occurrence)
    && Array.isArray(value.headingPath) && value.headingPath.length>0 && value.headingPath.every(text)
    && typeof value.excerpt==='string' && !value.excerpt.includes('\0') && utf8Length(value.excerpt)<=1024, value,'invalid-anchor');
}
export function decodeComment(value) {
  return result(fields(value,['id','artifactId','session','revision','text','anchor','status','documentHash'])
    && decodeSession(value.session).ok && [value.id,value.artifactId].every(text) && integer(value.revision)
    && typeof value.text==='string' && !value.text.includes('\0') && hash(value.documentHash)
    && decodeAnchor(value.anchor).ok && (value.anchor===null || value.anchor.documentHash===value.documentHash)
    && ['open','resolved'].includes(value.status), value,'invalid-comment');
}
export function decodeDelivery(value) {
  return result(object(value) && Object.keys(value).every(k=>['state','requestId','providerId','reason'].includes(k))
    && text(value.requestId) && ['pending','sending','accepted','failed','unknown','waiting-next-prompt'].includes(value.state)
    && (!Object.hasOwn(value,'providerId') || text(value.providerId)) && (!Object.hasOwn(value,'reason') || text(value.reason)), value,'invalid-delivery');
}
