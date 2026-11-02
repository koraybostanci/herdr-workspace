/*
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Herdr v0.1.9, defaults/mods/workspace-chrome/main.js:
 * https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/workspace-chrome/main.js
 * Modified by koraybostanci in 2026: dedicated sidebar header, removed footer mode and adjusted titlebar spacing.
 * Copyright (c) 2026 koraybostanci (modifications only).
 * See LICENSE and NOTICE in this mod directory.
 */

import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, shared, setShared, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceHeader extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  render() {
    const t = theme(), collapsed = narrow(), w = window();
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      .when(!(collapsed && w?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
