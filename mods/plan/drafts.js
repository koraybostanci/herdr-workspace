import { sessionKey, decodeComment } from './protocol.js';

const docKey=(owner,artifactId)=>JSON.stringify([sessionKey(owner),artifactId]);
const ownComment=(comment,row)=>decodeComment(comment).ok&&sessionKey(comment.session)===sessionKey(row.owner)&&comment.artifactId===row.artifactId;
export class ReviewDrafts {
  constructor(client){this.client=client;this.rows=new Map();this.active=new Map();this.counter=0;}
  select(owner,artifact,comment=null) {
    if(comment&&!ownComment(comment,{owner,artifactId:artifact.id}))throw Error('comment-owner-mismatch');
    const document=docKey(owner,artifact.id);
    const found=comment?[...this.rows.values()].find(row=>row.document===document&&row.id===comment.id):this.rows.get(this.active.get(document));
    if(found){this.current=found.key;this.active.set(document,found.key);return found;}
    const key='draft-'+(++this.counter);
    const row={key,document,owner,artifactId:artifact.id,artifact,title:owner.id,id:comment?.id??null,revision:comment?.revision??null,
      text:comment?.text??'',anchor:comment?.anchor??null,documentHash:comment?.documentHash??artifact.hash,status:comment?.status??'open',
      seq:0,dirty:false,pending:false,error:null,conflict:null,work:null};
    this.rows.set(key,row);this.active.set(document,key);this.current=key;return row;
  }
  newComment(owner,artifact){this.active.delete(docKey(owner,artifact.id));return this.select(owner,artifact);}
  change(key,changes) {
    const row=this.rows.get(key);if(!row)return;
    let changed=false;
    for(const field of ['text','anchor','documentHash','status'])if(Object.hasOwn(changes,field)&&JSON.stringify(row[field])!==JSON.stringify(changes[field])){row[field]=changes[field];changed=true;}
    if(changed){row.seq++;row.dirty=true;}
  }
  payload(row){return {session:row.owner,artifactId:row.artifactId,id:row.id??undefined,expectedRevision:row.revision,
    text:row.text,anchor:row.anchor,documentHash:row.documentHash,status:row.status};}
  apply(row,result,sequence,discardLocal=false,expected=null) {
    if(!result?.ok){row.error=result?.reason??'save-failed';if(result?.commentId&&!row.id)row.id=result.commentId;return;}
    const value=result.value;
    if(value?.state==='conflict'&&ownComment(value.current,row)&&ownComment(value.attempt,row)
      &&value.current.id===value.attempt.id&&(!row.id||value.current.id===row.id)&&typeof value.conflictId==='string'){
      row.error='conflict';row.conflict=value;row.id=value.current.id;return;
    }
    const comment=value?.comment;
    if(value?.state!=='saved'||!ownComment(comment,row)||row.id&&comment.id!==row.id
      ||!discardLocal&&expected&&['text','anchor','documentHash','status'].some(field=>JSON.stringify(comment[field])!==JSON.stringify(expected[field]))){row.error='invalid-save-response';return;}
    row.id=comment.id;row.revision=comment.revision;row.error=null;row.conflict=null;
    if(discardLocal&&row.seq===sequence){row.text=comment.text;row.anchor=comment.anchor;row.documentHash=comment.documentHash;row.status=comment.status;}
    row.dirty=row.seq!==sequence;
  }
  flush(key) {
    const row=this.rows.get(key);if(!row)return Promise.resolve();
    if(row.pending)return row.work;
    if(!row.dirty||row.error)return Promise.resolve();
    const sequence=row.seq,payload=this.payload(row);row.pending=true;
    row.work=(async()=>{
      try{this.apply(row,await this.client.call('save-comment',payload),sequence,false,payload);}
      catch{row.error='save-failed';}
      finally{row.pending=false;row.work=null;}
    })();
    return row.work;
  }
  flushAll(){return Promise.all([...this.rows.values()].filter(row=>row.dirty&&!row.pending&&!row.error).map(row=>this.flush(row.key)));}
  retry(key){const row=this.rows.get(key);if(row){row.error=null;row.conflict=null;}return this.flush(key);}
  async resolve(key,choice) {
    const row=this.rows.get(key);if(!row?.conflict||row.pending)return;
    const conflict=row.conflict,sequence=row.seq;row.pending=true;
    try {
      const replacement={text:row.text,anchor:row.anchor,documentHash:row.documentHash,status:row.status};
      const result=await this.client.call('resolve-conflict',{session:row.owner,artifactId:row.artifactId,conflictId:conflict.conflictId,
        choice,expectedRevision:conflict.current.revision,replacement});
      this.apply(row,result,sequence,choice==='current',replacement);
    } catch {row.error='save-failed';}
    finally{row.pending=false;}
  }
  failed(){return [...this.rows.values()].filter(row=>row.error);}
  unsaved(owner,artifactId){const key=docKey(owner,artifactId);return [...this.rows.values()].some(row=>row.document===key&&(row.dirty||row.pending||row.error));}
}
