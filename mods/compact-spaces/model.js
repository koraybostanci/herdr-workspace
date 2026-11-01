const spaceKey=id=>'space:'+id;
const createKey=machine=>'create:'+JSON.stringify(machine??null);
const ready=(machine,machines)=>machine==null||machines.some(m=>m.name===machine&&!m.temporary&&m.layout==='ready');

export function spaceMenuRows({spaces,machines,ordered,selectedId}) {
  const live=new Map(spaces.map(space=>[space.id,space]));
  const entries=ordered.filter(row=>live.has(row.w.id)).map(row=>({...row,w:live.get(row.w.id)}));
  const remote=[...new Set([...spaces.map(space=>space.machine).filter(Boolean),...machines.filter(m=>!m.temporary).map(m=>m.name).filter(Boolean)])].sort();
  return [null,...remote].flatMap(machine=>{
    const enabled=ready(machine,machines),mine=entries.filter(row=>(row.w.machine??null)===machine),rows=[];
    if(remote.length)rows.push({key:'machine:'+JSON.stringify(machine),id:null,machine,label:machine??'This computer',kind:'heading',enabled:false});
    if(!enabled)rows.push({key:'unavailable:'+machine,id:null,machine,label:machines.find(m=>m.name===machine)?.layout==='loading'?'Connecting…':'Machine unavailable',kind:'unavailable',enabled:false});
    for(const row of mine)rows.push({key:spaceKey(row.w.id),id:row.w.id,machine,label:row.w.name,kind:'space',enabled,selected:row.w.id===selectedId,tree:row.tree,data:row});
    rows.push({key:createKey(machine),id:null,machine,label:machine?'New space on '+machine:'New space',kind:'create',enabled});
    return rows;
  });
}
export function resolveSpaceAction(rowKey,{spaces,machines}) {
  if(typeof rowKey!=='string')return null;
  if(rowKey.startsWith('space:')) {
    const space=spaces.find(space=>space.id===rowKey.slice(6));
    return space&&ready(space.machine,machines)?{command:'space.select',args:{id:space.id}}:null;
  }
  if(rowKey.startsWith('create:')) {
    let machine;try{machine=JSON.parse(rowKey.slice(7));}catch{return null;}
    if(machine!==null&&typeof machine!=='string'||!ready(machine,machines))return null;
    return {command:'space.new',args:machine?{machine}:{}};
  }
  return null;
}
