import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { session, proof, scratch, projectRoot } from './helpers/v2-fixtures.mjs';

const protocol = await import('../integrations/session-metadata/src/protocol.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const database = await import('../integrations/session-metadata/src/database.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
async function temporary(t) {
  const root = await mkdtemp(join(scratch, 'herdr-plan-contract-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  return root;
}
const hash = 'a'.repeat(64);
const artifact = {id:'doc-A', session, host:'local', path:'/plans/design.md', resolvedPath:'/plans/design.md',
  kind:'design', hash, revision:0, source:'explicit', primary:false};
const comment = {id:'comment-A', artifactId:'doc-A', session, revision:0, text:'First line\n\tSecond line', anchor:null, status:'open',documentHash:hash};

test('session identities and proof validation separate exact authority and terminal generation', () => {
  assert.equal(typeof protocol.decodeSession, 'function');
  assert.equal(protocol.decodeSession(session).ok, true);
  assert.equal(protocol.sessionKey(session), '["local","local","opencode-v2","ses_plan_A"]');
  assert.notEqual(protocol.sessionKey(session), protocol.sessionKey({...session, authority:'server-B'}));
  assert.notEqual(protocol.sessionKey(session), protocol.sessionKey({...session, host:'peer'}));
  assert.equal(protocol.decodeProof(proof).ok, true);
  for (const bad of [null, {...proof, epoch:1}, {...proof, processStartedAt:''}, {...proof, leaseUntil:46001}, {...proof, processPid:0}]) {
    assert.equal(protocol.decodeProof(bad).ok, false);
  }
  assert.notEqual(protocol.bindingKey(proof), protocol.bindingKey({...proof, createdMs:101}));
});

test('arbitrary_json_validation_never_throws including nested malformed plan records', () => {
  const decoders = ['decodeSession','decodeProof','decodeArtifact','decodeComment'];
  const values = [null, [], {}, 0, true, '', {session:null}, {session:[]}, {bindings:[null]}, {anchor:{headingPath:[null]}}];
  let seed = 12345;
  for (let i = 0; i < 300; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    values.push({session:values[seed % values.length], revision:i%3-1, anchor:values[(seed>>>8)%values.length]});
  }
  for (const name of decoders) {
    assert.equal(typeof protocol[name], 'function');
    for (const value of values) assert.equal(protocol[name](value).ok, false);
  }
  assert.equal(protocol.decodeArtifact({...artifact, session:{...session,id:'bad\n'}}).ok, false);
  assert.equal(protocol.decodeArtifact({...artifact, hash:'not-a-hash'}).ok, false);
  assert.equal(protocol.decodeProof({...proof, arbitraryRawPayload:'private'}).ok, false);
});

test('valid multiline comments and anchors remain data with bounded original UTF-8 excerpts', () => {
  assert.equal(typeof protocol.decodeComment, 'function');
  assert.equal(protocol.decodeArtifact(artifact).ok, true);
  assert.equal(protocol.decodeComment(comment).ok, true);
  assert.equal(protocol.decodeComment({...comment,text:'nul\0'}).ok, false);
  const anchor = {documentHash:hash, headingPath:['Design','Storage'], occurrence:0, sectionHash:hash, excerpt:'🙂'.repeat(256)};
  assert.equal(protocol.decodeComment({...comment,anchor}).ok, true);
  assert.equal(protocol.decodeComment({...comment,anchor:{...anchor,documentHash:'b'.repeat(64)}}).ok, false);
  assert.equal(protocol.decodeComment({...comment,anchor:{...anchor,excerpt:anchor.excerpt+'a'}}).ok, false);
  assert.equal(protocol.decodeComment({...comment,anchor:{...anchor,headingPath:[null]}}).ok, false);
});

test('private database persists transactions and rejects asynchronous transaction callbacks', async t => {
  assert.equal(typeof database.openDatabase, 'function');
  const root = join(await temporary(t), 'v2');
  const db = database.openDatabase({root});
  db.transaction(sql => sql.exec('CREATE TABLE example(value TEXT); INSERT INTO example VALUES (\'saved\')'));
  assert.throws(() => db.transaction(sql => { sql.exec("INSERT INTO example VALUES ('rollback')"); throw Error('stop'); }), /stop/);
  assert.throws(() => db.transaction(async () => {}), /synchronous/);
  for (const path of [root, db.path, root+'.init.json', db.path+'-wal', db.path+'-shm']) {
    assert.equal((await stat(path)).mode & 0o777, path === root ? 0o700 : 0o600);
  }
  db.close();
  const reopened = database.openDatabase({root});
  assert.deepEqual(reopened.sql.prepare('SELECT value FROM example').all().map(r=>r.value), ['saved']);
  reopened.close();
});

test('foreign roots, journal mismatch and symlinked SQLite paths are not adopted', async t => {
  assert.equal(typeof database.openDatabase, 'function');
  const root = await temporary(t), foreign = join(root,'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign,'state.sqlite'),'foreign');
  assert.throws(() => database.openDatabase({root:foreign}), /foreign|owner/i);
  const own = join(root,'own');
  const db = database.openDatabase({root:own}); db.close();
  assert.throws(() => database.openDatabase({root:own,initializationIntent:'different'}), /intent|owner/i);
  const linked = join(root,'linked');
  database.prepareDatabaseRoot({root:linked});
  await rm(join(linked,'state.sqlite'));
  await symlink(join(foreign,'state.sqlite'), join(linked,'state.sqlite'));
  assert.throws(() => database.openDatabase({root:linked}), /symlink|regular/i);
  assert.equal(await readFile(join(foreign,'state.sqlite'),'utf8'),'foreign');
});

function worker(root, mode) {
  const child=fork(new URL('./helpers/v2-store-worker.mjs', import.meta.url), [root,mode], {silent:true});
  child.diagnostic='';child.stderr.on('data',data=>{child.diagnostic+=data;});return child;
}
function message(child, event) {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{ done(); reject(Error('worker timeout: '+event)); },10000);
    const listener = value => { if(value.event===event) { done(); resolve(value); } };
    const exit=code=>{done();reject(Error('worker exited '+code+': '+child.diagnostic));};
    function done(){clearTimeout(timer);child.off('message',listener);child.off('exit',exit);}
    child.on('message',listener);child.on('exit',exit);
  });
}

test('crash_after_owner_or_database_creation_recovers without adopting unrelated files', async t => {
  assert.equal(typeof database.openDatabase, 'function');
  const root=join(await temporary(t),'v2'), child=worker(root,'incomplete');
  t.after(()=>child.kill());
  await message(child,'opened');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const db=database.openDatabase({root});
  assert.equal(db.sql.prepare("SELECT name FROM sqlite_master WHERE name='unfinished'").get(),undefined);
  db.transaction(sql=>sql.exec('CREATE TABLE recovered(value TEXT)'));
  db.close();
});

test('concurrent_dead_owner_recovery_has_one_owner with actual independent processes', async t => {
  assert.equal(typeof database.openDatabase, 'function');
  const root=join(await temporary(t),'v2'), db=database.openDatabase({root});
  const dead=worker(root,'claim'), a=worker(root,'claim'), b=worker(root,'claim');
  t.after(()=>{for(const child of [dead,a,b])child.kill();db.close();});
  await Promise.all([message(dead,'ready'),message(a,'ready'),message(b,'ready')]);
  const acquired=message(dead,'claim');dead.send('claim');assert.ok((await acquired).value.token);
  const exited=once(dead,'exit');dead.kill('SIGKILL');await exited;
  const results=[message(a,'claim'),message(b,'claim')];a.send('claim');b.send('claim');
  const [aa,bb]=await Promise.all(results);
  assert.equal([aa,bb].filter(r=>r.value).length,1);
  const winner=aa.value?a:b, token=(aa.value??bb.value).token;
  assert.equal(db.release('shared-resource','wrong-token'),false);
  assert.equal(db.claim('shared-resource',{pid:process.pid,startedAt:database.processStamp(process.pid)}),null);
  const released=message(winner,'released');winner.send({release:token});assert.equal((await released).value,true);
  assert.ok(db.claim('shared-resource',{pid:process.pid,startedAt:database.processStamp(process.pid)}).token);
});

test('PID reuse start mismatch is recoverable but a live or unknown owner cannot be stolen', async t => {
  assert.equal(typeof database.openDatabase, 'function');
  const db=database.openDatabase({root:join(await temporary(t),'v2')});t.after(()=>db.close());
  const actor={pid:process.pid,startedAt:database.processStamp(process.pid)};
  assert.ok(db.claim('reused',{...actor,startedAt:'old process'}));
  assert.ok(db.claim('reused',actor));
  assert.equal(db.claim('reused',actor),null);
  assert.throws(()=>db.claim('invalid',{pid:0,startedAt:''}),/actor/i);
});

test('unknown actor liveness never authorizes recovery even when its process stamp cannot be verified', async t => {
  const db=database.openDatabase({root:join(await temporary(t),'v2'),actorState:()=> 'unknown'});t.after(()=>db.close());
  assert.ok(db.claim('uncertain',{pid:process.pid,startedAt:'unverifiable'}));
  assert.equal(db.claim('uncertain',{pid:process.pid,startedAt:database.processStamp(process.pid)}),null);
});

test('concurrent first initialization publishes one owned database without empty-header races', async t => {
  const root=join(await temporary(t),'v2'), children=Array.from({length:6},()=>worker(root,'claim'));
  t.after(()=>children.forEach(child=>child.kill()));
  const ready=await Promise.all(children.map(child=>message(child,'ready')));
  assert.equal(ready.length,6);
  const db=database.openDatabase({root});db.close();
});
