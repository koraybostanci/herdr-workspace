import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { spaces, machines, focused, run, shared, setShared, openOverlay, hc } from "herdr";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const palette = Object.keys(MARK);

export class SpaceTree {
  init(cx) {
    this.handle = cx.focus_handle(); this.initialized = false; this.highlightedId = null;
    this.expandedId = shared("space-agents.tree")?.expandedId; this.knownMachines = [];
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
  }
  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.knownMachines = (JSON.parse(r.stdout).machines ?? []).filter(m => !m.temporary); } catch {}
      cx.notify();
    });
  }
  machineList() {
    const known = new Map(this.knownMachines.map(m => [m.name, m]));
    for (const m of machines()) known.set(m.name, { ...known.get(m.name), ...m });
    return [...known.values()].filter(m => !m.temporary);
  }
  ready(machine) { return machine == null || this.machineList().some(m => m.name === machine && m.layout === "ready"); }
  live(id) { return spaces().find(s => s.id === id && this.ready(s.machine)); }
  groups() {
    const allSpaces = spaces(), remote = [...new Set([...allSpaces.map(s => s.machine), ...this.machineList().map(m => m.name)].filter(Boolean))].sort();
    return [null, ...remote].map(machine => ({ machine, spaces: allSpaces.filter(s => (s.machine ?? null) === machine) }));
  }
  sync(allSpaces, activeId) {
    if ((!this.initialized && this.expandedId === undefined) || (this.initialized && this.activeId !== activeId)) this.expandedId = activeId ?? null;
    this.initialized = true; this.activeId = activeId;
    if (!allSpaces.some(s => s.id === this.expandedId && this.ready(s.machine))) this.expandedId = null;
    if (this.highlightedId === null) this.highlightedId = activeId ?? allSpaces[0]?.id ?? null;
    const colors = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => allSpaces.some(s => s.id === id)));
    for (const s of allSpaces) if (!colors[s.id]) {
      const uses = color => Object.values(colors).filter(value => value === color).length;
      colors[s.id] = palette.reduce((best, color) => uses(color) < uses(best) ? color : best);
    }
    if (JSON.stringify(colors) !== JSON.stringify(shared("space.colors") ?? {})) setShared("space.colors", colors);
    if (shared("space-agents.tree")?.expandedId !== this.expandedId) this.save();
    return this.expandedId;
  }
  save() { setShared("space-agents.tree", { expandedId: this.expandedId }); }
  expand(id, cx, toggle = false) {
    if (!this.live(id)) return;
    this.expandedId = toggle && this.expandedId === id ? null : id;
    this.highlightedId = id; this.save(); this.handle.focus(); cx.notify();
  }
  select(id, cx) {
    if (!this.live(id)) return;
    this.expand(id, cx); run("space.select", { id });
  }
  create(machine, cx) {
    if (!this.ready(machine)) return;
    run("space.new", machine ? { machine } : {}); cx.notify();
  }
  menu(id) {
    if (this.live(id)) openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id } } });
  }
  key(event, cx) {
    if (!this.handle.is_focused()) return;
    const key = event.keystroke ?? event.key, enabled = this.groups().flatMap(group => group.spaces).filter(s => this.ready(s.machine));
    const index = enabled.findIndex(s => s.id === this.highlightedId);
    if (["up", "down", "home", "end"].includes(key)) {
      this.highlightedId = enabled[key === "home" ? 0 : key === "end" ? enabled.length - 1
        : index < 0 ? key === "up" ? enabled.length - 1 : 0 : (index + (key === "up" ? enabled.length - 1 : 1)) % enabled.length]?.id ?? null;
    } else if (key === "right") this.expand(this.highlightedId, cx);
    else if (key === "left") { this.expandedId = null; this.save(); }
    else if (key === "enter" || key === "space") this.select(this.highlightedId, cx);
    else return;
    cx.stop_propagation(); cx.notify();
  }
  render(content, compact, t) {
    const allSpaces = spaces(), groups = this.groups();
    const current = allSpaces.find(s => s.id === focused()?.space) ?? allSpaces.find(s => s.active);
    const add = (machine, id) => Button.new(id).size(24).flex_none().rounded(4).cursor_pointer().disabled(!this.ready(machine))
      .text_color(t.muted).hover(el => el.bg(t.hover).text_color(t.foreground))
      .accessibility_label(machine ? `New space on ${machine}` : "New space on this computer").tooltip(machine ? `New space on ${machine}` : "New space")
      .on_click((_e, cx) => this.create(machine, cx)).child(svg("mods/workspace-chrome/plus.svg").size(14));
    const branch = s => {
      const expanded = this.expandedId === s.id, enabled = this.ready(s.machine), selected = s.id === this.activeId;
      const color = (shared("space.colors") ?? {})[s.id] ?? "ansi6", fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
      const description = `${s.name}${s.machine ? " on " + s.machine : ""}${selected ? ", active space" : ""}${enabled ? "" : ", machine unavailable"}`;
      return v_flex().id(`space-tree-branch-${s.id}`).w_full().min_w(0).flex_none().role("group").accessibility_label(description)
        .child(h_flex().id(`space-tree-row-${s.id}`).h(36).px(compact ? 2 : 6).gap(4).min_w(0).items_center().rounded(5)
          .bg(selected ? t.selected : this.handle.is_focused() && this.highlightedId === s.id ? t.hover : t.chrome)
          .on_mouse_down("right", () => this.menu(s.id))
          .when(!compact, el => el.child(Button.new(`space-tree-toggle-${s.id}`).size(24).flex_none().rounded(4).cursor_pointer().disabled(!enabled)
            .text_color(enabled ? t.muted : t.dim).hover(el => el.bg(t.hover).text_color(t.foreground))
            .accessibility_label(`${expanded ? "Collapse" : "Expand"} ${s.name}`).tooltip(`${expanded ? "Collapse" : "Expand"} ${s.name}`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.expand(s.id, cx, true); })
            .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(12))))
          .child(Button.new(`space-tree-name-${s.id}`).h(32).flex_1().min_w(0).px(compact ? 2 : 0).gap(7).items_center().justify_start().text_left()
            .rounded(4).cursor_pointer().disabled(!enabled).text_color(enabled ? t.foreground : t.dim).hover(el => el.bg(t.hover))
            .role("tree_item").aria_selected(selected).accessibility_label(description).tooltip(`${description}\n${s.folder ?? ""}`)
            .on_click((_e, cx) => { if (this.suppressClick === s.id) { this.suppressClick = null; return; } this.select(s.id, cx); })
            .on_mouse_down("left", () => { this.pressedId = s.id; this.suppressClick = null; })
            .on_mouse_up("left", (_e, cx) => {
              const from = this.live(this.pressedId), target = this.live(s.id); this.pressedId = null;
              if (!from || !target || from.id === target.id || (from.machine ?? null) !== (target.machine ?? null)) return;
              this.suppressClick = s.id; run("space.move", { id: from.id, index: spaces().findIndex(space => space.id === target.id) + 1 }); cx.notify();
            })
            .child(compact ? h_flex().size(24).rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?")
              : div().size(8).flex_none().rounded(3).bg(fill))
            .when(!compact, el => el.child(div().flex_1().min_w(0).text_size(13).font_medium().truncate().child(s.name)))
            .when(["blocked", "done", "working"].includes(s.status), el => el.child(div().size(5).flex_none().rounded(3).bg(t[s.status])))))
        .when(expanded && !compact && Boolean(content), el => el.child(v_flex().id(`space-tree-children-${s.id}`).w_full().min_w(0).flex_none().pl(18).pb(8).child(content)));
    };
    return v_flex().id("space-agents").size_full().min_w(0).bg(t.chrome).role("region").accessibility_label("Spaces, agents and history")
      .when(!compact, el => el.child(h_flex().h(38).px(14).gap(6).flex_none().items_center()
        .child(div().flex_1().text_size(12).font_medium().text_color(t.muted).child("Spaces"))
        .child(add(current?.machine ?? null, "space-tree-new"))))
      .child(v_flex().id("space-tree-list").flex_1().min_h(0).px(compact ? 2 : 6).pb(8).gap(2).overflow_y_scrollbar().mode("always")
        .role("tree").accessibility_label("Spaces").track_focus(this.handle).tab_stop(true).on_key_down((e, cx) => this.key(e, cx))
        .children(groups.flatMap(({ machine, spaces: entries }) => [
          ...(!compact && groups.length > 1 ? [h_flex().id(`space-tree-machine-${machine ?? "local"}`).h(30).px(8).gap(6).items_center().text_size(11).text_color(t.muted)
            .child(svg(`mods/workspace-chrome/${machine ? "server" : "monitor"}.svg`).size(13))
            .child(div().flex_1().min_w(0).truncate().child(machine ?? "This computer")).child(add(machine, `space-tree-new-${machine ?? "local"}`)),
          ...(!this.ready(machine) ? [div().px(10).py(4).text_size(11).text_color(t.dim).child("Machine unavailable")] : [])] : []),
          ...entries.map(branch),
        ]))
        .when(!allSpaces.length && !compact, el => el.child(div().px(8).py(12).text_size(12).text_color(t.muted).child("Create a space to organize your agents and history."))))
      .when(compact, el => el.child(h_flex().h(32).flex_none().justify_center().items_center()
        .child(Button.new("expand-space-sidebar").p(6).rounded(5).cursor_pointer().text_color(t.muted)
          .accessibility_label("Expand sidebar").tooltip("Expand sidebar").hover(el => el.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.resize", { id: "sidebar", px: 320 })).child(svg("mods/workspace-chrome/chevron-right.svg").size(14)))));
  }
  close() { this.handle.release(); }
}
