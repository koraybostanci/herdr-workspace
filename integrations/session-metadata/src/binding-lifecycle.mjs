import { randomUUID } from 'node:crypto';
import { sessionKey, bindingKey, decodeSession, decodeProof } from './protocol.mjs';
import { producerMatches } from './contracts.mjs';
import { processStamp } from './database.mjs';

const labelName = channel => channel==='plan'?'herdr.plan-binding':'herdr.meta-binding-v2';
export function createBindingLifecycle(db, {run, clock=Date.now}) {
  db.transaction(sql=>sql.exec(`
    CREATE TABLE IF NOT EXISTS channel_bindings (channel TEXT, binding_key TEXT, proof TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(channel,binding_key));
    CREATE TABLE IF NOT EXISTS registration_reservations (channel TEXT, binding_key TEXT, token TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(channel,binding_key));
    CREATE TABLE IF NOT EXISTS plan_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `));
  const current = (channel,key) => db.sql.prepare('SELECT * FROM channel_bindings WHERE channel=? AND binding_key=?').get(channel,key);
  const pending = (channel,key) => db.sql.prepare('SELECT * FROM registration_reservations WHERE channel=? AND binding_key=?').get(channel,key);
  const matchesReservation = reservation => {
    try {
      const row=pending(reservation.channel,bindingKey(reservation.terminal)),saved=row&&JSON.parse(row.data);
      return saved && saved.token===reservation.token && saved.sequence===reservation.sequence
        && saved.expectedGeneration===reservation.expectedGeneration && sessionKey(saved.session)===sessionKey(reservation.session)
        && bindingKey(saved.terminal)===bindingKey(reservation.terminal) && saved.producer.pid===reservation.producer.pid
        && saved.producer.startedAt===reservation.producer.startedAt;
    } catch {return false;}
  };
  const actor = {pid:process.pid, startedAt:processStamp(process.pid)};
  async function probe(proof, requireLabel=false) {
    if(!decodeProof(proof).ok || proof.coreHost!=='local')return null;
    const options={env:{HC_SESSION:proof.coreSession}};
    const response=await run('local','hc',['get',proof.terminal,'--json'],options);
    if(response.code!==0)return null;
    let terminal;try {terminal=JSON.parse(response.stdout);}catch{return null;}
    if(terminal.created_ms!==proof.createdMs || !terminal.labels?.['herdr.space'] || !terminal.labels?.['herdr.tab']
      || !await producerMatches(terminal,proof.processPid,run,options))return null;
    const stamp=await run('local','ps',['-o','lstart=','-p',String(proof.processPid)],options);
    if(stamp.code!==0 || stamp.stdout.trim()!==proof.processStartedAt)return null;
    if(requireLabel) {
      let label;try {label=JSON.parse(terminal.labels[labelName(proof.channel)]??'null');}catch{return null;}
      if(label?.key!==bindingKey(proof) || label.generation!==proof.generation || label.session!==sessionKey(proof.session) || label.epoch!==2)return null;
    }
    return terminal;
  }
  const lifecycle={
    async reserve({channel,session,terminal,producer,expectedGeneration=null}) {
      if(!['plan','metadata'].includes(channel) || !decodeSession(session).ok || !producer?.startedAt || !Number.isSafeInteger(producer.pid))return null;
      const key=bindingKey(terminal);
      return db.transaction(sql=>{
        const old=current(channel,key);
        const oldProof=old&&JSON.parse(old.proof);
        if((oldProof?.generation??null)!==expectedGeneration || old?.state==='uncertain')return null;
        sql.prepare("INSERT INTO plan_sequences VALUES ('registration',1) ON CONFLICT(name) DO UPDATE SET value=value+1").run();
        const sequence=sql.prepare("SELECT value FROM plan_sequences WHERE name='registration'").get().value;
        const reservation={channel,session,terminal,producer,expectedGeneration,sequence,token:randomUUID()};
        sql.prepare('INSERT INTO registration_reservations VALUES (?,?,?,?,?) ON CONFLICT(channel,binding_key) DO UPDATE SET token=excluded.token,sequence=excluded.sequence,data=excluded.data')
          .run(channel,key,reservation.token,sequence,JSON.stringify(reservation));
        return reservation;
      });
    },
    async commit(reservation,proof) {
      if(!reservation || !decodeProof(proof).ok || proof.channel!==reservation.channel || proof.generation!==reservation.token
        || sessionKey(proof.session)!==sessionKey(reservation.session) || bindingKey(proof)!==bindingKey(reservation.terminal)
        || proof.processPid!==reservation.producer.pid || proof.processStartedAt!==reservation.producer.startedAt)return false;
      const key=bindingKey(proof), channel=proof.channel;
      if(!matchesReservation(reservation) || !await probe(proof))return false;
      const resource=`registration:${channel}:${key}`, claim=db.claim(resource,actor);
      if(!claim)return false;
      try {
        if(!matchesReservation(reservation))return false;
        const label=JSON.stringify({key,generation:proof.generation,session:sessionKey(proof.session),epoch:2});
        const result=await run('local','hc',['label',proof.terminal,`${labelName(channel)}=${label}`],{env:{HC_SESSION:proof.coreSession}});
        const acknowledged=result.code===0 && await probe(proof,true);
        return db.transaction(sql=>{
          const valid=Boolean(acknowledged && matchesReservation(reservation) && clock()>=proof.verifiedAt && clock()<=proof.leaseUntil);
          sql.prepare('INSERT INTO channel_bindings VALUES (?,?,?,?) ON CONFLICT(channel,binding_key) DO UPDATE SET proof=excluded.proof,state=excluded.state')
            .run(channel,key,JSON.stringify(proof),valid?'active':'uncertain');
          return valid;
        });
      } finally {db.release(resource,claim.token);}
    },
    async verify(proof) {
      if(!decodeProof(proof).ok)return false;
      const row=current(proof.channel,bindingKey(proof));
      if(row?.state!=='active')return false;
      let saved;try {saved=JSON.parse(row.proof);}catch{return false;}
      if(!decodeProof(saved).ok || saved.generation!==proof.generation || sessionKey(saved.session)!==sessionKey(proof.session)
        || saved.processPid!==proof.processPid || saved.processStartedAt!==proof.processStartedAt
        || clock()<saved.verifiedAt || clock()>saved.leaseUntil)return false;
      return Boolean(await probe(saved,true));
    },
    async heartbeat(proof) {
      if(!await lifecycle.verify(proof))return null;
      const next={...proof,verifiedAt:clock(),leaseUntil:clock()+45000};
      return db.transaction(sql=>{
        const row=current(proof.channel,bindingKey(proof));
        if(row?.state!=='active' || JSON.parse(row.proof).generation!==proof.generation)return null;
        sql.prepare('UPDATE channel_bindings SET proof=? WHERE channel=? AND binding_key=?').run(JSON.stringify(next),proof.channel,bindingKey(proof));
        return next;
      });
    },
    async invalidate(identity,generation) {
      const {channel}=identity,key=bindingKey(identity),resource=`registration:${channel}:${key}`,claim=db.claim(resource,actor);
      if(!claim)return;
      try {
        db.sql.prepare('DELETE FROM registration_reservations WHERE channel=? AND binding_key=? AND token=?').run(channel,key,generation);
        const row=current(channel,key);if(!row || JSON.parse(row.proof).generation!==generation)return;
        // Invalidate locally before any uncertain core RPC; a stale label is never enough.
        db.sql.prepare("UPDATE channel_bindings SET state='invalid' WHERE channel=? AND binding_key=?").run(channel,key);
        const proof=JSON.parse(row.proof);
        if(await probe(proof,true))await run('local','hc',['label',proof.terminal,`${labelName(channel)}=`],{env:{HC_SESSION:proof.coreSession}});
        db.sql.prepare('DELETE FROM channel_bindings WHERE channel=? AND binding_key=? AND proof=?').run(channel,key,row.proof);
      } finally {db.release(resource,claim.token);}
    },
    current(channel,terminal) {const row=current(channel,bindingKey(terminal));return row&&JSON.parse(row.proof);},
    reservation(channel,terminal) {const row=pending(channel,bindingKey(terminal));return row&&JSON.parse(row.data);},
  };
  return lifecycle;
}
