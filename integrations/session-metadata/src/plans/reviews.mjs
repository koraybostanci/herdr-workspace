import { createHash, randomUUID } from 'node:crypto';
import { sessionKey, decodeArtifact, decodeComment, decodeProof, decodeDelivery } from '../protocol.mjs';

const initialized = new WeakSet();
const digest = value => createHash('sha256').update(value).digest('hex');
function schema(db) {
  if (initialized.has(db)) return;
  db.transaction(sql => sql.exec(`
    CREATE TABLE IF NOT EXISTS plan_comments (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY(artifact_id) REFERENCES plan_artifacts(id));
    CREATE TABLE IF NOT EXISTS plan_comment_conflicts (id TEXT PRIMARY KEY, attempt_key TEXT NOT NULL UNIQUE,
      comment_id TEXT NOT NULL, session_key TEXT NOT NULL, artifact_id TEXT NOT NULL, attempt TEXT NOT NULL,
      observed_current TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(comment_id) REFERENCES plan_comments(id));
    CREATE TABLE IF NOT EXISTS plan_submissions (request_id TEXT PRIMARY KEY, batch_key TEXT NOT NULL UNIQUE,
      session_key TEXT NOT NULL, artifact_id TEXT NOT NULL, data TEXT NOT NULL, delivery TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES plan_artifacts(id));
    CREATE TABLE IF NOT EXISTS plan_submission_comments (request_id TEXT NOT NULL, comment_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(request_id,comment_id), FOREIGN KEY(request_id) REFERENCES plan_submissions(request_id));
    CREATE TABLE IF NOT EXISTS plan_submission_claims (request_id TEXT PRIMARY KEY, token TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES plan_submissions(request_id));
  `));
  initialized.add(db);
}
function artifactFor(session, id, db) {
  const row = db.sql.prepare('SELECT data FROM plan_artifacts WHERE session_key=? AND id=?').get(sessionKey(session), id);
  let artifact;
  try { artifact = row && JSON.parse(row.data); } catch { throw Error('artifact-unavailable'); }
  if (!decodeArtifact(artifact).ok || sessionKey(artifact.session) !== sessionKey(session) || artifact.id !== id) throw Error('artifact-unavailable');
  return artifact;
}
function commentFor(session, artifactId, id, db) {
  const row = db.sql.prepare('SELECT data FROM plan_comments WHERE session_key=? AND artifact_id=? AND id=?').get(sessionKey(session), artifactId, id);
  if (!row) return null;
  const comment = JSON.parse(row.data);
  if (!decodeComment(comment).ok || sessionKey(comment.session) !== sessionKey(session) || comment.artifactId !== artifactId || comment.id !== id) throw Error('comment-unavailable');
  return comment;
}
function sameCommentOwner(comment,session,artifactId,id) {
  return decodeComment(comment).ok && sessionKey(comment.session)===sessionKey(session) && comment.artifactId===artifactId && comment.id===id;
}
export function saveComment(input, db) {
  schema(db);
  const {session,artifactId,expectedRevision} = input;
  artifactFor(session, artifactId, db);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw Error('invalid-comment-revision');
  return db.transaction(sql => {
    const id = input.id ?? randomUUID(), current = commentFor(session, artifactId, id, db);
    if (!current && sql.prepare('SELECT id FROM plan_comments WHERE id=?').get(id)) throw Error('comment-unavailable');
    const comment = {id,artifactId,session,revision:expectedRevision === null ? 0 : expectedRevision+1,
      text:input.text,anchor:input.anchor,status:input.status,documentHash:input.documentHash};
    if (!decodeComment(comment).ok || comment.anchor && comment.anchor.documentHash !== comment.documentHash) throw Error('invalid-comment');
    if (current && current.revision !== expectedRevision) {
      const attemptKey = digest(JSON.stringify([sessionKey(session),artifactId,id,expectedRevision,comment]));
      sql.prepare('INSERT OR IGNORE INTO plan_comment_conflicts VALUES (?,?,?,?,?,?,?,0)').run(randomUUID(), attemptKey, id, sessionKey(session), artifactId,
        JSON.stringify(comment), JSON.stringify(current));
      const conflictId = sql.prepare('SELECT id FROM plan_comment_conflicts WHERE attempt_key=?').get(attemptKey).id;
      return {state:'conflict',current,attempt:comment,conflictId};
    }
    if (!current && expectedRevision !== null) throw Error('comment-revision-conflict');
    sql.prepare('INSERT INTO plan_comments VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data')
      .run(id, sessionKey(session), artifactId, comment.revision, JSON.stringify(comment));
    return {state:'saved',comment};
  });
}
export function listComments({session,artifactId}, db) {
  schema(db); artifactFor(session,artifactId,db);
  return db.sql.prepare('SELECT id FROM plan_comments WHERE session_key=? AND artifact_id=? ORDER BY rowid').all(sessionKey(session),artifactId)
    .flatMap(row => { try { return [commentFor(session,artifactId,row.id,db)]; } catch { return []; } });
}
export function listCommentConflicts({session,artifactId}, db) {
  schema(db); artifactFor(session,artifactId,db);
  return db.sql.prepare('SELECT * FROM plan_comment_conflicts WHERE session_key=? AND artifact_id=? AND resolved=0 ORDER BY rowid').all(sessionKey(session),artifactId)
    .flatMap(row => {
      try {
        const attempt=JSON.parse(row.attempt),observedCurrent=JSON.parse(row.observed_current),current=commentFor(session,artifactId,row.comment_id,db);
        if (!sameCommentOwner(attempt,session,artifactId,row.comment_id) || !sameCommentOwner(observedCurrent,session,artifactId,row.comment_id) || !current) return [];
        return [{id:row.id,attempt,current,observedCurrent}];
      } catch { return []; }
    });
}
export function resolveCommentConflict({session,artifactId,conflictId,choice,expectedRevision,replacement}, db) {
  schema(db); artifactFor(session,artifactId,db);
  return db.transaction(sql => {
    const row=sql.prepare('SELECT * FROM plan_comment_conflicts WHERE id=? AND session_key=? AND artifact_id=? AND resolved=0').get(conflictId,sessionKey(session),artifactId);
    if (!row || !['mine','current'].includes(choice)) throw Error('conflict-unavailable');
    const current=commentFor(session,artifactId,row.comment_id,db),attempt=JSON.parse(row.attempt);
    if (!current || !sameCommentOwner(attempt,session,artifactId,row.comment_id)) throw Error('conflict-unavailable');
    if (current.revision !== expectedRevision) return {state:'conflict',current,attempt,conflictId};
    if(replacement && (typeof replacement!=='object'||Array.isArray(replacement)
      ||Object.keys(replacement).some(key=>!['text','anchor','documentHash','status'].includes(key))))throw Error('invalid-conflict-replacement');
    const result = choice === 'mine' ? saveComment({...attempt,...replacement,expectedRevision},db) : {state:'saved',comment:current};
    if (result.state === 'saved') sql.prepare('UPDATE plan_comment_conflicts SET resolved=1 WHERE id=?').run(conflictId);
    return result;
  });
}
export function getReviewMaterial(input,db) {
  schema(db);
  return db.transaction(()=>{
    const artifact=artifactFor(input.session,input.artifactId,db),refs=input.comments;
    if(!Array.isArray(refs)||refs.length===0||new Set(refs.map(ref=>ref?.id)).size!==refs.length)throw Error('comments-required');
    const comments=refs.map(ref=>{
      const comment=commentFor(input.session,input.artifactId,ref?.id,db);
      if(!comment||comment.revision!==ref.revision||comment.status!=='open'||!comment.text.trim())throw Error('comment-revision-conflict');
      return comment;
    });
    return {artifact,comments};
  });
}
export function createSubmission(input, db) {
  schema(db);
  if (input.confirmed !== true) throw Error('review-confirmation-required');
  if (!decodeProof(input.proof).ok || input.proof.channel !== 'plan' || sessionKey(input.proof.session) !== sessionKey(input.session)) throw Error('invalid-review-owner');
  return db.transaction(sql => {
    const {artifact,comments}=getReviewMaterial(input,db);
    if (typeof input.documentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.documentHash)) throw Error('invalid-review-revision');
    if ((artifact.hash !== input.documentHash || comments.some(c=>c.documentHash!==input.documentHash)) && input.confirmedEarlierRevision !== true) throw Error('stale-review');
    let retryOf='';
    if (input.retryOf) {
      const original=getSubmission(input.retryOf,db);
      if (input.confirmedRetry !== true || sessionKey(original.session)!==sessionKey(input.session) || original.artifactId!==input.artifactId) throw Error('resend-confirmation-required');
      retryOf=original.requestId;
    }
    const versions=comments.map(c=>[c.id,c.revision]).sort((a,b)=>a[0].localeCompare(b[0]));
    const batchKey=digest(JSON.stringify([sessionKey(input.session),input.artifactId,input.documentHash,versions,retryOf]));
    const previous=sql.prepare('SELECT request_id FROM plan_submissions WHERE batch_key=?').get(batchKey);
    if (previous) return getSubmission(previous.request_id,db);
    const requestId=randomUUID(),delivery={state:'pending',requestId};
    const data={requestId,batchKey,session:input.session,artifactId:input.artifactId,documentHash:input.documentHash,
      proof:input.proof,confirmedEarlierRevision:input.confirmedEarlierRevision===true,retryOf};
    sql.prepare('INSERT INTO plan_submissions VALUES (?,?,?,?,?,?)').run(requestId,batchKey,sessionKey(input.session),input.artifactId,JSON.stringify(data),JSON.stringify(delivery));
    for (const comment of comments) sql.prepare('INSERT INTO plan_submission_comments VALUES (?,?,?)').run(requestId,comment.id,JSON.stringify(comment));
    return {...data,comments,delivery};
  });
}
export function getSubmission(requestId, db) {
  schema(db);
  const row=db.sql.prepare('SELECT * FROM plan_submissions WHERE request_id=?').get(requestId);
  if (!row) throw Error('submission-unavailable');
  const data=JSON.parse(row.data),delivery=JSON.parse(row.delivery);
  const comments=db.sql.prepare('SELECT data FROM plan_submission_comments WHERE request_id=? ORDER BY comment_id').all(requestId).map(r=>JSON.parse(r.data));
  if (data.requestId!==requestId || sessionKey(data.session)!==row.session_key || data.artifactId!==row.artifact_id
    || !decodeDelivery(delivery).ok || delivery.requestId!==requestId || !decodeProof(data.proof).ok || data.proof.channel!=='plan'
    || sessionKey(data.proof.session)!==row.session_key || typeof data.confirmedEarlierRevision!=='boolean' || typeof data.retryOf!=='string'
    || !/^[a-f0-9]{64}$/.test(data.batchKey??'') || !/^[a-f0-9]{64}$/.test(data.documentHash??'')
    || Object.keys(data).some(k=>!['requestId','batchKey','session','artifactId','documentHash','proof','confirmedEarlierRevision','retryOf'].includes(k))
    || comments.length===0 || comments.some(c=>!decodeComment(c).ok || sessionKey(c.session)!==row.session_key || c.artifactId!==row.artifact_id)) throw Error('submission-unavailable');
  return {...data,comments,delivery};
}
export function listSubmissions({session,artifactId}, db) {
  schema(db); artifactFor(session,artifactId,db);
  return db.sql.prepare('SELECT request_id FROM plan_submissions WHERE session_key=? AND artifact_id=? ORDER BY rowid DESC').all(sessionKey(session),artifactId)
    .flatMap(row=>{try{return [getSubmission(row.request_id,db)];}catch{return [];}});
}
export function updateDelivery(requestId, expectedState, delivery, db) {
  schema(db);
  const allowed={pending:['sending','failed','unknown','waiting-next-prompt'],sending:['accepted','failed','unknown','waiting-next-prompt'],
    unknown:['accepted','failed','waiting-next-prompt'],'waiting-next-prompt':['accepted','failed','unknown']};
  if (!decodeDelivery(delivery).ok || delivery.requestId!==requestId || !allowed[expectedState]?.includes(delivery.state)) throw Error('invalid-delivery-state');
  return db.transaction(sql=>{
    const row=sql.prepare('SELECT delivery FROM plan_submissions WHERE request_id=?').get(requestId);
    if (!row || JSON.parse(row.delivery).state!==expectedState) return false;
    sql.prepare('UPDATE plan_submissions SET delivery=? WHERE request_id=? AND delivery=?').run(JSON.stringify(delivery),requestId,row.delivery);
    if (delivery.state!=='sending') {
      const claim=sql.prepare('SELECT token FROM plan_submission_claims WHERE request_id=?').get(requestId);
      if (claim) db.release('submission:'+requestId,claim.token);
      sql.prepare('DELETE FROM plan_submission_claims WHERE request_id=?').run(requestId);
    }
    return true;
  });
}
export function claimSubmission(requestId, actor, db) {
  schema(db);
  const claim=db.claim('submission:'+requestId,actor);
  if (!claim) return false;
  let keepClaim=false;
  try {
    const claimed=db.transaction(sql=>{
      const submission=getSubmission(requestId,db);
      if (submission.delivery.state==='sending') {
        updateDelivery(requestId,'sending',{state:'unknown',requestId,reason:'interrupted-sender'},db);
        return false;
      }
      if (submission.delivery.state!=='pending') return false;
      sql.prepare('INSERT OR REPLACE INTO plan_submission_claims VALUES (?,?)').run(requestId,claim.token);
      return updateDelivery(requestId,'pending',{state:'sending',requestId},db);
    });
    keepClaim=claimed;
    return claimed;
  } finally {
    if (!keepClaim) db.release('submission:'+requestId,claim.token);
  }
}
