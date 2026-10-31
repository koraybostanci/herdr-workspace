import { spaces, agents, panes, terminals, focused, appHome, readTextFile, watchFolder, shared, setShared } from 'herdr';
import { selectPlanOwner } from './plan-model.js';
import { sessionKey } from './protocol.js';

export function planLiveData() {
  const focus=focused(),all=spaces(),space=all.find(s=>s.id===focus?.space)??all.find(s=>s.active);
  return {focused:focus,agents:agents(),panes:panes(),terminals:terminals(),space};
}
export async function legacyPanels() {
  try {
    const stored=JSON.parse(await readTextFile(appHome()+'/data/tabs/store.json')??'null');
    const value=JSON.parse(stored?.panels??'null');
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    return Object.fromEntries(Object.entries(value).filter(([_id,choice])=>choice===null||['files','changes'].includes(choice)));
  } catch {return {};}
}
export class PlanController {
  init(cx) {
    this.view=null;this.ready=false;this.loading=false;this.closed=false;this.selection=null;this.epoch=0;this.fingerprint='';
    this.reload(cx);
    cx.timer.every(15000,cx=>{if(shared('layout')==='herdr-workspace')this.reload(cx);});
    cx.spawn(async cx=>{
      try {
        while(!this.closed) {
          const changed=await watchFolder(appHome()+'/data/session-plans');
          if(changed.some(path=>/view-v1\.json$|changed-v1\.json$/.test(path)))this.reload(cx);
        }
      } catch {} // The 15-second active reconciliation also expires a failed watch's old proof.
    });
  }
  reload(cx) {
    if(this.loading||this.closed)return;this.loading=true;
    cx.spawn(async cx=>{
      try {
        const raw=JSON.parse(await readTextFile(appHome()+'/data/session-plans/view-v1.json')??'null');
        if(!raw||raw.sequence>=(this.view?.sequence??0))this.view=raw;
      } catch {} finally {this.ready=true;this.loading=false;cx.notify();}
    });
  }
  sync() {
    const selected=selectPlanOwner({...planLiveData(),planView:this.view,previous:this.selection});
    const identity=value=>value?JSON.stringify([sessionKey(value.owner),value.proof.generation,value.space,value.tab]):null;
    if(identity(selected)!==identity(this.selection))this.epoch++;
    this.selection=selected?{...selected,epoch:this.epoch}:null;
    const selection=this.selection&&{...this.selection,artifacts:undefined};
    const availability=this.selection&&{ownerKey:sessionKey(this.selection.owner),epoch:this.epoch,artifacts:this.selection.artifacts,capabilities:this.selection.capabilities};
    const next=JSON.stringify([selection,availability]);
    if(next!==this.fingerprint){this.fingerprint=next;setShared('session-plans.selection',selection);setShared('session-plans.availability',availability);}
    return this.selection;
  }
  matches(expected) {
    const current=selectPlanOwner({...planLiveData(),planView:this.view,previous:this.selection});
    return Boolean(expected&&current&&sessionKey(current.owner)===sessionKey(expected.owner)&&current.proof.generation===expected.proof.generation);
  }
  close(){this.closed=true;}
}
