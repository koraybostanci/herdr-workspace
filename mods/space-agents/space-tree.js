/*
 * SPDX-License-Identifier: Apache-2.0
 * The palette and machine-refresh pattern are adapted from Herdr v0.1.9, defaults/mods/spaces/main.js:
 * https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/spaces/main.js
 * Modified by koraybostanci in 2026: reusable expandable Spaces tree, machine-aware controls and history browsing.
 * Copyright (c) 2026 koraybostanci (workspace additions and modifications only).
 * See LICENSE and NOTICE in this mod directory.
 */

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { spaces, machines, run, shared, setShared, openOverlay, hc } from "herdr";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const palette = Object.keys(MARK);

function selectionTint(color, t) {
  const channels = value => {
    if (typeof value !== "string" || !/^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) return null;
    const hex = value.length === 4 ? [...value.slice(1)].map(c => c + c).join("") : value.slice(1, 7);
    return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
  };
  const base = channels(t.chrome), accent = channels(color);
  if (!base || !accent) return t.selected;
  const light = base[0] * 0.2126 + base[1] * 0.7152 + base[2] * 0.0722 > 128;
  const amount = light ? 0.12 : 0.22;
  return "#" + base.map((value, index) => Math.round(value + (accent[index] - value) * amount).toString(16).padStart(2, "0")).join("");
}

export class SpaceTree {
  init(cx, options = {}) {
    this.handle = cx.focus_handle(); this.initialized = false; this.highlightedId = null;
    this.stateKey = options.stateKey ?? "space-agents.tree"; this.prefix = options.prefix ?? "space-tree";
    this.title = options.title ?? "Agents"; this.manageSpaces = options.manageSpaces !== false; this.followActive = options.followActive !== false;
    const saved = shared(this.stateKey);
    this.multiple = options.multiple === true; this.hasSavedExpansion = Array.isArray(saved?.expandedIds) || saved?.expandedId === null || typeof saved?.expandedId === "string";
    this.expandedId = typeof saved?.expandedId === "string" ? saved.expandedId : null;
    this.expandedIds = new Set(Array.isArray(saved?.expandedIds) ? saved.expandedIds.filter(id => typeof id === "string") : this.expandedId ? [this.expandedId] : []); this.knownMachines = [];
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
    if (!this.initialized && !this.hasSavedExpansion) {
      this.expandedId = this.followActive ? activeId ?? null : null;
      if (this.expandedId) this.expandedIds.add(this.expandedId);
    } else if (this.initialized && this.followActive && this.activeId !== activeId) {
      this.expandedId = activeId ?? null; if (this.expandedId) this.expandedIds.add(this.expandedId);
    }
    this.initialized = true; this.activeId = activeId;
    this.expandedIds = new Set([...this.expandedIds].filter(id => allSpaces.some(s => s.id === id && this.ready(s.machine))));
    if (!allSpaces.some(s => s.id === this.expandedId && this.ready(s.machine))) this.expandedId = null;
    if (!this.multiple) this.expandedIds = new Set(this.expandedId ? [this.expandedId] : []);
    if (this.highlightedId === null) this.highlightedId = activeId ?? allSpaces[0]?.id ?? null;
    const colors = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => allSpaces.some(s => s.id === id)));
    for (const s of allSpaces) if (!colors[s.id]) {
      const uses = color => Object.values(colors).filter(value => value === color).length;
      colors[s.id] = palette.reduce((best, color) => uses(color) < uses(best) ? color : best);
    }
    if (JSON.stringify(colors) !== JSON.stringify(shared("space.colors") ?? {})) setShared("space.colors", colors);
    const expansion = this.multiple ? { expandedIds: [...this.expandedIds] } : { expandedId: this.expandedId };
    if (JSON.stringify(shared(this.stateKey)) !== JSON.stringify(expansion)) this.save();
    return this.expandedId;
  }
  save() { setShared(this.stateKey, this.multiple ? { expandedIds: [...this.expandedIds] } : { expandedId: this.expandedId }); }
  expand(id, cx, toggle = false) {
    if (!this.live(id) || this.leaves?.has(id)) return;
    const expanded = this.temporaryExpansion ?? (this.multiple ? this.expandedIds : new Set(this.expandedId ? [this.expandedId] : []));
    if (toggle && expanded.has(id)) expanded.delete(id); else expanded.add(id);
    if (!this.temporaryExpansion) {
      if (this.multiple) { this.expandedIds = expanded; this.expandedId = expanded.has(id) ? id : [...expanded].at(-1) ?? null; }
      else { this.expandedId = toggle && this.expandedId === id ? null : id; this.expandedIds = new Set(this.expandedId ? [this.expandedId] : []); }
      this.save();
    }
    this.highlightedId = id; this.handle.focus(); cx.notify();
  }
  select(id, cx) {
    if (!this.live(id) || this.leaves?.has(id)) return;
    this.expand(id, cx); if (this.manageSpaces) run("space.select", { id });
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
    const key = event.keystroke ?? event.key, enabled = this.groups().flatMap(group => group.spaces)
      .filter(s => this.ready(s.machine) && (!this.visibleSpaceIds || this.visibleSpaceIds.has(s.id)));
    const index = enabled.findIndex(s => s.id === this.highlightedId);
    if (["up", "down", "home", "end"].includes(key)) {
      this.highlightedId = enabled[key === "home" ? 0 : key === "end" ? enabled.length - 1
        : index < 0 ? key === "up" ? enabled.length - 1 : 0 : (index + (key === "up" ? enabled.length - 1 : 1)) % enabled.length]?.id ?? null;
    } else if (index < 0) return;
    else if (key === "right") this.expand(this.highlightedId, cx);
    else if (key === "left") {
      const expanded = this.temporaryExpansion ?? this.expandedIds;
      if (expanded.has(this.highlightedId)) this.expand(this.highlightedId, cx, true);
    }
    else if (key === "enter" || key === "space") this.select(this.highlightedId, cx);
    else return;
    cx.stop_propagation(); cx.notify();
  }
  render(content, compact, t, { heading = true, tools = null, expanded = null, visible = null, hints = null, leaves = null } = {}) {
    this.leaves = leaves;
    if (leaves?.size) {
      const before = this.expandedIds.size;
      this.expandedIds = new Set([...this.expandedIds].filter(id => !leaves.has(id)));
      if (leaves.has(this.expandedId)) this.expandedId = [...this.expandedIds].at(-1) ?? null;
      if (before !== this.expandedIds.size) this.save();
    }
    const allSpaces = spaces(), groups = this.groups().map(group => ({ ...group, spaces: visible ? group.spaces.filter(s => visible.has(s.id)) : group.spaces }))
      .filter(group => !visible || group.spaces.length);
    this.temporaryExpansion = expanded;
    this.visibleSpaceIds = new Set(groups.flatMap(group => group.spaces).map(space => space.id));
    if (visible && !groups.some(group => group.spaces.some(s => s.id === this.highlightedId && this.ready(s.machine)))) {
      this.highlightedId = groups.flatMap(group => group.spaces).find(s => this.ready(s.machine))?.id ?? null;
    }
    const prefix = this.prefix;
    const add = (machine, id) => Button.new(id).size(24).flex_none().rounded(4).cursor_pointer().disabled(!this.ready(machine))
      .text_color(t.muted).hover(el => el.bg(t.hover).text_color(t.foreground))
      .accessibility_label(machine ? `New space on ${machine}` : "New space on this computer").tooltip(machine ? `New space on ${machine}` : "New space")
      .on_click((_e, cx) => this.create(machine, cx)).child(svg("mods/workspace-chrome/plus.svg").size(14));
    const branch = s => {
      const leaf = leaves?.has(s.id), open = !leaf && (this.temporaryExpansion ?? this.expandedIds).has(s.id), enabled = this.ready(s.machine), selected = s.id === (this.manageSpaces ? this.activeId : this.expandedId);
      const branchContent = content instanceof Map ? content.get(s.id) : content;
      const hint = hints?.get(s.id);
      const color = (shared("space.colors") ?? {})[s.id] ?? "ansi6", fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
      const selectedFill = selectionTint(fill, t);
      const description = `${s.name}${s.machine ? " on " + s.machine : ""}${selected ? this.manageSpaces ? ", active space" : ", browsing history" : ""}${enabled ? "" : ", machine unavailable"}`;
      return v_flex().id(`${prefix}-branch-${s.id}`).w_full().min_w(0).flex_none().role("group").accessibility_label(description)
        .child(h_flex().id(`${prefix}-row-${s.id}`).h(36).px(compact ? 2 : 6).gap(4).min_w(0).items_center().rounded(5)
          .bg(selected ? selectedFill : this.handle.is_focused() && this.highlightedId === s.id ? t.hover : t.chrome)
          .hover(el => el.bg(selected ? selectedFill : t.hover))
          .on_mouse_down("right", () => { if (this.manageSpaces) this.menu(s.id); })
          .when(!compact, el => el.child(Button.new(`${prefix}-toggle-${s.id}`).size(24).flex_none().rounded(4).cursor_pointer().disabled(!enabled || Boolean(leaf))
            .text_color(enabled ? t.muted : t.dim).hover(el => el.text_color(t.foreground))
            .accessibility_label(leaf ? `History in ${s.name}, no loaded sessions` : `${open ? "Collapse" : "Expand"} ${s.name}`)
            .when(!leaf, el => el.tooltip(`${open ? "Collapse" : "Expand"} ${s.name}`))
            .on_click((_e, cx) => { cx.stop_propagation(); this.expand(s.id, cx, true); })
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12))))
          .child(Button.new(`${prefix}-name-${s.id}`).h(32).flex_1().min_w(0).px(compact ? 2 : 0).gap(7).items_center().justify_start().text_left()
            .rounded(4).cursor_pointer().disabled(!enabled).text_color(enabled ? t.foreground : t.dim)
            .role("tree_item").aria_selected(selected).accessibility_label(description + (leaf ? ". No loaded History sessions." : "") + (hint ? `. ${hint}` : "")).tooltip(`${description}\n${s.folder ?? ""}${hint ? "\n" + hint : ""}`)
            .on_click((_e, cx) => { if (this.suppressClick === s.id) { this.suppressClick = null; return; } this.select(s.id, cx); })
            .when(this.manageSpaces, el => el.on_mouse_down("left", () => { this.pressedId = s.id; this.suppressClick = null; })
            .on_mouse_up("left", (_e, cx) => {
              const from = this.live(this.pressedId), target = this.live(s.id); this.pressedId = null;
              if (!from || !target || from.id === target.id || (from.machine ?? null) !== (target.machine ?? null)) return;
              this.suppressClick = s.id; run("space.move", { id: from.id, index: spaces().findIndex(space => space.id === target.id) + 1 }); cx.notify();
            }))
            .child(compact ? h_flex().size(24).rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?")
              : div().size(8).flex_none().rounded(3).bg(fill))
            .when(!compact, el => el.child(div().flex_1().min_w(0).text_size(13).font_medium().truncate().child(s.name)))
            .when(this.manageSpaces && ["blocked", "done", "working"].includes(s.status), el => el.child(div().size(5).flex_none().rounded(3).bg(t[s.status])))))
        .when(open && !compact && Boolean(branchContent), el => el.child(v_flex().id(`${prefix}-children-${s.id}`).w_full().min_w(0).flex_none().pl(18).pt(4).pb(8).child(branchContent)));
    };
    return v_flex().id(prefix).size_full().min_w(0).min_h(0).bg(t.chrome).role("region").accessibility_label(this.title)
      .when(!compact && heading, el => el.child(h_flex().h(38).px(14).gap(6).flex_none().items_center()
        .child(div().flex_1().text_size(12).font_medium().text_color(t.muted).child(this.title))
        .when(Boolean(tools), el => el.child(tools))))
      .child(v_flex().id(`${prefix}-list`).flex_1().min_h(0).px(compact ? 2 : 6).pb(8).gap(2).overflow_y_scrollbar().mode("always")
        .role("tree").accessibility_label(`${this.title} by Space`).track_focus(this.handle).tab_stop(true).on_key_down((e, cx) => this.key(e, cx))
        .children(groups.flatMap(({ machine, spaces: entries }) => [
          ...(!compact ? [h_flex().id(`${prefix}-machine-${machine ?? "local"}`).h(30).px(8).gap(6).items_center().text_size(11).text_color(t.muted)
            .child(svg(`mods/workspace-chrome/${machine ? "server" : "monitor"}.svg`).size(13))
            .child(div().flex_1().min_w(0).truncate().child(machine ?? "This computer")).when(this.manageSpaces, el => el.child(add(machine, `${prefix}-new-${machine ?? "local"}`))),
          ...(!this.ready(machine) ? [div().px(10).py(4).text_size(11).text_color(t.dim).child("Machine unavailable")] : [])] : []),
          ...entries.map(branch),
        ]))
        .when(!allSpaces.length && !compact, el => el.child(div().px(8).py(12).text_size(12).text_color(t.muted).child(this.manageSpaces ? "Create a space to organize your agents and history." : "No Spaces available."))))
      .when(compact, el => el.child(h_flex().h(32).flex_none().justify_center().items_center()
        .child(Button.new("expand-space-sidebar").p(6).rounded(5).cursor_pointer().text_color(t.muted)
          .accessibility_label("Expand sidebar").tooltip("Expand sidebar").hover(el => el.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.resize", { id: "sidebar", px: 320 })).child(svg("mods/workspace-chrome/chevron-right.svg").size(14)))));
  }
  close() { this.handle.release(); }
}
