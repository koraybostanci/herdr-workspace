import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Input, v_resizable, resizable_panel } from "gpui-base";

export function renderSidebarAreas({ theme: t, compact, height, historyOpen, historyHeight, agents, history, search, historyMenu, onToggle, onHeight, onSize }) {
  const open = historyOpen && !compact;
  const agentsArea = v_flex().id("agents-area").size_full().flex_1().min_h(0).child(agents);
  const historyArea = v_flex().id("history-area").min_w(0).min_h(0)
    .when(open, el => el.size_full())
    .when(!open, el => el.h(38).flex_none().border_t(1).border_color(t.border))
    .child(Button.new("history-area-toggle").w_full().h(38).flex_none().px(compact ? 0 : 14).gap(6).items_center().justify_start().text_left().cursor_pointer()
      .text_color(t.muted).hover(el => el.bg(t.hover).text_color(t.foreground))
      .accessibility_label(open ? "Collapse History" : "Expand History").tooltip("History").on_click(onToggle)
      .when(!compact, el => el.child(div().flex_1().text_size(12).font_medium().child("History")))
      .when(compact, el => el.justify_center())
      .child(svg(`mods/workspace-chrome/${compact ? "layers" : open ? "chevron-down" : "chevron-right"}.svg`).size(compact ? 14 : 12)))
    .when(open, el => el.child(h_flex().px(14).pb(8).gap(6).items_center().flex_none()
      .child(Input.new(search).id("history-search-all").flex_1().min_w(0).h(29).px(8).rounded(5)
        .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12.5).accessibility_label("Search history across all Spaces"))
      .child(historyMenu))
      .child(v_flex().flex_1().min_h(0).child(history)));
  const root = v_flex().id("space-agents").size_full().min_w(0).min_h(0).bg(t.chrome).on_size_change(onSize);
  if (!open) return root.child(agentsArea).child(historyArea);
  const agentMin = Math.min(120, Math.max(38, height * 0.25)), historyMin = Math.min(140, Math.max(38, height * 0.25));
  const initial = Math.max(historyMin, Number.isFinite(historyHeight) ? historyHeight : Math.min(320, height * 0.4));
  return root.child(v_resizable("agent-history-split").size_full()
    .on_resize((sizes, cx) => { if (Number.isFinite(sizes[1])) onHeight(Math.max(historyMin, sizes[1]), cx); })
    .child(resizable_panel().size_range(agentMin).child(agentsArea))
    .child(resizable_panel().size(initial).size_range(historyMin).child(historyArea)));
}
