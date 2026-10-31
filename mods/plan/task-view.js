import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';

const labels={pending:'Not started',in_progress:'In progress',blocked:'Blocked',completed:'Done',unknown:'No status'};
const valid=row=>row&&typeof row.id==='string'&&typeof row.title==='string'&&Object.hasOwn(labels,row.status);
const rows=value=>Array.isArray(value)?value.filter(valid):[];
function status(row,t) {
  const color=row.status==='blocked'?t.blocked:row.status==='completed'?t.done:row.status==='in_progress'?t.working:t.muted;
  return div().flex_none().text_size(11).text_color(color).accessibility_label(`Status: ${labels[row.status]}`).child(labels[row.status]);
}
function taskRow(task,t,depth=0) {
  return v_flex().id('plan-task-'+task.id).gap(5).pl(Math.min(depth,8)*12)
    .child(h_flex().gap(8).items_start().child(div().flex_1().min_w(0).text_size(12).child(task.title)).child(status(task,t)))
    .child(div().text_size(10.5).text_color(t.muted).child(task.source==='agent'?'Agent update':'Plan checklist'))
    .when(depth<8,part=>part.children(rows(task.children).map(child=>taskRow(child,t,depth+1))));
}
export function renderTasks({value,collapsed,t,button,onToggle,onSection}) {
  const phases=rows(value?.phases),tasks=rows(value?.tasks),unassigned=rows(value?.unassigned);
  const phaseRows=phases.map(phase=>{
    const contents=v_flex().gap(12).children(rows(phase.tasks).map(task=>taskRow(task,t)))
      .when(!rows(phase.tasks).length,part=>part.child(div().text_size(12).text_color(t.muted).child('No tasks listed for this phase.')));
    return v_flex().id('plan-phase-'+phase.id).gap(9)
      .child(h_flex().gap(8).items_center()
        .child(button('plan-phase-toggle-'+phase.id,phase.title,cx=>onToggle(phase.id,cx),t).flex_1().min_w(0)
          .tooltip(collapsed.has(phase.id)?'Expand phase':'Collapse phase').pressed(!collapsed.has(phase.id))
          .accessibility_label(`${collapsed.has(phase.id)?'Expand':'Collapse'} ${phase.title}`))
        .child(status(phase,t)))
      .child(h_flex().gap(8).items_center().child(div().flex_1().text_size(11).text_color(t.muted).child(`${phase.completed} of ${phase.total} tasks done`))
        .child(button('plan-phase-open-'+phase.id,'View section',cx=>onSection(phase,cx),t)))
      .when(!collapsed.has(phase.id),part=>part.child(contents));
  });
  return v_flex().id('plan-tasks').flex_1().min_h(0).p(12).gap(16).overflow_y_scrollbar()
    .when(Boolean(value?.stale),part=>part.child(div().text_size(12).text_color(t.blocked).child('Agent tasks refer to an earlier plan revision. Recheck before using their status.')))
    .when(Number.isSafeInteger(value?.observedAt),part=>part.child(div().text_size(11).text_color(t.muted).child(`Agent update · ${new Date(value.observedAt).toLocaleString()}`)))
    .when(Boolean(phases.length),part=>part.child(v_flex().id('plan-phase-list').gap(18).children(phaseRows)))
    .when(Boolean(tasks.length),part=>part.child(v_flex().id('plan-task-list').gap(12)
      .when(Boolean(phases.length),group=>group.child(div().font_medium().child('Unassigned')))
      .children(tasks.map(task=>taskRow(task,t)))))
    .when(Boolean(unassigned.length),part=>part.child(v_flex().id('plan-unassigned-tasks').gap(12)
      .child(div().font_medium().child('Unassigned agent tasks'))
      .child(div().text_size(11).text_color(t.muted).child('No unambiguous link to this plan and revision.'))
      .children(unassigned.map(task=>taskRow(task,t)))))
    .when(!phases.length&&!tasks.length&&!unassigned.length,part=>part.child(v_flex().py(24).gap(7)
      .child(div().font_medium().child('No tasks in this plan yet.'))
      .child(div().text_size(12).text_color(t.muted).child('Tasks appear from task headings, checklists, and explicit agent updates. Phases are optional.'))));
}
