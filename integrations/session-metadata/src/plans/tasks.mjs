import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { sessionKey } from '../protocol.mjs';
import { assertPlanOwner } from './artifacts.mjs';

const statuses=new Set(['pending','in_progress','blocked','completed','unknown']);
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value);
const id=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);
const marker=value=>({' ':'pending',x:'completed',X:'completed','-':'in_progress','!':'blocked'}[value]);
const status=value=>({done:'completed',complete:'completed',active:'in_progress','in progress':'in_progress','not started':'pending'}[value?.toLowerCase()]??value?.toLowerCase());
const headingStatus=title=>status(title.match(/\[(pending|in_progress|in progress|blocked|completed|done)\]\s*$/i)?.[1]);
const aggregate=items=>!items.length?'unknown':items.some(item=>item.status==='blocked')?'blocked'
  :items.every(item=>item.status==='completed')?'completed':items.some(item=>['in_progress','completed'].includes(item.status))?'in_progress'
    :items.some(item=>item.status==='unknown')?'unknown':'pending';

function finishTask(task) {
  task.children.forEach(finishTask);
  if(task.children.length&&task.source!=='agent'&&!task.explicit)task.status=aggregate(task.children);
}
function finishPhase(phase) {
  phase.tasks.forEach(finishTask);phase.total=phase.tasks.length;phase.completed=phase.tasks.filter(task=>task.status==='completed').length;
  if(!phase.explicit)phase.status=aggregate(phase.tasks);
}
// Only structural evidence counts. Code/HTML examples are never work items.
function contentLines(text) {
  const output=[];let offset=0,fence=null,html=null;
  for(const raw of text.match(/[^\n]*\n|[^\n]+$/g)??[]) {
    const line=raw.replace(/\r?\n$/,''),start=offset;offset+=raw.length;
    if(fence){if(new RegExp('^\\s*'+fence.char+'{'+fence.length+',}\\s*$').test(line))fence=null;continue;}
    const opened=line.match(/^\s*(`{3,}|~{3,})/);
    if(opened){fence={char:opened[1][0],length:opened[1].length};continue;}
    if(html){if(html==='blank'?!line.trim():html.test(line))html=null;continue;}
    if(/^ {0,3}<!--/.test(line)){if(!line.includes('-->'))html=/-->/;continue;}
    const tag=line.match(/^ {0,3}<(script|pre|style|textarea)\b/i);
    if(tag){html=new RegExp('</'+tag[1]+'\\s*>','i');if(html.test(line))html=null;continue;}
    if(/^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b/i.test(line)){html='blank';continue;}
    output.push({line,start});
  }
  return output;
}
export function indexPlanTasks(text,sections) {
  const lines=contentLines(text),visible=new Set(lines.map(line=>line.start));
  sections=sections.filter(section=>visible.has(section.start));
  const phaseSections=sections.filter(section=>/^phase\s+(?:\d+|[a-z])\b/i.test(section.headingPath.at(-1)));
  const phases=phaseSections.map(section=>({id:id(['phase',section.headingPath,section.occurrence]),title:section.headingPath.at(-1),
    headingPath:section.headingPath,occurrence:section.occurrence,start:section.start,end:section.end,tasks:[],status:headingStatus(section.headingPath.at(-1))??'unknown',explicit:Boolean(headingStatus(section.headingPath.at(-1)))}));
  const tasks=[],roots=[];
  const phaseAt=start=>phases.filter(phase=>start>=phase.start&&start<phase.end).sort((a,b)=>b.start-a.start)[0];
  const taskSections=sections.filter(section=>/^task\s+(?:\d+|[a-z])\b/i.test(section.headingPath.at(-1)));
  for(const section of taskSections) {
    const task={id:id(['task',section.headingPath,section.occurrence]),title:section.headingPath.at(-1),headingPath:section.headingPath,
      occurrence:section.occurrence,start:section.start,end:section.end,status:headingStatus(section.headingPath.at(-1))??'pending',source:'markdown',children:[],explicit:Boolean(headingStatus(section.headingPath.at(-1)))};
    (phaseAt(section.start)?.tasks??tasks).push(task);roots.push(task);
  }
  let stack=[],scope=null;
  for(const {line,start} of lines) {
    const parent=roots.filter(task=>start>=task.start&&start<task.end).sort((a,b)=>b.start-a.start)[0];
    const phase=phaseAt(start),next=parent?.id??phase?.id??'flat';
    if(scope!==next){stack=[];scope=next;}
    const state=line.match(/^\s*(?:\*\*)?Status:(?:\*\*)?\s*(pending|in_progress|in progress|blocked|completed|done|not started)\s*$/i);
    if(state&&(parent||phase)){const target=parent??phase;target.status=status(state[1]);target.explicit=true;continue;}
    const check=line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+\[([ xX!\-])\]\s+(.+?)\s*$/);
    if(!check)continue;
    const indent=check[1].replaceAll('\t','    ').length;
    while(stack.length&&stack.at(-1).indent>=indent)stack.pop();
    if(indent>=4&&!stack.length)continue;
    const section=sections.filter(section=>start>=section.start&&start<section.end).sort((a,b)=>b.start-a.start)[0];
    const task={id:id(['check',start,check[3]]),title:check[3],headingPath:section?.headingPath??[],occurrence:section?.occurrence??0,
      start,status:marker(check[2]),source:'markdown',children:[],explicit:check[2]!==' '};
    (stack.at(-1)?.task.children??parent?.children??phase?.tasks??tasks).push(task);stack.push({indent,task});
  }
  phases.forEach(finishPhase);tasks.forEach(finishTask);
  return {phases,tasks};
}

function normalizeTasks(tasks) {
  if(!Array.isArray(tasks)||tasks.length>1000)throw Error('invalid-tasks');
  const ids=new Set();
  return tasks.map((task,index)=>{
    if(!task||!text(task.title??task.content)||!statuses.has(task.status))throw Error('invalid-task');
    const key=task.id??String(index);
    if(!text(key)||ids.has(key))throw Error('invalid-task');ids.add(key);
    if(task.headingPath!==undefined&&(!Array.isArray(task.headingPath)||!task.headingPath.length||!task.headingPath.every(text)))throw Error('invalid-task');
    return {id:key,title:(task.title??task.content).trim(),status:task.status,...(task.headingPath?{headingPath:task.headingPath}:{})};
  });
}
function normalizePlan(plan) {
  if(plan===undefined||plan===null)return null;
  if(!text(plan.path)||!isAbsolute(plan.path)||typeof plan.documentHash!=='string'||!/^[a-f0-9]{64}$/.test(plan.documentHash))throw Error('invalid-task-plan');
  return {path:plan.path,documentHash:plan.documentHash};
}
function schema(db) {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS plan_task_snapshots (session_key TEXT PRIMARY KEY, data TEXT NOT NULL, observed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plan_task_events (session_key TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(session_key,event_id));`);
}
export async function recordTaskSnapshot(input,deps) {
  await assertPlanOwner(input.session,{...deps,proof:input.proof});
  if(!text(input.eventId)||!Number.isSafeInteger(input.observedAt)||input.observedAt<0||input.observedAt>(deps.clock??Date.now)()+60000)throw Error('invalid-task-event');
  const snapshot={eventId:input.eventId,observedAt:input.observedAt,tasks:normalizeTasks(input.tasks),plan:normalizePlan(input.plan)};
  schema(deps.db);const key=sessionKey(input.session);
  return deps.db.transaction(sql=>{
    if(sql.prepare('SELECT 1 FROM plan_task_events WHERE session_key=? AND event_id=?').get(key,input.eventId))return {updated:false};
    sql.prepare('INSERT INTO plan_task_events VALUES (?,?)').run(key,input.eventId);
    const previous=sql.prepare('SELECT observed_at FROM plan_task_snapshots WHERE session_key=?').get(key);
    if(previous&&previous.observed_at>=snapshot.observedAt)return {updated:false};
    sql.prepare('INSERT INTO plan_task_snapshots VALUES (?,?,?) ON CONFLICT(session_key) DO UPDATE SET data=excluded.data,observed_at=excluded.observed_at').run(key,JSON.stringify(snapshot),snapshot.observedAt);
    return {updated:true};
  });
}
export function readPlanTasks(artifact,text,sections,deps) {
  const outline=indexPlanTasks(text,sections),result={...outline,unassigned:[],observedAt:null,stale:false};
  schema(deps.db);
  const row=deps.db.sql.prepare('SELECT data FROM plan_task_snapshots WHERE session_key=?').get(sessionKey(artifact.session));
  if(!row)return result;
  let snapshot;
  try{snapshot=JSON.parse(row.data);snapshot.tasks=normalizeTasks(snapshot.tasks);snapshot.plan=normalizePlan(snapshot.plan);if(!Number.isSafeInteger(snapshot.observedAt))return result;}catch{return result;}
  result.observedAt=snapshot.observedAt;
  const linked=snapshot.plan?.path===artifact.path&&snapshot.plan.documentHash===artifact.hash;
  result.stale=Boolean(snapshot.plan&&snapshot.plan.documentHash!==artifact.hash);
  const candidates=[];
  function collect(tasks){for(const task of tasks){candidates.push(task);collect(task.children);}}
  collect(result.tasks);for(const phase of result.phases)collect(phase.tasks);
  const matches=snapshot.tasks.map(task=>linked?candidates.filter(candidate=>task.headingPath
    ?JSON.stringify(candidate.headingPath)===JSON.stringify(task.headingPath)&&candidate.title===task.title:candidate.title===task.title):[]);
  snapshot.tasks.forEach((task,index)=>{
    const found=matches[index];
    if(found.length===1&&matches.filter(other=>other.length===1&&other[0]===found[0]).length===1){found[0].status=task.status;found[0].source='agent';}
    else result.unassigned.push({...task,headingPath:task.headingPath??[],children:[],source:'agent'});
  });
  // Recompute only derived parents. A direct, linked observation owns its task status.
  result.tasks.forEach(finishTask);result.phases.forEach(finishPhase);
  return result;
}
export function extractTaskSnapshot(event) {
  if(!event||event.failed||!['TodoWrite','todowrite'].includes(event.tool))return null;
  try{return {eventId:event.eventId,observedAt:event.at,tasks:normalizeTasks(event.input?.todos),plan:normalizePlan(event.input?.plan)};}catch{return null;}
}
