import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, Button, Popover, TextView, Textarea, TextareaState, Editor, EditorState } from 'gpui-base';
import { spaces, agents, panes, terminals, focused, theme, settings, appHome, readTextFile, watchFolder, shared, setShared, run } from 'herdr';
import { PlanClient } from './client.js';
import { ReviewDrafts } from './drafts.js';
import { selectPlanOwner, planAvailable, acceptPlanLoad, safePlanPresentation, allowedPlanUrl } from './model.js';
import { sessionKey, decodeSession, decodeProof, decodeArtifact, decodeComment, decodeAnchor, decodeDelivery } from './protocol.js';

const basename=path=>path?.replaceAll('\\','/').split('/').pop()??'Plan';
const documentKey=(owner,id)=>JSON.stringify([sessionKey(owner),id]);
const statusLabel={pending:'Queued',sending:'Sending',accepted:'Accepted by harness',failed:'Not sent',unknown:'Delivery unknown','waiting-next-prompt':'Waiting for next prompt'};
function stored(key){try{const value=JSON.parse(localStorage.getItem(key)??'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
function live(){const focus=focused(),all=spaces();return {focused:focus,space:all.find(s=>s.id===focus?.space)??all.find(s=>s.active),agents:agents(),panes:panes(),terminals:terminals()};}
function reviewContent(raw,ownerKey,artifactId) {
  const comments=(Array.isArray(raw?.comments)?raw.comments:[]).filter(comment=>decodeComment(comment).ok&&sessionKey(comment.session)===ownerKey&&comment.artifactId===artifactId);
  const submissions=(Array.isArray(raw?.submissions)?raw.submissions:[]).filter(sub=>decodeSession(sub?.session).ok&&sessionKey(sub.session)===ownerKey&&sub.artifactId===artifactId&&decodeDelivery(sub.delivery).ok&&sub.delivery.requestId===sub.requestId);
  return {comments,submissions};
}
function sameComments(expected,actual,ownerKey,artifactId) {
  return Array.isArray(expected)&&Array.isArray(actual)&&actual.length===expected.length&&actual.every(comment=>decodeComment(comment).ok
    &&sessionKey(comment.session)===ownerKey&&comment.artifactId===artifactId&&expected.some(original=>original.id===comment.id
      &&['revision','text','anchor','documentHash','status'].every(field=>JSON.stringify(original[field])===JSON.stringify(comment[field]))));
}

export default class Plan extends View {
  init(_props,cx) {
    this.client=new PlanClient();this.drafts=new ReviewDrafts(this.client);
    this.composer=TextareaState.new({placeholder:'Comment on this plan…',rows:3});this.composer.set_auto_grow(3,6);
    this.composer.on('change',(_event,cx)=>{if(this.editKey)this.drafts.change(this.editKey,{text:this.composer.value()});cx.notify();});
    this.sectionFocus=cx.focus_handle();this.sectionMenuFocus=cx.focus_handle();this.sendFocus=cx.focus_handle();
    this.planView=null;this.metadataReady=false;this.selection=null;this.context=null;this.epoch=0;this.loadId=0;this.closed=false;
    this.document=null;this.comments=[];this.submissions=[];this.sections=[];this.commentsOpen=true;this.error=null;this.loading=false;
    this.composers=stored('composers');this.watched=null;this.preview=null;this.sending=false;this.readSource=false;
    this.deliveries=new Map();
    this.sourceEditors=new Map();
    this.instance='plan-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);this.errorFingerprint='';
    this.reloadMetadata(cx);
    cx.spawn(async cx=>{
      try {while(!this.closed){const changed=await watchFolder(appHome()+'/data/session-plans');if(changed.some(path=>/view-v1\.json$|runtime\.json$/.test(path)))this.reloadMetadata(cx);}}
      catch {} // The always-mounted tabs controller also causes lease-expiry renders.
    });
    cx.timer.every(500,cx=>{this.flush(cx);this.publishErrors();});
  }
  reloadMetadata(cx) {
    cx.spawn(async cx=>{
      try {const raw=JSON.parse(await readTextFile(appHome()+'/data/session-plans/view-v1.json')??'null');if(!raw||raw.sequence>=(this.planView?.sequence??0))this.planView=raw;}
      catch {} finally {this.metadataReady=true;cx.notify();}
    });
  }
  publishErrors() {
    if(this.closed)return;
    const recovery=shared('session-plans.recovery');
    if(this.recoveryKey&&recovery?.instanceId===this.instance&&Date.now()-(recovery.seenAt??0)>=15000)
      setShared('session-plans.recovery',{...recovery,seenAt:Date.now()});
    const seenAt=Math.floor(Date.now()/15000)*15000;
    const own=this.drafts.failed().map(row=>({instanceId:this.instance,rowKey:row.key,owner:row.owner,artifactId:row.artifactId,title:row.title,seenAt}));
    const signature=JSON.stringify(own);if(signature===this.errorFingerprint)return;this.errorFingerprint=signature;
    const previous=Array.isArray(shared('session-plans.draft-errors'))?shared('session-plans.draft-errors'):[];
    setShared('session-plans.draft-errors',[...previous.filter(item=>item?.instanceId!==this.instance&&Date.now()-item.seenAt<45000),...own]);
  }
  flush(cx) {
    if(![...this.drafts.rows.values()].some(row=>row.dirty&&!row.pending&&!row.error))return;
    cx.spawn(async cx=>{
      await this.drafts.flushAll();this.rememberComposers();this.publishErrors();cx.notify();
    });
  }
  rememberComposers() {
    for(const row of this.drafts.rows.values())if(row.id&&!row.dirty&&!row.error&&this.drafts.active.get(row.document)===row.key)this.composers[row.document]=row.id;
    localStorage.setItem('composers',JSON.stringify(this.composers));
  }
  sync(cx) {
    const next=selectPlanOwner({...live(),planView:this.planView,previous:this.selection});
    const identity=value=>value?JSON.stringify([sessionKey(value.owner),value.proof.generation,value.space,value.tab]):null;
    if(identity(next)!==identity(this.selection))this.epoch++;
    this.selection=next?{...next,epoch:this.epoch}:null;
    const recovery=shared('session-plans.recovery');
    const recovering=recovery&&Date.now()>=(recovery.seenAt??0)&&Date.now()-(recovery.seenAt??0)<45000;
    this.foreignRecovery=Boolean(recovering&&recovery.instanceId!==this.instance);
    if(recovering&&recovery.instanceId===this.instance&&this.drafts.rows.has(recovery.rowKey)) {
      if(this.recoveryKey!==recovery.rowKey){
        this.context=null;this.loadId++;this.fingerprint=null;this.document=null;this.comments=[];this.sections=[];this.submissions=[];this.delivery=null;this.watched=null;
        this.recoveryKey=recovery.rowKey;this.editKey=recovery.rowKey;const row=this.drafts.rows.get(this.editKey);
        this.drafts.active.set(row.document,row.key);this.drafts.current=row.key;this.composer.set_value(row.text);
      }
      return;
    }
    this.recoveryKey=null;
    const choice=this.selection&&(this.selection.artifacts.find(a=>a.primary)??this.selection.artifacts[0]);
    if(!choice||!planAvailable(this.selection?.owner,this.selection?.artifacts)) {
      if(this.context){this.context=null;this.loadId++;this.document=null;this.comments=[];this.sections=[];this.editKey=null;this.preview=null;this.delivery=null;}
      return;
    }
    const fingerprint=JSON.stringify([sessionKey(this.selection.owner),this.selection.proof.generation,this.selection.epoch,choice.id,choice.revision,choice.hash]);
    if(fingerprint===this.fingerprint)return;
    this.fingerprint=fingerprint;this.preview=null;
    this.context={ownerKey:sessionKey(this.selection.owner),artifactId:choice.id,epoch:this.selection.epoch,loadId:++this.loadId};
    this.delivery=this.deliveries.get(documentKey(this.selection.owner,choice.id))??null;
    this.load(cx,choice);
  }
  load(cx,artifact=this.document?.artifact) {
    if(!this.context||!this.selection||!artifact)return;
    const token={...this.context},selection=this.selection;
    this.loading=true;this.error=null;
    if(this.document?.artifact.id!==artifact.id||sessionKey(this.document.artifact.session)!==token.ownerKey){this.document=null;this.comments=[];this.sections=[];this.editKey=null;}
    cx.spawn(async cx=>{
      const scope={session:selection.owner,proof:selection.proof,artifactId:artifact.id};
      const [source,review]=await Promise.all([this.client.call('read',{...scope,id:artifact.id}),this.client.call('comments',scope)]);
      if(!acceptPlanLoad(this.context,token)||this.closed)return;
      if(source.ok&&decodeArtifact(source.value?.artifact).ok&&sessionKey(source.value.artifact.session)===token.ownerKey&&source.value.artifact.id===token.artifactId
        &&['ready','missing','needs-verification','superseded','changed'].includes(source.value.state)
        &&(source.value.state!=='ready'||typeof source.value.text==='string')) {
        this.document=source.value;
        this.sections=(Array.isArray(source.value.sections)?source.value.sections:[]).filter(section=>decodeAnchor(this.anchor(section,source.value.artifact.hash)).ok);
        if(source.value.state==='ready'&&typeof source.value.text==='string') {
          this.presentation=safePlanPresentation(source.value.text);
          if(this.presentation.mode==='source'||this.readSource)this.prepareSourceEditor();
          this.watchDocument(source.value.artifact,cx);
        }
      } else {this.document=null;this.error=source.reason??'invalid-document-response';}
      if(review.ok) {
        const content=reviewContent(review.value,token.ownerKey,artifact.id);this.comments=content.comments;this.submissions=content.submissions;
      } else this.error=review.reason??'comments-unavailable';
      const currentArtifact=this.document?.artifact??artifact,key=documentKey(selection.owner,artifact.id);
      this.delivery=this.deliveries.get(key)??this.submissions[0]?.delivery??null;
      const remembered=this.comments.find(comment=>comment.id===this.composers[key]&&comment.status==='open');
      const row=this.drafts.select(selection.owner,currentArtifact,remembered??null);row.title=selection.title;
      this.editKey=row.key;this.composer.set_value(row.text);this.loading=false;this.publishErrors();cx.notify();
    });
  }
  watchDocument(artifact,cx) {
    if(artifact.host!=='local'||this.watched===artifact.path)return;
    this.watched=artifact.path;const path=artifact.path,directory=path.slice(0,path.lastIndexOf('/'));
    cx.spawn(async cx=>{
      try {while(this.watched===path&&!this.closed){const changed=await watchFolder(directory);if(changed.some(file=>file===path||file.endsWith('/'+basename(path)))){
        if(this.document?.artifact.path===path){this.context={...this.context,loadId:++this.loadId};this.load(cx);}
      }}}catch {}
    });
  }
  anchor(section,hash=this.document?.artifact.hash) {
    return {documentHash:hash,headingPath:section.headingPath,occurrence:section.occurrence,sectionHash:section.sectionHash,excerpt:section.excerpt};
  }
  button(id,label,action,t,disabled=false) {
    const token=this.context&&{...this.context},recovery=this.recoveryKey;
    return Button.new(id).h(28).px(8).rounded(5).border(1).border_color(t.border).text_size(12).text_color(disabled?t.dim:t.foreground)
      .bg(t.surface).hover(s=>s.bg(t.hover)).focus(s=>s.border_color(t.accent)).disabled(disabled)
      .when(id==='plan-send-review',button=>button.track_focus(this.sendFocus))
      .accessibility_label(label).on_click((_event,cx)=>{if(!disabled&&(!token||acceptPlanLoad(this.context,token))&&recovery===this.recoveryKey)action(cx);}).child(label);
  }
  menu(id,label,items,choose,trigger,content,t) {
    const open=this[id+'Open']??false;
    return Popover.new(id).open(open).anchor('bottom_left').track_focus(content)
      .on_open_change((value,cx)=>{this[id+'Open']=value;this[id+'Index']=0;if(!value)trigger.focus();cx.notify();})
      .trigger(Button.new(id+'-trigger').h(27).px(8).gap(5).rounded(5).border(1).border_color(t.border).text_size(12).text_color(t.foreground)
        .hover(s=>s.bg(t.hover)).focus(s=>s.border_color(t.accent)).track_focus(trigger).accessibility_label(label)
        .child(div().flex_1().min_w(0).truncate().child(label)).child(svg('mods/workspace-chrome/chevron-down.svg').size(11)))
      .content(v_flex().id(id+'-options').w(300).max_h(260).p(5).gap(2).bg(t.popover).rounded(7).overflow_y_scrollbar().track_focus(content)
        .on_key_down((event,cx)=>{
          if(!content.is_focused())return;const key=event.key??event.keystroke,index=this[id+'Index']??0;
          if(key==='up'||key==='down'){this[id+'Index']=(index+(key==='up'?items.length-1:1))%items.length;cx.stop_propagation();cx.notify();}
          else if((key==='enter'||key==='space')&&items[index]){choose(items[index],cx);this[id+'Open']=false;trigger.focus();cx.stop_propagation();cx.notify();}
        }).children(items.map((item,index)=>Button.new(id+'-'+index).min_h(29).px(8).py(5).rounded(4).text_size(12).text_color(t.foreground)
          .bg(index===(this[id+'Index']??0)?t.selected:t.popover).hover(s=>s.bg(t.hover)).focus(s=>s.border_color(t.accent))
          .accessibility_label(item.label).on_click((_event,cx)=>{choose(item,cx);this[id+'Open']=false;trigger.focus();cx.notify();})
          .child(div().w_full().child(item.label)))));
  }
  prepareSourceEditor() {
    if(this.document?.state!=='ready'||typeof this.document.text!=='string')return;
    const artifact=this.document.artifact,key=documentKey(artifact.session,artifact.id);let editor=this.sourceEditors.get(key);
    if(!editor){editor=EditorState.new({language:'markdown',readonly:true,soft_wrap:true,value:this.document.text,
      font_family:settings().font_family,font_size:12,line_numbers:true});this.sourceEditors.set(key,editor);}
    else if(editor.value()!==this.document.text)editor.set_value(this.document.text);
    this.sourceEditor=editor;
    if(this.sourceEditors.size>16){const old=[...this.sourceEditors.keys()].find(id=>id!==key);this.sourceEditors.get(old).release();this.sourceEditors.delete(old);}
  }
  toggleReader(cx) {
    this.readSource=!this.readSource;if(this.readSource)this.prepareSourceEditor();cx.notify();
  }
  pickSection(item,cx) {
    const row=this.drafts.rows.get(this.editKey);if(!row||this.document?.state!=='ready')return;
    const value={anchor:item.section?this.anchor(item.section):null,documentHash:this.document.artifact.hash};
    if(!row.text&&!row.id)Object.assign(row,value);else this.drafts.change(row.key,value);
    this.composer.focus();cx.notify();
  }
  edit(comment,cx) {
    const row=this.drafts.select(this.selection.owner,this.document.artifact,comment);this.editKey=row.key;
    this.composer.set_value(row.text);this.composer.focus();cx.notify();
  }
  resolveConflict(row,choice,cx) {
    cx.spawn(async cx=>{await this.drafts.resolve(row.key,choice);if(this.editKey===row.key&&!row.dirty)this.composer.set_value(row.text);this.rememberComposers();this.publishErrors();cx.notify();});
  }
  prepareReview(cx,copy=false,retryOf=null) {
    if(!this.context||!this.selection||this.recoveryKey)return;
    const token={...this.context},selection=this.selection,artifact=this.document?.artifact;
    if(!artifact)return;
    cx.spawn(async cx=>{
      await this.drafts.flushAll();this.rememberComposers();
      if(!acceptPlanLoad(this.context,token)||this.drafts.unsaved(selection.owner,artifact.id)){this.error='save-comments-first';cx.notify();return;}
      const review=await this.client.call('comments',{session:selection.owner,artifactId:artifact.id});
      if(!acceptPlanLoad(this.context,token)||!review.ok)return;
      const content=reviewContent(review.value,token.ownerKey,artifact.id);
      const accepted=new Set(content.submissions.filter(s=>s.delivery.state==='accepted').flatMap(s=>(Array.isArray(s.comments)?s.comments:[])
        .filter(c=>decodeComment(c).ok&&sessionKey(c.session)===token.ownerKey&&c.artifactId===artifact.id).map(c=>c.id+':'+c.revision)));
      const comments=content.comments.filter(c=>c.status==='open'&&c.text.trim()&&!accepted.has(c.id+':'+c.revision));
      if(!comments.length){this.error='no-new-comments';cx.notify();return;}
      const refs=comments.map(c=>({id:c.id,revision:c.revision}));
      const preview=await this.client.call('preview-review',{session:selection.owner,artifactId:artifact.id,documentHash:artifact.hash,comments:refs});
      if(!acceptPlanLoad(this.context,token)||!preview.ok){this.error=preview.reason??'review-unavailable';cx.notify();return;}
      if(!decodeSession(preview.value?.session).ok||sessionKey(preview.value.session)!==token.ownerKey||!decodeArtifact(preview.value.artifact).ok
        ||preview.value.artifact.id!==artifact.id||preview.value.documentHash!==artifact.hash||typeof preview.value.text!=='string'
        ||typeof preview.value.earlierRevision!=='boolean'||!sameComments(comments,preview.value.comments,token.ownerKey,artifact.id)){
        this.error='invalid-review-response';cx.notify();return;
      }
      if(copy)cx.write_to_clipboard(preview.value.text);
      else this.preview={...preview.value,token,refs,selection,retryOf,duplicateWarning:Boolean(retryOf)};
      this.error=null;cx.notify();
    });
  }
  confirmReview(cx) {
    const preview=this.preview;
    if(!preview||this.sending||!acceptPlanLoad(this.context,preview.token)||!this.selection?.capabilities.send)return;
    this.sending=true;
    cx.spawn(async cx=>{
      const submitted=await this.client.call('submit',{session:preview.selection.owner,proof:preview.selection.proof,artifactId:preview.artifact.id,
        documentHash:preview.documentHash,comments:preview.refs,confirmed:true,confirmedEarlierRevision:preview.earlierRevision===true,
        retryOf:preview.retryOf??undefined,confirmedRetry:Boolean(preview.retryOf)});
      const batch=submitted.value;
      const valid=submitted.ok&&decodeSession(batch?.session).ok&&sessionKey(batch.session)===preview.token.ownerKey&&batch.artifactId===preview.artifact.id
        &&batch.documentHash===preview.documentHash&&decodeProof(batch.proof).ok&&sessionKey(batch.proof.session)===preview.token.ownerKey
        &&decodeDelivery(batch.delivery).ok&&batch.delivery.requestId===batch.requestId
        &&sameComments(preview.comments,batch.comments,preview.token.ownerKey,preview.artifact.id)
        &&(batch.delivery.state!=='pending'||batch.proof.generation===preview.selection.proof.generation);
      if(valid) {
        const result=await this.client.call('dispatch',{session:preview.selection.owner,requestId:submitted.value.requestId});
        const delivery=result.ok?result.value:{state:'unknown',requestId:submitted.value.requestId};
        if(decodeDelivery(delivery).ok&&delivery.requestId===submitted.value.requestId) {
          this.deliveries.set(documentKey(preview.selection.owner,preview.artifact.id),delivery);
          if(acceptPlanLoad(this.context,preview.token))this.delivery=delivery;
        }
      } else if(acceptPlanLoad(this.context,preview.token))this.error=submitted.reason??'invalid-submission-response';
      this.sending=false;if(acceptPlanLoad(this.context,preview.token)){this.preview=null;this.sendFocus.focus();}cx.notify();
    });
  }
  checkReceipt(cx) {
    if(!this.context||!this.selection||!this.delivery)return;
    const token={...this.context},selection=this.selection,requestId=this.delivery.requestId;
    cx.spawn(async cx=>{
      const result=await this.client.call('receipt',{session:selection.owner,requestId,reconcile:true});
      if(result.ok&&decodeDelivery(result.value).ok&&result.value.requestId===requestId){
        this.deliveries.set(documentKey(selection.owner,token.artifactId),result.value);
        if(acceptPlanLoad(this.context,token))this.delivery=result.value;
      }
      cx.notify();
    });
  }
  render(cx) {
    this.sync(cx);const t=theme(),row=this.drafts.rows.get(this.editKey),recovery=this.recoveryKey&&row;
    const artifact=recovery?row.artifact:this.document?.artifact;
    const owner=recovery?row.owner:this.selection?.owner;
    const ready=this.document?.state==='ready'&&!recovery;
    const label=artifact?.kind==='design'?'Design':'Implementation plan';
    const failure=this.error&&({'save-comments-first':'Save or resolve the selected comments first.','no-new-comments':'Add a new comment before reviewing.'}[this.error]??'This plan is unavailable. Retry to reload it.');
    return v_flex().id('session-plan').size_full().min_h(0).min_w(0).rounded(10).overflow_hidden().bg(t.background).border(1).border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).px(12).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
        .child(svg('mods/plan/plan.svg').size(15).text_color(t.muted)).child(div().font_medium().child(recovery?'Draft recovery':'Plan'))
        .child(div().flex_1())
        .when(ready&&this.presentation?.mode==='markdown',part=>part.child(this.button('plan-reader-mode',this.readSource?'Formatted':'Source',cx=>this.toggleReader(cx),t)))
        .child(this.button('plan-refresh','Refresh',cx=>{this.reloadMetadata(cx);if(this.context){this.context={...this.context,loadId:++this.loadId};this.load(cx);}},t)))
      .when(Boolean(owner),el=>el.child(v_flex().px(12).py(8).gap(4).flex_none().border_b(1).border_color(t.border)
        .child(div().id('plan-session').text_size(11.5).text_color(t.muted).truncate().accessibility_label(`Session ${owner.id}, ${owner.authority}, ${owner.host}`)
          .tooltip(`${owner.id} · ${owner.authority} · ${owner.host}`).child(recovery?row.title:this.selection.title))
        .when(Boolean(artifact),part=>part.child(div().text_size(11).text_color(t.muted).truncate().tooltip(`${artifact.path}\n${artifact.host} · SHA-256 ${artifact.hash}`).child(`${label} · ${basename(artifact.path)}`)))))
      .when(Boolean(failure),el=>el.child(div().px(12).py(8).text_size(12).text_color(t.blocked).child(failure)))
      .when(!recovery,el=>el.child(v_flex().id('plan-reader').flex_1().min_h(90).min_w(0)
        .when(ready&&this.presentation?.mode==='markdown'&&!this.readSource,part=>part.child(v_flex().id('plan-reader-scroll-'+this.context?.ownerKey+'-'+artifact?.id).flex_1().min_h(0).p(12).overflow_y_scrollbar()
          .child(TextView.markdown('plan-document',this.document.text).selectable(true).scrollable(false).w_full().on_link_click((url,cx)=>{if(allowedPlanUrl(url))cx.open_url(url);}))))
        .when(ready&&(this.presentation?.mode==='source'||this.readSource),part=>part.child(div().id('plan-source-note').px(12).py(5).text_size(11).text_color(t.muted).child(this.presentation?.mode==='source'?'Source view · embedded markup is disabled':'Read-only source · select and copy text here'))
          .child(Editor.new(this.sourceEditor).id('plan-source').flex_1().min_h(0)))
        .when(!ready,part=>part.child(div().p(12).text_size(12).text_color(t.muted).child(this.loading?'Loading plan…':this.document?.state==='missing'?'This plan file is missing. Your comments are kept.':this.document?.state==='needs-verification'?'The file target changed. Register it again before review.':'Select an agent with a registered plan.')))))
      .when(Boolean(row),el=>el.child(v_flex().flex_none().min_w(0).border_t(1).border_color(t.border).bg(t.surface).px(12).py(8).gap(7)
        .child(h_flex().items_center().gap(8).child(this.button('plan-comments-toggle',`Review comments (${this.comments.length})`,cx=>{this.commentsOpen=!this.commentsOpen;cx.notify();},t))
          .child(div().flex_1()).child(this.button('plan-new-comment','New comment',cx=>{const next=this.drafts.newComment(this.selection.owner,artifact);this.editKey=next.key;delete this.composers[next.document];localStorage.setItem('composers',JSON.stringify(this.composers));this.composer.set_value('');this.composer.focus();cx.notify();},t,Boolean(recovery))))
        .when(this.commentsOpen,part=>part
          .child(v_flex().max_h(120).overflow_y_scrollbar().gap(6).children(this.comments.filter(c=>c.id!==row.id).map(comment=>v_flex().id('plan-comment-'+comment.id).py(5).gap(4).border_b(1).border_color(t.border)
            .child(div().text_size(11).text_color(t.muted).child(comment.anchor?comment.anchor.headingPath.join(' / '):'Whole document'))
            .child(div().text_size(12).child(comment.text)).child(h_flex().gap(6).child(this.button('plan-edit-'+comment.id,'Edit',cx=>this.edit(comment,cx),t))
              .child(this.button('plan-resolve-'+comment.id,comment.status==='resolved'?'Reopen':'Resolve',cx=>{const edit=this.drafts.select(this.selection.owner,artifact,comment);this.drafts.change(edit.key,{status:comment.status==='resolved'?'open':'resolved'});this.flush(cx);},t))))))
          .when(!recovery,part=>part.child(this.menu('plan-sections',row.anchor?row.anchor.headingPath.join(' / '):'Whole document',[{label:'Whole document',section:null},...this.sections.map(section=>({label:section.headingPath.join(' / '),section}))],(item,cx)=>this.pickSection(item,cx),this.sectionFocus,this.sectionMenuFocus,t)))
          .child(Textarea.new(this.composer).id('plan-composer').w_full().min_h(70).max_h(140).p(8).rounded(6).border(1).border_color(t.input).bg(t.background).accessibility_label('Plan review comment'))
          .child(div().text_size(11).text_color(row.error?t.blocked:t.muted).child(row.error?'Save failed · your text is kept':row.pending||row.dirty?'Saving…':row.id?'Saved':'Draft'))
          .when(Boolean((row.text||row.id)&&artifact&&row.documentHash!==artifact.hash),part=>part.child(div().text_size(11).text_color(t.blocked).child(row.anchor?'Earlier revision · needs recheck':'Earlier revision')))
          .when(Boolean(row.conflict),part=>part.child(div().text_size(12).text_color(t.blocked).child('This comment changed in another window.'))
            .child(h_flex().gap(6).child(this.button('plan-conflict-mine','Keep my text',cx=>this.resolveConflict(row,'mine',cx),t))
              .child(this.button('plan-conflict-current','Use saved text',cx=>this.resolveConflict(row,'current',cx),t))))
          .when(Boolean(row.error&&!row.conflict),part=>part.child(h_flex().gap(6).child(this.button('plan-retry-save','Retry saving',cx=>{cx.spawn(async cx=>{await this.drafts.retry(row.key);this.rememberComposers();this.publishErrors();cx.notify();});},t))
            .child(this.button('plan-copy-draft','Copy draft',cx=>cx.write_to_clipboard(row.text),t)))))
        .child(h_flex().gap(6).items_center().child(this.button('plan-copy-review',recovery?'Copy draft':'Copy review',cx=>recovery?cx.write_to_clipboard(row.text):this.prepareReview(cx,true),t))
          .child(this.button('plan-send-review','Send review',cx=>this.prepareReview(cx),t,!ready||!this.selection?.capabilities.send||this.sending||Boolean(recovery))))
        .when(!recovery&&!this.selection?.capabilities.send,part=>part.child(div().text_size(11).text_color(t.muted).child('Agent delivery is not verified. Copy review is available.')))
        .when(Boolean(this.delivery),part=>part.child(div().text_size(11).text_color(t.muted).child(statusLabel[this.delivery.state]??'Delivery unavailable')))
        .when(Boolean(!recovery&&this.delivery&&['pending','sending','unknown'].includes(this.delivery.state)),part=>part.child(this.button('plan-check-review','Check status',cx=>this.checkReceipt(cx),t)))
        .when(Boolean(!recovery&&this.delivery&&['pending','failed','unknown'].includes(this.delivery.state)),part=>part.child(this.button('plan-retry-review','Retry review',cx=>this.prepareReview(cx,false,this.delivery.requestId),t,this.sending||!ready||!this.selection?.capabilities.send)))
        .when(Boolean(recovery),part=>part.child(this.button('plan-end-recovery','Return to selected agent',cx=>{setShared('session-plans.recovery',null);this.recoveryKey=null;this.fingerprint=null;cx.notify();},t)))))
      .when(Boolean(this.preview),el=>el.child(v_flex().px(12).py(10).gap(7).flex_none().border_t(1).border_color(t.border).bg(t.raised)
        .child(div().font_medium().child(`Send ${this.preview.refs.length} comment${this.preview.refs.length===1?'':'s'}?`))
        .child(div().text_size(11.5).child(`To ${this.preview.selection.title} · ${this.preview.selection.owner.id}`))
        .child(div().text_size(11).text_color(t.muted).tooltip(this.preview.documentHash).child(`Reviewed revision ${this.preview.documentHash.slice(0,12)}`))
        .child(v_flex().max_h(110).overflow_y_scrollbar().gap(5).children(this.preview.comments.map(comment=>div().text_size(12).child(comment.text))))
        .child(div().text_size(11).text_color(t.muted).child('This queues feedback and may start an agent turn. It does not approve implementation.'))
        .when(this.preview.earlierRevision,part=>part.child(div().text_size(11).text_color(t.blocked).child('The plan changed. This review includes earlier-revision comments.')))
        .when(this.preview.duplicateWarning,part=>part.child(div().text_size(11).text_color(t.blocked).child('This review may already have reached the agent. Retrying can send duplicates.')))
        .child(h_flex().gap(6).child(this.button('plan-cancel-send','Cancel',cx=>{this.preview=null;this.sendFocus.focus();cx.notify();},t))
          .child(this.button('plan-confirm-send',this.preview.earlierRevision?'Send earlier review':'Send review',cx=>this.confirmReview(cx),t,this.sending)))));
  }
  async close() {
    this.closed=true;this.watched=null;this.composer.release();for(const editor of this.sourceEditors.values())editor.release();
    for(const handle of [this.sectionFocus,this.sectionMenuFocus,this.sendFocus])handle.release();
    await this.drafts.flushAll();
  }
}
