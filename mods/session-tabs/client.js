import { appHome, readTextFile, writeTextFile, exec } from 'herdr';
import { OWNER, utf8Length } from './protocol.js';

const absolute=value=>typeof value==='string'&&/^(?:\/|[A-Za-z]:[\\/])/.test(value)&&!/[\x00-\x1f\x7f]/.test(value);
const normalized=value=>value.replaceAll('\\','/').replace(/\/+$/,'');
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
export class PlanClient {
  async runtime() {
    const home=appHome(),raw=await readTextFile(home+'/data/session-plans/runtime.json');
    const value=JSON.parse(raw??'null');
    if(!value||value.schema!==1||value.owner!==OWNER||!absolute(value.node)||!absolute(value.helperPath)||!absolute(value.stateRoot)
      ||!/^[a-f0-9]{64}$/.test(value.buildHash??''))throw Error('runtime-unavailable');
    const prefix=normalized(home)+'/integrations/session-metadata/releases/';
    const path=normalized(value.helperPath);
    if(!path.startsWith(prefix)||!/^[-a-f0-9]{36}\/bin\/herdr-plan\.mjs$/.test(path.slice(prefix.length)))throw Error('runtime-unavailable');
    return {...value,home};
  }
  async run(runtime,args) {
    const result=await exec(runtime.node,[runtime.helperPath,...args,'--app-home',runtime.home,'--state-root',runtime.stateRoot],{cwd:runtime.home});
    let decoded;try{decoded=JSON.parse(result.stdout);}catch{throw Error('helper-unavailable');}
    if(!decoded||typeof decoded.ok!=='boolean'||decoded.ok&&!Object.hasOwn(decoded,'value'))throw Error('invalid-helper-response');
    return decoded;
  }
  async call(operation,payload) {
    let commentId=payload?.id??null,requestId=null;
    try {
      const runtime=await this.runtime();
      const result=await this.run(runtime,['prepare','--operation',operation]);
      if(!result.ok)return result;
      const prepared=result.value,expectedPath=runtime.home+'/data/session-plans/requests/'+prepared?.id+'.json';
      if(!uuid(prepared?.id)||!uuid(prepared.nonce)||prepared.expected!==''||normalized(prepared.path??'')!==normalized(expectedPath))throw Error('invalid-request-path');
      requestId=prepared.id;
      const data={...payload};
      if(operation==='save-comment'&&!data.id){data.id=prepared.id;commentId=data.id;}
      const body=JSON.stringify({nonce:prepared.nonce,payload:data});
      if(utf8Length(body)>1048576)throw Error('request-too-large');
      await writeTextFile(prepared.path,body,prepared.expected);
      const applied=await this.run(runtime,['apply','--id',prepared.id]);
      return {...applied,...(operation==='save-comment'?{commentId,requestId}:{})};
    } catch(error) {return {ok:false,reason:error.message??'helper-unavailable',commentId,requestId};}
  }
}
