import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, Input } from "gpui-base";
import { historyProgram, historyViewMode } from "./history-model.js";

function age(timestamp) {
  if (!timestamp) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  return minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
export function renderSessionHistory({ rows, groups, controller: c, compact, theme: t, knownPrograms, folded }) {
  const mode = historyViewMode(c.mode), options = [{ value: "recent", label: "Recent" }, { value: "folder", label: "By folder" }, { value: "harness", label: "By harness" }];
  const groupLabel = g => mode === "folder" ? `${g.rows[0].session.host} · ${g.label.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || g.label}` : g.label;
  const viewMenu = Popover.new("session-history-view-options").open(c.menuOpen).anchor("top_right").track_focus(c.menuHandle)
    .on_open_change((open, cx) => { c.menuOpen = open; c.menuIndex = options.findIndex(o => o.value === mode); cx.notify(); })
    .trigger(Button.new("session-history-view-trigger").h(24).px(5).rounded(4).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover))
      .accessibility_label("Session history view options").tooltip("History view options").child(svg("mods/workspace-chrome/layers.svg").size(14)))
    .content(v_flex().id("session-history-view-menu").w(180).p(5).gap(2).bg(t.popover).rounded(7).role("menu")
      .on_key_down((e, cx) => { const key = e.keystroke ?? e.key;
        if (key === "up" || key === "down") c.menuIndex = (c.menuIndex + (key === "down" ? 1 : 2)) % 3;
        else if (key === "enter" || key === "space") c.chooseView(options[c.menuIndex].value, cx); else return;
        cx.stop_propagation(); cx.notify(); })
      .children(options.map((o, index) => Button.new(`session-history-view-${o.value}`).h(31).px(8).gap(8).rounded(5).items_center()
        .bg(c.menuIndex === index ? t.selected : t.popover).hover(el => el.bg(t.hover)).cursor_pointer().role("menu_item")
        .accessibility_label(`${o.label}${mode === o.value ? ", selected" : ""}`).on_click((_e, cx) => c.chooseView(o.value, cx))
        .child(div().flex_1().text_size(12).child(o.label)).when(mode === o.value, el => el.child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.accent))))));
  const row = r => {
    const program = historyProgram(r.session, knownPrograms), pending = c.pending.get(r.key), opening = pending?.state === "opening", deleting = pending?.state === "deleting";
    const deleteDisabled = Boolean(r.bindings.length || opening || deleting);
    const stop = (_e, cx) => cx.stop_propagation();
    const deleteControl = Popover.new(`session-history-delete-popover-${r.key}`).open(c.confirmDeleteKey === r.key).anchor("top_right").track_focus(c.deleteHandle)
      .on_open_change((open, cx) => c.requestDelete(r, open, cx))
      .trigger(Button.new(`session-history-delete-${r.key}`).size(24).flex_none().rounded(4).cursor_pointer().disabled(deleteDisabled)
        .text_color(deleteDisabled ? t.dim : t.muted).hover(el => el.bg(t.raised).text_color(t.blocked))
        .accessibility_label(`Permanently delete ${r.title}`).tooltip(r.bindings.length ? "Close this session in Herdr before deleting it" : "Permanently delete session")
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); c.requestDelete(r, c.confirmDeleteKey !== r.key, cx); }).on_key_down(stop).on_key_up(stop)
        .child(svg("mods/space-agents/trash.svg").size(14)))
      .content(v_flex().id(`session-history-delete-confirmation-${r.key}`).w(260).p(12).gap(10).rounded(7).bg(t.popover).text_color(t.foreground)
        .role("alert_dialog").accessibility_label(`Permanently delete ${r.title}?`)
        .on_click(stop).on_key_down(stop).on_key_up(stop)
        .child(div().text_size(12.5).font_medium().truncate().tooltip(r.title).child(`Permanently delete “${r.title}”?`))
        .child(div().text_size(11.5).text_color(t.muted).child(`This deletes the saved conversation${r.session.harness === "opencode-v2" ? " and its child sessions" : " and its subagent transcripts"} from ${program.name}. This cannot be undone.`))
        .child(h_flex().gap(8).justify_end()
          .child(Button.new(`session-history-delete-cancel-${r.key}`).h(28).px(10).rounded(4).cursor_pointer().track_focus(c.deleteHandle)
            .bg(t.raised).hover(el => el.bg(t.hover)).accessibility_label("Cancel deletion")
            .on_click((_e, cx) => { cx.stop_propagation(); c.requestDelete(r, false, cx); }).child("Cancel"))
          .child(Button.new(`session-history-delete-confirm-${r.key}`).h(28).px(10).rounded(4).cursor_pointer().disabled(deleteDisabled)
            .text_color(t.blocked).bg(t.raised).hover(el => el.bg(t.hover)).accessibility_label(`Confirm permanent deletion of ${r.title}`)
            .on_click((_e, cx) => { cx.stop_propagation(); c.deleteSession(r, cx); }).child("Delete"))));
    const icon = (program.tint ? svg(program.icon).text_color(t.foreground) : image(program.icon)).id(`session-history-icon-${r.key}`).w(16).h(16).flex_none();
    const presence = r.primaryBinding?.browsing ? "Open for viewing; no new work requested here" : "Saved history; external activity unknown";
    const description = `${r.title}, ${program.name}, ${r.session.host} · ${r.directory ?? "Directory unavailable"}, ${r.updatedAt ? age(r.updatedAt) + " ago" : "Date unavailable"}, ${r.saved === "available" ? "saved" : "saved availability unverified"}. ${presence}.${pending?.message ? " " + pending.message : ""}`;
    return h_flex().id(`session-history-${r.key}`).h(28).w_full().min_w(0).flex_none().px(compact ? 6 : 8).gap(8).items_center().rounded(3)
      .bg(c.listHandle.is_focused() && c.selectedKey === r.key ? t.selected : t.chrome).hover(el => el.bg(t.hover)).cursor_pointer()
      .role("list_box_option").aria_selected(c.selectedKey === r.key).accessibility_label(`Open ${description}`).tooltip(description)
      .on_click((_e, cx) => { c.selectedKey = r.key; c.listHandle.focus(); c.resume(r, cx); })
      .when(compact, el => el.justify_center()).child(icon)
      .when(!compact, el => el.child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).truncate().child(r.title))
        .child(opening || deleting ? svg("mods/workspace-chrome/spinner.svg").id(`session-history-${deleting ? "deleting" : "opening"}-${r.key}`).size(12).flex_none().text_color(t.muted).spin(900)
          : div().flex_none().text_size(10.5).text_color(pending?.state === "error" ? t.blocked : t.muted).child(age(r.updatedAt)))
        .child(deleteControl));
  };
  if (!rows.some(r => r.key === c.selectedKey)) c.selectedKey = rows[0]?.key ?? null;
  const partial = c.page && !c.page.complete;
  const count = c.page?.hasMore ? Math.max(c.page.total, rows.length) : rows.length;
  return v_flex().id("session-history").w_full().min_w(0).flex_none().border_t(1).border_color(t.border).pb(8)
    .when(!compact, el => el.child(h_flex().h(42).px(14).gap(6).items_center()
      .child(Button.new("session-history-toggle").h(28).min_w(0).gap(6).items_center().cursor_pointer().text_color(t.foreground)
        .accessibility_label(folded ? "Expand Session History" : "Collapse Session History").on_click((_e, cx) => c.toggle("history", cx))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.muted))
        .child(div().text_size(13).font_medium().truncate().child("Session History")))
      .child(div().id("session-history-header-spacer").flex_1().min_w(0))
      .child(div().text_size(11).flex_none().text_color(t.muted).tooltip(partial ? "Known sessions; discovery is incomplete" : "Saved sessions in this Space").child(partial ? `${count}+` : String(count)))
      .child(viewMenu)))
    .when(!folded && !compact, el => el.child(div().px(14).pb(6).child(Input.new(c.search).id("session-history-search").h(29).px(8).rounded(5)
      .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12).accessibility_label("Search session history"))))
    .when(!folded && !compact && (c.error || partial), el => el.child(v_flex().px(14).py(5).gap(4)
      .child(div().text_size(11.5).text_color(t.muted).child(c.error || "Some history sources are unavailable. Showing known sessions."))
      .when(Boolean(c.error), el => el.child(Button.new("session-history-retry").h(26).text_size(12).text_color(t.accent).cursor_pointer().on_click((_e, cx) => c.refresh(cx)).child("Retry")))))
    .when(!folded && !compact && !rows.length && !c.error, el => el.child(div().px(14).py(8).text_size(12).text_color(t.muted)
      .child(c.loading || !c.page ? "Loading session history…" : c.query ? "No matching sessions in this Space."
        : partial ? "No sessions found in the available history sources." : "No saved sessions in this Space yet.")))
    .when(!folded, el => el.child(v_flex().id("session-history-list").px(compact ? 4 : 10).gap(2).role("list_box").accessibility_label("Session history in the selected Space")
      .track_focus(c.listHandle).tab_stop(true).on_key_down((e, cx) => {
        if (!rows.length) return;
        const key = e.keystroke ?? e.key, index = Math.max(0, rows.findIndex(r => r.key === c.selectedKey));
        if (key === "enter" || key === "space") c.resume(rows[index], cx);
        else if (key === "up" || key === "down") c.selectedKey = rows[(index + (key === "down" ? 1 : rows.length - 1)) % rows.length].key;
        else return; cx.stop_propagation(); cx.notify();
      }).children(groups.map(g => v_flex().id(`session-history-group-${g.key}`).w_full().min_w(0).flex_none().gap(0).role("group").accessibility_label(`${g.rows[0].session.host} · ${g.label}`)
        .when(!compact, el => el.child(div().px(8).pt(10).pb(3).text_size(11).font_medium().text_color(t.muted).truncate().tooltip(`${g.rows[0].session.host} · ${g.label}`).child(groupLabel(g))))
        .children(g.rows.map(row))))))
    .when(!folded && !compact && Boolean(c.page?.hasMore), el => el.child(Button.new("session-history-more").h(30).mx(14).text_size(12).text_color(t.accent)
      .cursor_pointer().on_click((_e, cx) => { if (!c.loading) c.refresh(cx, true); }).child(c.loading ? "Loading…" : "Load more")));
}
