import { randomUUID, createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sessionKey, decodeSession, decodeProof, decodeArtifact, utf8Length } from '../protocol.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function schema(db) {
  db.transaction(sql => sql.exec(`
    CREATE TABLE IF NOT EXISTS plan_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plan_artifacts (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, path TEXT NOT NULL,
      data TEXT NOT NULL, active INTEGER NOT NULL, sequence INTEGER NOT NULL, UNIQUE(session_key,path));
    CREATE TABLE IF NOT EXISTS plan_artifact_events (session_key TEXT NOT NULL, event_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
      PRIMARY KEY(session_key,event_id), FOREIGN KEY(artifact_id) REFERENCES plan_artifacts(id));
  `));
}
export async function assertPlanOwner(session, deps) {
  if (!decodeSession(session).ok) throw Error('invalid-session');
  let proofs = deps.proof ? [deps.proof] : [];
  if (!deps.proof) {
    proofs = deps.db.sql.prepare("SELECT proof FROM channel_bindings WHERE channel='plan' AND state='active'").all()
      .flatMap(row => { try { return [JSON.parse(row.proof)]; } catch { return []; } });
  }
  for (const proof of proofs) {
    if (decodeProof(proof).ok && proof.channel === 'plan' && sessionKey(proof.session) === sessionKey(session)
      && await deps.lifecycle.verify(proof)) return proof;
  }
  throw Error('owner-unavailable');
}
function parse(row, session) {
  let artifact;
  try { artifact = row && JSON.parse(row.data); } catch { throw Error('artifact-unavailable'); }
  if (!decodeArtifact(artifact).ok || sessionKey(artifact.session) !== sessionKey(session)
    || artifact.id !== row.id || artifact.path !== row.path) throw Error('artifact-unavailable');
  return artifact;
}
function get(db, session, id) {
  return db.sql.prepare('SELECT * FROM plan_artifacts WHERE session_key=? AND id=? AND active=1').get(sessionKey(session), id);
}
export async function readDocument(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error('absolute-path-required');
  const resolvedPath = await realpath(path);
  const file = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({bigint:true});
    if (!before.isFile()) throw Error('not-regular-file');
    if (before.size > 1048576n) throw Error('too-large');
    const bytes = Buffer.alloc(1048577);
    let length = 0;
    while (length < bytes.length) {
      const {bytesRead} = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1048576) throw Error('too-large');
    const after = await file.stat({bigint:true});
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || await realpath(path) !== resolvedPath) throw Error('document-changed');
    const content = bytes.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', {fatal:true}).decode(content); } catch { throw Error('invalid-utf8'); }
    return {resolvedPath, text, hash:hash(content)};
  } finally { await file.close(); }
}
export async function registerArtifact({session, proof, path, kind, source='explicit'}, deps) {
  schema(deps.db);
  await assertPlanOwner(session, {...deps, proof});
  if (session.host !== (deps.host ?? deps.env?.HERDR_METADATA_HOST ?? 'local')) throw Error('host-unavailable');
  if (!['design','implementation'].includes(kind) || !/^(?:explicit|harness-plan|(?:opencode|claude)-tool:[\w.:-]{1,512})$/.test(source)) throw Error('invalid-artifact-source');
  const key = sessionKey(session);
  const seen = source !== 'explicit' && deps.db.sql.prepare('SELECT artifact_id FROM plan_artifact_events WHERE session_key=? AND event_id=?').get(key, source);
  if (seen) {
    const row = deps.db.sql.prepare('SELECT * FROM plan_artifacts WHERE id=? AND session_key=?').get(seen.artifact_id, key);
    return parse(row, session);
  }
  const previous = deps.db.sql.prepare('SELECT * FROM plan_artifacts WHERE session_key=? AND path=?').get(key, path);
  const document = await (deps.readDocument ?? readDocument)(path);
  return deps.db.transaction(sql => {
    const current = sql.prepare('SELECT * FROM plan_artifacts WHERE session_key=? AND path=?').get(key, path);
    if ((current?.data ?? null) !== (previous?.data ?? null)) throw Error('artifact-changed');
    const old = previous && parse(previous, session);
    const changed = old && (old.hash !== document.hash || old.resolvedPath !== document.resolvedPath || old.kind !== kind);
    const artifact = {id:old?.id ?? randomUUID(), session, host:session.host, path, resolvedPath:document.resolvedPath, kind,
      hash:document.hash, revision:old ? old.revision + (changed ? 1 : 0) : 0, source:old?.source ?? source, primary:old?.primary ?? false};
    if (!decodeArtifact(artifact).ok) throw Error('invalid-artifact');
    sql.prepare("INSERT INTO plan_sequences VALUES ('artifact',1) ON CONFLICT(name) DO UPDATE SET value=value+1").run();
    const sequence = sql.prepare("SELECT value FROM plan_sequences WHERE name='artifact'").get().value;
    sql.prepare('INSERT INTO plan_artifacts VALUES (?,?,?,?,1,?) ON CONFLICT(session_key,path) DO UPDATE SET data=excluded.data,active=1,sequence=excluded.sequence')
      .run(artifact.id, key, path, JSON.stringify(artifact), sequence);
    if (source !== 'explicit') sql.prepare('INSERT OR IGNORE INTO plan_artifact_events VALUES (?,?,?)').run(key, source, artifact.id);
    return artifact;
  });
}
export async function listArtifacts(session, deps) {
  schema(deps.db);
  await assertPlanOwner(session, deps);
  return deps.db.sql.prepare('SELECT * FROM plan_artifacts WHERE session_key=? AND active=1 ORDER BY sequence DESC').all(sessionKey(session))
    .flatMap(row => { try { return [parse(row,session)]; } catch { return []; } })
    .sort((a,b) => Number(b.primary) - Number(a.primary));
}
export async function unregisterArtifact({session,id,expectedRevision}, deps) {
  schema(deps.db); await assertPlanOwner(session, deps);
  return deps.db.transaction(sql => {
    const row = get(deps.db, session, id);
    if (!row || parse(row,session).revision !== expectedRevision) return false;
    sql.prepare('UPDATE plan_artifacts SET active=0 WHERE id=? AND session_key=?').run(id,sessionKey(session));
    return true;
  });
}
export async function setPrimaryArtifact({session,id,expectedRevision}, deps) {
  schema(deps.db); await assertPlanOwner(session, deps);
  return deps.db.transaction(sql => {
    const row = get(deps.db,session,id);
    if (!row || parse(row,session).revision !== expectedRevision) return false;
    for (const item of sql.prepare('SELECT * FROM plan_artifacts WHERE session_key=? AND active=1').all(sessionKey(session))) {
      const artifact = parse(item,session);
      sql.prepare('UPDATE plan_artifacts SET data=? WHERE id=? AND session_key=?').run(JSON.stringify({...artifact,primary:item.id===id}),item.id,sessionKey(session));
    }
    return true;
  });
}
export async function readArtifact({session,id}, deps) {
  schema(deps.db); await assertPlanOwner(session, deps);
  const row = get(deps.db,session,id), artifact = parse(row,session);
  if (artifact.host !== (deps.host ?? deps.env?.HERDR_METADATA_HOST ?? 'local')) throw Error('host-unavailable');
  let document;
  try { document = await (deps.readDocument ?? readDocument)(artifact.path); }
  catch (e) {
    if (e.code === 'ENOENT') return {artifact,state:'missing',text:null,sections:[]};
    if (e.message === 'document-changed') return {artifact,state:'changed',text:null,sections:[]};
    throw e;
  }
  if (document.resolvedPath !== artifact.resolvedPath) return {artifact,state:'needs-verification',text:null,sections:[]};
  return deps.db.transaction(sql => {
    if (get(deps.db,session,id)?.data !== row.data) return {artifact,state:'superseded',text:null,sections:[]};
    const next = document.hash === artifact.hash ? artifact : {...artifact,hash:document.hash,revision:artifact.revision+1};
    if (next !== artifact) sql.prepare('UPDATE plan_artifacts SET data=? WHERE id=? AND session_key=?').run(JSON.stringify(next),id,sessionKey(session));
    return {artifact:next,state:'ready',text:document.text,sections:indexSections(document.text,document.hash)};
  });
}

function excerpt(text) {
  let output='',bytes=0;
  for (const char of text) { const n=utf8Length(char); if(bytes+n>1024)break;output+=char;bytes+=n; }
  return output;
}
export function indexSections(text, documentHash) {
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[],headings=[];
  let offset=0,fence=null,html=null,previous=null;
  for (const raw of lines) {
    const line=raw.replace(/\r?\n$/,''), start=offset;offset+=raw.length;
    if (fence) { if(new RegExp('^ {0,3}'+fence.char+'{'+fence.length+',}\\s*$').test(line))fence=null; previous=null;continue; }
    const opened=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opened) {fence={char:opened[1][0],length:opened[1].length};previous=null;continue;}
    if (html) { if(html==='blank'?!line.trim():html.test(line))html=null;previous=null;continue; }
    if (/^ {0,3}<!--/.test(line)) {if(!line.includes('-->'))html=/-->/;previous=null;continue;}
    const tag=line.match(/^ {0,3}<(script|pre|style|textarea)\b/i);
    if (tag) {html=new RegExp('</'+tag[1]+'\\s*>','i');if(html.test(line))html=null;previous=null;continue;}
    if (/^ {0,3}<\/?(?:div|table|section|article|aside|blockquote|details|summary|ul|ol|li|p|h[1-6]|hr|header|footer)\b/i.test(line)) {html='blank';previous=null;continue;}
    if (/^(?: {4}|\t)/.test(line)) {previous=null;continue;}
    const atx=line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)\s*|[ \t]*)$/);
    if (atx) {headings.push({level:atx[1].length,title:(atx[2]??'').replace(/[ \t]+#+[ \t]*$/,'').trim(),start});previous=null;continue;}
    const underline=line.match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (underline&&previous) {headings.push({level:underline[1][0]==='='?1:2,title:previous.title,start:previous.start});previous=null;continue;}
    previous=line.trim()&&!/^ {0,3}(?:>|[-+*]\s|\d+[.)]\s)/.test(line)?{title:line.trim(),start}:null;
  }
  const stack=[],occurrences=new Map();
  return headings.filter(h=>h.title).map((heading,index,array)=>{
    while(stack.length&&stack.at(-1).level>=heading.level)stack.pop();
    stack.push(heading);
    const headingPath=stack.map(h=>h.title),key=JSON.stringify(headingPath),occurrence=occurrences.get(key)??0;
    occurrences.set(key,occurrence+1);
    const next=array.slice(index+1).find(h=>h.level<=heading.level),end=next?.start??text.length;
    const content=text.slice(heading.start,end);
    return {headingPath,occurrence,start:heading.start,end,sectionHash:hash(content),excerpt:excerpt(content)};
  });
}
export function reanchor(anchor, sections) {
  if (anchor===null) return {state:'current',anchor};
  const matches=sections.filter(section=>JSON.stringify(section.headingPath)===JSON.stringify(anchor.headingPath)&&section.sectionHash===anchor.sectionHash);
  return {state:matches.length===1?'current':'needs-recheck',anchor};
}
