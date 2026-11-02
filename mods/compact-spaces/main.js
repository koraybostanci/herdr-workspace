/*
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Herdr v0.1.9, defaults/mods/spaces/main.js:
 * https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/spaces/main.js
 * Modified by koraybostanci in 2026: compact space selector, menu behavior and presentation.
 * Copyright (c) 2026 koraybostanci (modifications only).
 * See LICENSE and NOTICE in this mod directory.
 */

// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover } from "gpui-base";
import { spaces, machines, panes, focused, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import { spaceMenuRows, resolveSpaceAction } from "./model.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.triggerFocus = cx.focus_handle(); this.menuFocus = cx.focus_handle();
    this.open = false; this.highlightedKey = null; this.pressedId = null; this.suppressClick = null;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.machines = [];
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w) => ({ w, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  liveState() {
    const known = new Map(this.machines.map(machine => [machine.name, machine]));
    for (const machine of machines()) known.set(machine.name, { ...known.get(machine.name), ...machine });
    return { spaces: spaces(), machines: [...known.values()] };
  }

  currentSpace(sp = spaces()) {
    const id = focused()?.space;
    return id ? sp.find(space => space.id === id) : sp.find(space => space.active);
  }

  menuRows() {
    const live = this.liveState();
    return spaceMenuRows({ ...live, ordered: this.ordered(), selectedId: this.currentSpace(live.spaces)?.id ?? null });
  }

  activate(key, cx) {
    const action = resolveSpaceAction(key, this.liveState());
    if (!action) { this.menuError = "This space or machine is no longer available."; cx.notify(); return; }
    run(action.command, action.args); this.open = false; this.triggerFocus.focus(); cx.notify();
  }

  menuKey(event, cx) {
    if (!this.menuFocus.is_focused()) return;
    const key = String(event.key ?? event.keystroke).toLowerCase();
    if (key === "escape") { this.open = false; this.triggerFocus.focus(); }
    else if (key === "enter" || key === "space") this.activate(this.highlightedKey, cx);
    else if (["up", "down", "home", "end"].includes(key)) {
      const enabled = this.menuRows().filter(row => row.enabled), index = enabled.findIndex(row => row.key === this.highlightedKey);
      if (enabled.length) this.highlightedKey = enabled[key === "home" ? 0 : key === "end" ? enabled.length - 1
        : index < 0 ? key === "up" ? enabled.length - 1 : 0 : (index + (key === "up" ? enabled.length - 1 : 1)) % enabled.length].key;
    } else return;
    cx.stop_propagation(); cx.notify();
  }

  avatar(space, t, size = 20) {
    const color = (shared("space.colors") ?? {})[space.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
    return h_flex().size(size).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff")
      .child([...space.name][0]?.toUpperCase() ?? "?");
  }

  option(row, t) {
    if (row.kind === "heading") return h_flex().id(row.key).h(27).px(8).gap(7).items_center().text_size(11).text_color(t.muted)
      .child(svg(`mods/workspace-chrome/${row.machine ? "server" : "monitor"}.svg`).size(13)).child(row.label);
    if (row.kind === "unavailable") return div().id(row.key).px(8).py(6).text_size(11).text_color(t.dim).child(row.label);
    const highlighted = row.key === this.highlightedKey;
    return Button.new(row.id ? `space-option-${row.id}` : row.key).min_h(32).w_full().px(8).py(5).gap(8).rounded(6).items_center().justify_start().text_left()
      .bg(highlighted ? t.selected : t.popover).text_color(row.enabled ? t.foreground : t.dim).text_size(12).disabled(!row.enabled)
      .hover(style => style.bg(t.hover)).focus(style => style.border_color(t.accent)).role("list_box_option").aria_selected(Boolean(row.selected))
      .when(highlighted, el => el.aria_active_descendant()).accessibility_label(`${row.label}${row.machine ? " on " + row.machine : ""}${row.selected ? ", selected" : ""}`)
      .on_click((_event, cx) => { if (this.suppressClick === row.key) { this.suppressClick = null; return; } this.activate(row.key, cx); })
      .when(row.kind === "space", el => el
        .on_mouse_down("right", () => { if (resolveSpaceAction(row.key, this.liveState())) this.menu(row.data.w); })
        .on_mouse_down("left", () => { this.pressedId = row.id; this.suppressClick = null; })
        .on_mouse_up("left", (_event, cx) => {
          const from = this.pressedId; this.pressedId = null;
          if (!from || from === row.id) return;
          this.suppressClick = row.key;
          const live = this.liveState(), source = live.spaces.find(space => space.id === from), target = live.spaces.find(space => space.id === row.id);
          if (source && target && (source.machine ?? null) === (target.machine ?? null) && resolveSpaceAction(row.key, live))
            run("space.move", { id: source.id, index: live.spaces.findIndex(space => space.id === target.id) + 1 });
          cx.notify();
        }))
      .when(row.kind === "space", el => el
        .when(Boolean(row.tree), child => child.pl(16).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.muted)))
        .when(!row.tree, child => child.child(this.avatar(row.data.w, t)))
        .child(div().min_w(0).truncate().child(row.label))
        .child(row.data.g ? this.gitTail(row.data.g, row.tree, row.label, t) : div().flex_1())
        .when(["blocked", "done"].includes(row.data.w.status), child => child.child(div().size(5).rounded(3).bg(tone(t, row.data.w.status)))))
      .when(row.kind === "create", el => el.child(svg("mods/workspace-chrome/plus.svg").size(14)).child(row.label));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const current = this.currentSpace(sp), rows = this.menuRows(), active = rows.filter(row => row.enabled);
    if (this.highlightedKey === null) this.highlightedKey = active.find(row => row.selected)?.key ?? active[0]?.key ?? null;
    const label = current ? `Space: ${current.name}${current.machine ? " on " + current.machine : ""}` : "Choose a space";
    const trigger = Button.new("space-selector-trigger").h(32).w_full().min_w(0).px(collapsed ? 4 : 8).gap(collapsed ? 0 : 8).rounded(7).relative()
      .when(!collapsed, el => el.justify_start().text_left())
      .bg(t.raised).text_color(t.foreground).border(1).border_color(t.border).hover(style => style.bg(t.hover))
      .focus(style => style.border_color(t.accent)).track_focus(this.triggerFocus).accessibility_label(label).tooltip(label)
      .on_mouse_down("right", () => { if (current && resolveSpaceAction("space:" + current.id, this.liveState())) this.menu(current); })
      .on_key_down((event, cx) => {
        if (["down", "up"].includes(String(event.key ?? event.keystroke).toLowerCase())) { this.open = true; this.menuFocus.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(current ? this.avatar(current, t) : svg("mods/workspace-chrome/monitor.svg").size(18))
      .when(!collapsed, el => el.child(div().flex_1().min_w(0).truncate().child(current?.name ?? "Choose space")))
      .when(Boolean(current && ["blocked", "done"].includes(current.status)), el => el.child(div().id("space-current-attention").size(5).rounded(3).bg(tone(t, current.status))
        .when(collapsed, child => child.absolute().right(2).top(2))))
      .when(!collapsed, el => el.child(svg("mods/workspace-chrome/chevron-down.svg").size(12).text_color(t.muted)));
    const popup = Popover.new("space-selector").open(this.open).anchor("top_left").track_focus(this.menuFocus)
      .on_open_change((open, cx) => {
        this.open = open; this.menuError = null; this.pressedId = null;
        if (open) { this.highlightedKey = this.menuRows().find(row => row.selected && row.enabled)?.key ?? active[0]?.key ?? null; }
        else this.triggerFocus.focus();
        cx.notify();
      }).trigger(trigger)
      .content(v_flex().id("space-selector-menu").w(300).max_h(360).p(5).gap(2).bg(t.popover).rounded(8).border(1).border_color(t.border)
        .overflow_y_scrollbar().track_focus(this.menuFocus).role("list_box").accessibility_label("Spaces")
        .on_key_down((event, cx) => this.menuKey(event, cx)).children(rows.map(row => this.option(row, t)))
        .when(Boolean(this.menuError), el => el.child(div().px(8).py(5).text_size(11).text_color(t.blocked).child(this.menuError))));
    return h_flex().size_full().min_w(0).px(collapsed ? 4 : 8).items_center().bg(t.chrome).text_size(13)
      .child(div().flex_1().min_w(0).child(popup));
  }

  close() { this.watching.clear(); this.triggerFocus.release(); this.menuFocus.release(); }
}
