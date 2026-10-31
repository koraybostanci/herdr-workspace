import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, lstatSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { OWNER } from './protocol.mjs';

function info(path) { try { return lstatSync(path); } catch(e) { if(e.code==='ENOENT')return null;throw e; } }
function regular(path) { const stat=info(path); if(stat && !stat.isFile())throw Error('State path must be a regular file, not a symlink'); return stat; }
function syncDirectory(path) {
  const fd=openSync(path,'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function prepareDatabaseRoot({root,initializationIntent}) {
  root=resolve(root);
  const journal=root+'.init.json';
  const existing=info(root);
  if(existing && !existing.isDirectory())throw Error('Foreign or symlink state root');
  regular(journal);
  if(!info(journal)) {
    if(existing)throw Error('Refusing foreign state root without initialization owner');
    mkdirSync(dirname(root),{recursive:true,mode:0o700});
    const temp=journal+'.'+randomUUID()+'.tmp';
    const intent={schema:2,owner:OWNER,id:initializationIntent??randomUUID(),root};
    const fd=openSync(temp,'wx',0o600);
    try {
      writeFileSync(fd,JSON.stringify(intent));fsyncSync(fd);closeSync(fd);
      try { linkSync(temp,journal);syncDirectory(dirname(root)); } catch(e) { if(e.code!=='EEXIST')throw e; }
    } finally { try { closeSync(fd); } catch {} unlinkSync(temp); }
  }
  let intent;
  try { intent=JSON.parse(readFileSync(journal,'utf8')); } catch { throw Error('Foreign or corrupt initialization owner'); }
  if(intent.owner!==OWNER || intent.schema!==2 || intent.root!==root || typeof intent.id!=='string' || !intent.id
    || initializationIntent!==undefined && initializationIntent!==intent.id)throw Error('Initialization intent ownership mismatch');
  mkdirSync(root,{recursive:true,mode:0o700});
  if(!info(root)?.isDirectory())throw Error('Foreign state directory');
  chmodSync(root,0o700);chmodSync(journal,0o600);
  const path=join(root,'state.sqlite');
  for(const file of [path,path+'-wal',path+'-shm'])regular(file);
  if(!info(path)) {
    try {const fd=openSync(path,'wx',0o600);closeSync(fd);}
    catch(e) {if(e.code!=='EEXIST')throw e;regular(path);}
  }
  return {root,path,intent};
}
export function processStamp(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)return null;
  try { return execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()||null; }
  catch { return null; }
}
export function actorState(actor) {
  try { process.kill(actor.pid,0); } catch(e) { return e.code==='ESRCH'?'dead':'unknown'; }
  const stamp=processStamp(actor.pid);
  return !stamp?'unknown':stamp===actor.startedAt?'live':'dead';
}
function validActor(actor) { return actor && Number.isSafeInteger(actor.pid) && actor.pid>0 && typeof actor.startedAt==='string' && actor.startedAt.trim() && !/[\x00-\x1f\x7f]/.test(actor.startedAt); }
function enableWal(sql) {
  const until=Date.now()+2000;
  for (;;) {
    try {
      if(sql.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')sql.exec('PRAGMA journal_mode=WAL');
      return;
    } catch(e) {
      // SQLite's journal-mode transition can report BUSY without invoking its busy handler.
      if(![5,6].includes(e.errcode)||Date.now()>=until)throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
  }
}

export function openDatabase(options) {
  const {root,path,intent}=prepareDatabaseRoot(options);
  const checkActor=options.actorState??actorState;
  const sql=new DatabaseSync(path);
  try {
    sql.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;');
    sql.exec('BEGIN IMMEDIATE');
    const tables=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if(tables.length && !tables.some(t=>t.name==='store_header'))throw Error('Foreign database without owner');
    sql.exec('CREATE TABLE IF NOT EXISTS store_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const owner=sql.prepare("SELECT value FROM store_header WHERE key='owner'").get()?.value;
    if(owner && owner!==OWNER || !owner && tables.length)throw Error('Foreign database owner');
    const storedIntent=sql.prepare("SELECT value FROM store_header WHERE key='intent'").get()?.value;
    if(storedIntent && storedIntent!==intent.id)throw Error('Database intent ownership mismatch');
    sql.prepare('INSERT OR IGNORE INTO store_header VALUES (?,?)').run('owner',OWNER);
    sql.prepare('INSERT OR IGNORE INTO store_header VALUES (?,?)').run('intent',intent.id);
    sql.prepare('INSERT OR IGNORE INTO store_header VALUES (?,?)').run('schema','1');
    sql.exec('CREATE TABLE IF NOT EXISTS actor_claims (resource TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, started_at TEXT NOT NULL); COMMIT;');
    chmodSync(path,0o600);
    enableWal(sql);sql.exec('PRAGMA synchronous=FULL;');
    for(const file of [path,path+'-wal',path+'-shm'])if(info(file))chmodSync(file,0o600);
  } catch(e) { try {sql.exec('ROLLBACK');}catch{} sql.close();throw e; }
  let closed=false,depth=0;
  const db={root,path,sql,
    transaction(fn) {
      if(typeof fn!=='function' || fn.constructor.name==='AsyncFunction')throw Error('Transaction callback must be synchronous');
      const savepoint='nested_'+depth;
      sql.exec(depth?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');depth++;
      try {
        const result=fn(sql);
        if(result && typeof result.then==='function')throw Error('Transaction callback must be synchronous');
        sql.exec(depth>1?'RELEASE '+savepoint:'COMMIT');return result;
      } catch(e) { sql.exec(depth>1?'ROLLBACK TO '+savepoint+'; RELEASE '+savepoint:'ROLLBACK');throw e; }
      finally {depth--;}
    },
    claim(resource,actor) {
      if(typeof resource!=='string'||!resource||resource.includes('\0')||!validActor(actor))throw Error('Invalid claim resource or actor');
      // Observe liveness outside the write transaction, then compare the exact token inside it.
      const old=sql.prepare('SELECT * FROM actor_claims WHERE resource=?').get(resource);
      if(old && checkActor({pid:old.pid,startedAt:old.started_at})!=='dead')return null;
      const token=randomUUID();
      return db.transaction(()=>{
        const current=sql.prepare('SELECT token FROM actor_claims WHERE resource=?').get(resource);
        if((current?.token??null)!==(old?.token??null))return null;
        sql.prepare('INSERT INTO actor_claims VALUES (?,?,?,?) ON CONFLICT(resource) DO UPDATE SET token=excluded.token,pid=excluded.pid,started_at=excluded.started_at')
          .run(resource,token,actor.pid,actor.startedAt);
        return {token};
      });
    },
    release(resource,token) { return sql.prepare('DELETE FROM actor_claims WHERE resource=? AND token=?').run(resource,token).changes===1; },
    close() { if(!closed){sql.close();closed=true;} },
  };
  return db;
}
