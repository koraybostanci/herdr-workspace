import { div } from 'gpui-kit';
import { v_flex, h_flex, Editor, EditorState, Button } from 'gpui-base';
import { spaces, agents, panes, terminals, focused, appHome, readTextFile, watchFolder, settings, theme } from 'herdr';
import { PlanClient } from './client.js';
import { selectPlanOwner, acceptPlanLoad } from './model.js';
import { decodeSession, decodeArtifact, sessionKey } from './protocol.js';

export class PlanFile {
  init(target,cx) {
    this.target=target;this.client=new PlanClient();this.closed=false;this.epoch=0;this.loadId=0;this.planView=null;this.ready=false;this.error=null;
    this.reload(cx);
    cx.timer.every(15000,cx=>this.reload(cx));
    cx.spawn(async cx=>{try{while(!this.closed){await watchFolder(appHome()+'/data/session-plans');this.reload(cx);}}catch{}});
  }
  reload(cx) {
    cx.spawn(async cx=>{try{const value=JSON.parse(await readTextFile(appHome()+'/data/session-plans/view-v1.json')??'null');
      if(!value||value.sequence>=(this.planView?.sequence??0))this.planView=value;
    }catch{}cx.notify();});
  }
  sync(cx) {
    const focus=focused(),all=spaces(),space=all.find(row=>row.id===focus?.space)??all.find(row=>row.active);
    const selection=decodeSession(this.target?.session).ok&&typeof this.target.artifactId==='string'&&typeof this.target.terminal==='string'
      ?selectPlanOwner({focused:{...focus,terminal:this.target.terminal,shown:null,agent:null},space,agents:agents(),panes:panes(),terminals:terminals(),planView:this.planView}):null;
    const artifact=selection&&sessionKey(selection.owner)===sessionKey(this.target.session)&&selection.artifacts.find(row=>row.id===this.target.artifactId);
    if(!artifact){this.context=null;this.ready=false;this.fingerprint=null;return;}
    const fingerprint=JSON.stringify([sessionKey(selection.owner),selection.proof.generation,selection.space,selection.tab,artifact.id,artifact.hash,artifact.revision]);
    if(this.fingerprint===fingerprint)return;
    this.fingerprint=fingerprint;this.selection=selection;this.artifact=artifact;this.ready=false;
    this.context={ownerKey:sessionKey(selection.owner),artifactId:artifact.id,epoch:++this.epoch,loadId:++this.loadId};
    this.load(cx);
  }
  load(cx) {
    const token=this.context&&{...this.context},selection=this.selection;if(!token||!selection)return;
    cx.spawn(async cx=>{
      const response=await this.client.call('read',{session:selection.owner,proof:selection.proof,id:token.artifactId});
      if(this.closed||!acceptPlanLoad(this.context,token))return;
      const document=response.value;
      if(!response.ok||document?.state!=='ready'||typeof document.text!=='string'||!decodeArtifact(document.artifact).ok
        ||document.artifact.id!==token.artifactId||sessionKey(document.artifact.session)!==token.ownerKey){this.ready=false;this.error='This plan file is unavailable. Your review is kept in the Plan panel.';cx.notify();return;}
      if(!this.editor)this.editor=EditorState.new({language:'markdown',readonly:true,soft_wrap:true,line_numbers:true,value:document.text,font_family:settings().font_family,font_size:13});
      else if(this.editor.value()!==document.text)this.editor.set_value(document.text);
      this.artifact=document.artifact;this.ready=true;this.error=null;this.watch(document.artifact.path,cx);cx.notify();
    });
  }
  watch(path,cx) {
    if(this.watched===path)return;this.watched=path;
    cx.spawn(async cx=>{try{while(!this.closed&&this.watched===path){const changes=await watchFolder(path.slice(0,path.lastIndexOf('/')));
      if(changes.includes(path)&&this.context){this.context={...this.context,loadId:++this.loadId};this.load(cx);}
    }}catch{}});
  }
  render(cx) {
    this.sync(cx);const t=theme();
    return v_flex().id('plan-file').size_full().min_h(0).min_w(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).px(12).gap(8).items_center().flex_none().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).tooltip(this.artifact?.path??'Markdown').child(this.artifact?.path.split('/').pop()??'Markdown'))
        .child(Button.new('plan-file-refresh').h(28).px(8).text_size(12).accessibility_label('Refresh Markdown file').on_click((_event,cx)=>{
          this.sync(cx);if(this.context){this.context={...this.context,loadId:++this.loadId};this.load(cx);}
        }).child('Refresh')))
      .child(div().px(12).py(6).text_size(11).text_color(t.muted).child('Read-only Markdown · review comments stay in the Plan panel'))
      .when(this.ready&&Boolean(this.context),part=>part.child(Editor.new(this.editor).id('plan-file-source').flex_1().min_h(0)))
      .when(!this.ready||!this.context,part=>part.child(div().p(12).text_size(12).text_color(t.muted).child(this.error??'Select the owning session to read this plan file.')));
  }
  close(){this.closed=true;this.watched=null;this.editor?.release();}
}
