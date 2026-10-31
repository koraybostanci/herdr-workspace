import { actorState, processStamp } from '../database.mjs';
import { readArtifact } from './artifacts.mjs';
import { getSubmission, getReviewMaterial, claimSubmission, updateDelivery } from './reviews.mjs';

export const reviewMessageId = requestId => 'msg_herdr_review_'+requestId.replaceAll('-','');
export function formatReview(submission, artifact) {
  const lines=[`Review feedback: ${artifact.kind==='design'?'Design':'Implementation plan'}`,`Document: ${artifact.path}`,
    `Host: ${artifact.host}`,`Session: ${submission.session.id} (${submission.session.authority})`,
    `Reviewed SHA-256: ${submission.documentHash}`,`Review ID: ${submission.requestId}`,'',
    'This is feedback, not approval to execute the implementation.',
    'Reread the current document and explain any changes. Preserve the original revision context below.',''];
  submission.comments.forEach((comment,index)=>{
    lines.push(`${index+1}. ${comment.anchor?comment.anchor.headingPath.join(' / '):'Whole document'}`,`   Original SHA-256: ${comment.documentHash}`);
    if(comment.anchor)lines.push('   Context:',...comment.anchor.excerpt.split('\n').map(line=>'   > '+line));
    lines.push('   Comment:',...comment.text.split('\n').map(line=>'   '+line),'');
  });
  return lines.join('\n');
}
export function previewReview(input,db) {
  const {artifact,comments}=getReviewMaterial(input,db);
  if(typeof input.documentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.documentHash))throw Error('invalid-review-revision');
  const preview={session:input.session,artifact,comments,documentHash:input.documentHash,
    earlierRevision:artifact.hash!==input.documentHash||comments.some(comment=>comment.documentHash!==input.documentHash)};
  return {...preview,text:formatReview({...preview,requestId:'draft'},artifact)};
}
function fail(submission,reason,deps) {
  updateDelivery(submission.requestId,submission.delivery.state,{state:'failed',requestId:submission.requestId,reason},deps.db);
  return getSubmission(submission.requestId,deps.db).delivery;
}
export async function dispatchReview(requestId, deps) {
  const submission=getSubmission(requestId,deps.db);
  if(submission.delivery.state==='sending'||submission.delivery.state==='unknown')return reconcileReview(requestId,deps);
  if(submission.delivery.state!=='pending')return submission.delivery;
  if(!await deps.enabled?.(submission.session,submission.proof) || typeof deps.provider?.admit!=='function')return fail(submission,'delivery-unavailable',deps);
  if(!await deps.lifecycle.verify(submission.proof))return fail(submission,'target-changed',deps);
  let document;
  try {document=await readArtifact({session:submission.session,id:submission.artifactId},{...deps,proof:submission.proof});}
  catch {return fail(submission,'document-unavailable',deps);}
  if(document.state!=='ready')return fail(submission,'document-unavailable',deps);
  if(document.artifact.hash!==submission.documentHash&&!submission.confirmedEarlierRevision)return fail(submission,'document-changed',deps);
  const text=formatReview(submission,document.artifact);
  if(Buffer.byteLength(text)>1048576)return fail(submission,'review-too-large',deps);
  if(!await deps.lifecycle.verify(submission.proof))return fail(submission,'target-changed',deps);
  const actor=deps.actor??{pid:process.pid,startedAt:processStamp(process.pid)};
  if(!actor.startedAt)return fail(submission,'helper-owner-unavailable',deps);
  if(!claimSubmission(requestId,actor,deps.db))return getSubmission(requestId,deps.db).delivery;
  const messageId=reviewMessageId(requestId);
  try {
    const result=await deps.provider.admit({session:submission.session,proof:submission.proof,messageId,text,resume:true,
      review:{requestId,artifactId:submission.artifactId,documentHash:submission.documentHash}});
    if(result?.id!==messageId||result.sessionID!==submission.session.id) {
      updateDelivery(requestId,'sending',{state:'unknown',requestId,reason:'invalid-acknowledgement'},deps.db);
    } else updateDelivery(requestId,'sending',{state:'accepted',requestId,providerId:messageId},deps.db);
  } catch(error) {
    updateDelivery(requestId,'sending',{state:error.definite===true?'failed':'unknown',requestId,
      reason:error.definite===true?'provider-rejected':'acknowledgement-unavailable'},deps.db);
  }
  return getSubmission(requestId,deps.db).delivery;
}
export async function reconcileReview(requestId, deps) {
  let submission=getSubmission(requestId,deps.db);
  if(submission.delivery.state==='sending') {
    const claim=deps.db.sql.prepare('SELECT pid,started_at FROM actor_claims WHERE resource=?').get('submission:'+requestId);
    if(claim&&(deps.actorState??actorState)({pid:claim.pid,startedAt:claim.started_at})!=='dead')return submission.delivery;
    updateDelivery(requestId,'sending',{state:'unknown',requestId,reason:'interrupted-sender'},deps.db);
    submission=getSubmission(requestId,deps.db);
  }
  if(submission.delivery.state!=='unknown'||!await deps.enabled?.(submission.session,submission.proof)||typeof deps.provider?.lookup!=='function')return submission.delivery;
  let receipt;
  try {receipt=await deps.provider.lookup({session:submission.session,proof:submission.proof,messageId:reviewMessageId(requestId),requestId});}
  catch {return submission.delivery;}
  if(receipt==='pending'||receipt==='delivered')updateDelivery(requestId,'unknown',{state:'accepted',requestId,providerId:reviewMessageId(requestId)},deps.db);
  // Missing receipts never prove that a timed-out admission did not happen. Explicit retry only.
  return getSubmission(requestId,deps.db).delivery;
}
