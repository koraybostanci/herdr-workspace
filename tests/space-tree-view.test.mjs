import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadHerdrMod } from "./helpers/load-herdr-mod.mjs";
import { state, context, render, text, find, div } from "./helpers/herdr-runtime.mjs";
import { historySpace, historyEntry, historyRegistry } from "./helpers/session-history-fixtures.mjs";
import { createHistoryView } from "../integrations/session-metadata/src/history-view.mjs";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";

const { default: SpaceAgents } = await loadHerdrMod("mods/space-agents");
const program = { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: false, agent: true };
function fixture(saved = {}) {
  state.data = {
    allSpaces: [{ ...historySpace, name: "First", active: true, tabs: [{ id: "tab1" }] },
      { ...historySpace, id: "two", name: "Second", folder: "/other", tabs: [{ id: "tab2" }] }],
    allAgents: [{ address: "a1", pane: "p1", tab: "tab1", space: "one", title: "First task", program },
      { address: "a2", pane: "p2", tab: "tab2", space: "two", title: "Second task", program }],
    allPanes: [], allTerminals: [], allMachines: [], selectedSpace: "one",
  };
  state.commands = []; state.tasks = []; state.timers = []; state.shared = saved;
  state.width = 320; state.layout = null; state.focusedHandle = null; state.files = {}; state.execute = null; state.props = null;
  const view = new SpaceAgents(); view.init({ tree: true }, context());
  return view;
}
const click = (tree, id) => { const node = find(tree, id); assert.ok(node, id); node.attributes.on_click[0]({}, context()); };
const savedKey = '["local","local","opencode-v2","ses_second"]';
function seedHistory(view) {
  const controller = view.controllers.get("two");
  const space = { ...historySpace, id: "two", folder: "/other" };
  const request = { space, view: "recent", query: "", offset: 0, limit: 50, requestId: "second" };
  controller.currentRequest = request;
  return controller.acceptPage(createHistoryView(historyRegistry([historyEntry("ses_second", { directory: "/other", title: "Second saved" })]), request), request);
}

test("the native host can initialize the mod without layout props", () => {
  fixture();
  const view = new SpaceAgents(); view.init(undefined, context());
  assert.ok(text(render(view)).includes("First task"));
});

test("native layout props enable the Spaces tree even when init receives no tree option", () => {
  for (const initialProps of [undefined, {}]) {
    fixture(); state.props = { tree: true };
    const view = new SpaceAgents(); view.init(initialProps, context());
    const tree = render(view);
    assert.ok(find(tree, "space-tree-list"));
    assert.ok(find(tree, "space-tree-name-one")); assert.ok(find(tree, "space-tree-name-two"));
    assert.ok(find(find(tree, "space-tree-children-one"), "space-agent-list-one"));
  }
});

test("the installed layout gives the tree one flexible sidebar block, not a separate dropdown", async () => {
  const layout = JSON.parse(await readFile(new URL("../layouts/herdr-workspace.json", import.meta.url), "utf8"));
  const lists = layout.children.find(n => n.id === "sidebar").children.find(n => n.id === "sidebar-lists");
  assert.equal(lists.children.length, 1);
  assert.equal(lists.children[0].content.mod, "space-agents");
  assert.equal(lists.children[0].content.props.tree, true);
  assert.deepEqual(lists.children[0].size, { weight: 1 });
});

test("all Space names remain visible and only the expanded Space owns the indented sections", () => {
  const tree = render(fixture());
  assert.ok(text(tree).includes("First")); assert.ok(text(tree).includes("Second"));
  assert.ok(find(find(tree, "space-tree-branch-one"), "space-agent-a1"));
  assert.equal(find(tree, "space-agent-a2"), undefined);
  assert.ok(find(tree, "space-tree-children-one").attributes.pl[0] > 0);
  assert.ok(text(tree).includes("History")); assert.ok(!text(tree).includes("Session History"));
  assert.equal(find(tree, "session-history-search"), undefined, "History starts folded");
});

test("tree agent cards are dense two-line rows in both agent views", () => {
  for (const mode of ["list", "repository"]) {
    const view = fixture(); state.shared["space-agents.view"] = mode;
    state.data.allPanes = [{ pane: "p1", tab: "tab1", cwd: "/repos/project/api", branch: "feature/change" }];
    const tree = render(view), card = find(tree, "space-agent-a1");
    const padding = card.attributes.py?.[0] ?? card.attributes.p?.[0] ?? 0;
    const declaredHeight = card.nodes.reduce((sum, row) => sum + (row.attributes.h?.[0] ?? 0), 0)
      + padding * 2 + (card.attributes.gap?.[0] ?? 0) + (card.attributes.border?.[0] ?? 0) * 2;
    assert.ok(declaredHeight <= 44, `${mode}: ${declaredHeight}px is too tall`);
    const label = text(card);
    assert.ok(label.includes("feature/change") && !label.includes("Detached"));
    assert.equal(label.includes("api ·"), mode === "list", `${mode}: the repository name belongs on the card only in the list view`);
  }
});

test("agent harness and text columns align with their Space icon and name", () => {
  for (const mode of ["list", "repository"]) {
    const view = fixture(); state.shared["space-agents.view"] = mode;
    const tree = render(view), row = find(tree, "space-tree-row-one"), name = find(tree, "space-tree-name-one");
    const markerLeft = row.attributes.px[0] + find(row, "space-tree-toggle-one").attributes.size[0] + row.attributes.gap[0] + name.attributes.px[0];
    const markerWidth = name.nodes[0].attributes.size[0], spaceTextLeft = markerLeft + markerWidth + name.attributes.gap[0];
    const list = find(tree, "space-agent-list-one"), card = find(tree, "space-agent-a1"), titleRow = card.nodes[0], metadataRow = card.nodes[1];
    const icon = titleRow.nodes[0].nodes[0], iconWidth = icon.attributes.w?.[0] ?? icon.attributes.size[0];
    const iconLeft = find(tree, "space-tree-children-one").attributes.pl[0] + list.attributes.pl[0] + card.attributes.px[0] + card.attributes.border[0];
    assert.equal(iconLeft + iconWidth / 2, markerLeft + markerWidth / 2, mode);
    assert.equal(iconLeft + iconWidth + titleRow.attributes.gap[0], spaceTextLeft, mode);
    assert.equal(iconLeft + metadataRow.attributes.pl[0], spaceTextLeft, mode);
  }
});

test("an active agent row is separated from its selected Space header", () => {
  const view = fixture(); state.data.allAgents[0].focused = true;
  const tree = render(view), children = find(tree, "space-tree-children-one"), list = find(tree, "space-agent-list-one");
  const gap = (children.attributes.pt?.[0] ?? 0) + (list.attributes.pt?.[0] ?? 0);
  assert.ok(gap >= 4 && gap <= 8, `expected a small header-to-row gap, got ${gap}px`);
  assert.ok(find(children, "space-agent-a1"));
});

test("History leaves a small gap below the Space header without making session rows taller", () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-toggle-two"); render(view); seedHistory(view);
  const tree = render(view), children = find(tree, "history-space-tree-children-two"), list = find(children, "session-history-list");
  const gap = (children.attributes.pt?.[0] ?? 0) + (list.attributes.pt?.[0] ?? 0);
  assert.equal(gap, 4, "match the small Space-to-row gap in Agents");
  assert.equal(find(list, `session-history-${savedKey}`).attributes.h[0], 28, "keep dense History rows");
});

test("an unselected Space uses the same full-row cover for hover as selection", () => {
  for (const prefix of ["space-tree", "history-space-tree"]) {
    const view = fixture(); if (prefix === "history-space-tree") click(render(view), "history-area-toggle");
    const row = find(render(view), `${prefix}-row-two`), hover = div();
    assert.ok(row.attributes.hover, "the containing Space row owns its hover fill");
    row.attributes.hover[0](hover);
    assert.ok(hover.attributes.bg);
    for (const id of [`${prefix}-name-two`, `${prefix}-toggle-two`]) {
      const control = find(row, id), controlHover = div();
      control.attributes.hover?.[0](controlHover);
      assert.equal(controlHover.attributes.bg, undefined, `${id} must not paint a smaller hover box`);
    }
  }
});

test("selected Spaces use soft icon-matched tints with readable text in light and dark themes", () => {
  const rgb = color => color.slice(1, 7).match(/../g).map(value => parseInt(value, 16));
  const luminance = color => rgb(color).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const distance = (a, b) => Math.hypot(...rgb(a).map((value, index) => value - rgb(b)[index]));
  for (const theme of [{ chrome: "#101114", foreground: "#f0f2f5", selected: "#282b30", hover: "#202327" },
    { chrome: "#f6f7f9", foreground: "#20242a", selected: "#e0e3e8", hover: "#eceef1" }]) {
    for (const color of ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1", "#3388dd"]) {
      const view = fixture(); state.theme = theme; state.shared["space.colors"] = { one: color };
      const tree = render(view), row = find(tree, "space-tree-row-one"), marker = find(tree, "space-tree-name-one").nodes[0].attributes.bg[0];
      const tint = row.attributes.bg[0];
      assert.notEqual(tint, theme.selected);
      const amount = distance(tint, theme.chrome) / distance(marker, theme.chrome);
      assert.ok(amount > 0.05 && amount < 0.3, `${color}: selection should remain a soft tint`);
      const a = luminance(tint), b = luminance(theme.foreground);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, color);
      const selectedHover = div(), unselectedHover = div();
      row.attributes.hover[0](selectedHover); find(tree, "space-tree-row-two").attributes.hover[0](unselectedHover);
      assert.deepEqual(selectedHover.attributes.bg, [tint]); assert.deepEqual(unselectedHover.attributes.bg, [theme.hover]);
    }
  }
  state.theme = null;
});

test("the native local-machine entry never duplicates Space branches or their sections", () => {
  const view = fixture(); state.data.allMachines = [{ name: null, layout: "ready" }];
  const ids = node => [node?.attributes?.id?.[0], ...(node?.nodes ?? []).flatMap(ids)].filter(Boolean);
  const rendered = ids(render(view));
  assert.equal(rendered.filter(id => id === "space-tree-branch-one").length, 1);
  assert.equal(rendered.filter(id => id === "space-tree-branch-two").length, 1);
  assert.equal(rendered.filter(id => id === "history-area").length, 1);
});

test("live Space activity appears only in Agents, not on History Space headers", () => {
  for (const [status, color] of [["working", "#33cc66"], ["blocked", "#ffcc55"], ["done", "#8888cc"]]) {
    const view = fixture();
    state.theme = { [status]: color };
    state.data.allSpaces[0].status = status;
    click(render(view), "history-area-toggle");
    const tree = render(view), agents = find(tree, "space-tree-name-one"), history = find(tree, "history-space-tree-name-one");
    const colored = node => node.nodes.filter(child => child?.attributes?.bg?.[0] === color);
    assert.equal(colored(agents).length, 1, `${status} remains visible in Agents`);
    assert.equal(colored(history).length, 0, `${status} must not describe saved History`);
    assert.deepEqual(history.nodes[0].attributes.bg, agents.nodes[0].attributes.bg, "the Space-color marker stays in both sections");
  }
  state.theme = null;
});

test("Agents Space branches toggle independently without switching the workspace", () => {
  const view = fixture(); click(render(view), "space-tree-toggle-two");
  const tree = render(view);
  assert.ok(find(tree, "space-tree-children-one"));
  assert.ok(find(tree, "space-tree-children-two")); assert.ok(find(tree, "space-agent-a2"));
  assert.ok(find(tree, "space-agent-a1"));
  assert.deepEqual(state.commands, []); assert.equal(state.data.selectedSpace, "one");
  click(tree, "space-tree-toggle-two");
  assert.ok(find(render(view), "space-agent-a1"));
  click(render(view), "space-tree-toggle-one");
  assert.equal(find(render(view), "space-agent-a1"), undefined);
  assert.equal(find(render(view), "space-agent-a2"), undefined);
  assert.deepEqual(state.order, []);
});

test("Space labels switch and expand while agent clicks select the owner before focusing", () => {
  const view = fixture(); click(render(view), "space-tree-name-two");
  assert.deepEqual(state.commands, [{ name: "space.select", args: { id: "two" } }]);
  assert.ok(find(render(view), "space-tree-children-two"));
  state.commands = [];
  click(render(view), "space-agent-a2");
  assert.deepEqual(state.commands, [{ name: "space.select", args: { id: "two" } }, { name: "pane.focus", args: { pane: "p2" } }]);
});

test("expansion survives view recreation and changes when the active workspace changes externally", () => {
  let view = fixture(); click(render(view), "space-tree-toggle-two");
  const saved = structuredClone(state.shared); view = fixture(saved);
  assert.ok(find(render(view), "space-tree-children-two"));
  state.data.selectedSpace = "two"; render(view);
  state.data.selectedSpace = "one";
  assert.ok(find(render(view), "space-tree-children-one"));
});

test("tree keyboard arrows browse by identity and expand without selecting; Enter selects", () => {
  const view = fixture(), root = find(render(view), "space-tree-list");
  root.attributes.track_focus[0].focus();
  root.attributes.on_key_down[0]({ keystroke: "down" }, context());
  root.attributes.on_key_down[0]({ keystroke: "right" }, context());
  assert.ok(find(render(view), "space-tree-children-two")); assert.deepEqual(state.commands, []);
  state.data.allSpaces.unshift({ ...historySpace, id: "inserted", name: "Inserted", tabs: [] });
  find(render(view), "space-tree-list").attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, [{ name: "space.select", args: { id: "two" } }]);
});

test("keyboard traversal follows the displayed local-first and sorted-machine order", () => {
  const view = fixture(); state.data.allMachines = [{ name: null, layout: "ready" }, { name: "zeta", layout: "ready" }, { name: "alpha", layout: "ready" }];
  state.data.allSpaces[1].machine = "zeta";
  state.data.allSpaces.push({ ...historySpace, id: "alpha-space", machine: "alpha", name: "Alpha", tabs: [] });
  const tree = render(view), list = find(tree, "space-tree-list");
  assert.ok(text(tree).indexOf("Alpha") < text(tree).indexOf("Second"));
  list.attributes.track_focus[0].focus();
  list.attributes.on_key_down[0]({ keystroke: "down" }, context());
  list.attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, [{ name: "space.select", args: { id: "alpha-space" } }]);
});

test("a removed or disconnected Space refuses stale expansion, selection and context actions", () => {
  const view = fixture(); state.data.allSpaces[1].machine = "devbox";
  state.data.allMachines = [{ name: "devbox", layout: "ready" }];
  const tree = render(view);
  state.data.allMachines[0].layout = "unavailable";
  click(tree, "space-tree-name-two"); click(tree, "space-tree-toggle-two");
  assert.equal(find(render(view), "space-tree-children-two"), undefined);
  state.data.allSpaces = [];
  click(tree, "space-tree-name-one");
  assert.deepEqual(state.commands, []);
});

test("History loads for an inactive Space and hidden branch responses cannot populate the visible branch", () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-toggle-two"); render(view);
  assert.equal(seedHistory(view), true);
  assert.ok(find(render(view), `session-history-${savedKey}`));
  click(render(view), "history-space-tree-toggle-two"); click(render(view), "history-space-tree-toggle-one"); render(view);
  assert.equal(seedHistory(view), true, "the hidden Space can retain its own response in cache");
  assert.equal(find(render(view), `session-history-${savedKey}`), undefined);
});

test("opening inactive-Space History selects its owner and resumes the exact saved conversation", async () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-toggle-two"); render(view); seedHistory(view);
  state.tasks = [];
  state.execute = async () => ({ code: 0, stdout: JSON.stringify({ kind: "launch", sessionKey: savedKey, command: "tab.new",
    args: { space: "two", folder: "/other", argv: ["opencode", "--session", "ses_second"] } }) });
  try {
    state.files = { "/fixture/herdr/data/space-agents/runtime.json": JSON.stringify({ schema: 1, owner: "herdr-session-metadata", node: "/verified/node", stateRoot: "/fixture/state",
      helperPath: "/fixture/herdr/integrations/session-metadata/releases/11111111-1111-4111-8111-111111111111/bin/herdr-session-meta.mjs" }) };
    click(render(view), `session-history-${savedKey}`);
    assert.deepEqual(state.commands, [{ name: "space.select", args: { id: "two" } }]);
    state.data.selectedSpace = "two";
    await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.deepEqual(state.commands[1], { name: "tab.new", args: { space: "two", folder: "/other", argv: ["opencode", "--session", "ses_second"] } });
  } finally { state.execute = null; }
});

test("the narrow rail keeps every Space reachable and offers an expand control", () => {
  const view = fixture(); state.width = 44;
  const tree = render(view);
  assert.ok(find(tree, "space-tree-name-one")); assert.ok(find(tree, "space-tree-name-two"));
  assert.equal(find(tree, "space-agent-sections"), undefined);
  click(tree, "expand-space-sidebar");
  assert.deepEqual(state.commands, [{ name: "layout.resize", args: { id: "sidebar", px: 320 } }]);
});

test("space context menus and reordering target exact identities on the same machine", () => {
  const view = fixture(), tree = render(view);
  find(tree, "space-tree-row-two").attributes.on_mouse_down[1]({}, context());
  assert.deepEqual(state.commands[0], { name: "overlay.open", args: { mod: "menu", kind: "popup", width: 200, height: 260,
    props: { tab: "space", target: { id: "two" } } } });
  state.commands = [];
  find(tree, "space-tree-name-two").attributes.on_mouse_down[1]({}, context());
  find(tree, "space-tree-name-one").attributes.on_mouse_up[1]({}, context());
  click(tree, "space-tree-name-one");
  assert.deepEqual(state.commands, [{ name: "space.move", args: { id: "two", index: 1 } }]);
});

test("new-space actions retain the exact remote machine and refuse disconnected targets", () => {
  const view = fixture(); state.data.allSpaces[1].machine = "devbox";
  state.data.allMachines = [{ name: "devbox", layout: "ready" }];
  const tree = render(view);
  click(tree, "space-tree-new-devbox");
  assert.deepEqual(state.commands, [{ name: "space.new", args: { machine: "devbox" } }]);
  state.data.allMachines[0].layout = "unavailable"; state.commands = [];
  click(tree, "space-tree-new-devbox");
  assert.deepEqual(state.commands, []);
});

test("new-space controls belong to machine headings, not the Spaces heading", () => {
  const view = fixture(); state.data.allMachines = [{ name: null, layout: "ready" }, { name: "devbox", layout: "ready" }];
  const tree = render(view);
  assert.equal(find(tree, "space-tree-new"), undefined);
  assert.ok(find(find(tree, "space-tree-machine-local"), "space-tree-new-local"));
  assert.ok(find(find(tree, "space-tree-machine-devbox"), "space-tree-new-devbox"));
  click(tree, "space-tree-new-local"); click(tree, "space-tree-new-devbox");
  assert.deepEqual(state.commands, [{ name: "space.new", args: {} }, { name: "space.new", args: { machine: "devbox" } }]);
});

test("a local-only setup keeps a machine-specific new-space control, even with no Spaces yet", () => {
  for (const empty of [false, true]) {
    const view = fixture(); state.data.allMachines = [{ name: null, layout: "ready" }];
    if (empty) state.data.allSpaces = [];
    const tree = render(view);
    assert.ok(find(find(tree, "space-tree-machine-local"), "space-tree-new-local"));
    click(tree, "space-tree-new-local");
    assert.deepEqual(state.commands, [{ name: "space.new", args: {} }]);
  }
});

test("a bound inactive-Space agent retains its owner even if a later render browses another Space", () => {
  const view = fixture(); click(render(view), "space-tree-toggle-two"); render(view);
  const space = { ...historySpace, id: "two", folder: "/other" };
  const f = metadataFixture();
  const row = historyEntry("ses_fixture_A", { session: f.key, directory: "/other", bindings: [{
    ...f.binding, terminal: "bound", space, address: "bound", pane: "bound-pane", presence: "open", connection: "confirmed", activity: "idle",
  }] });
  const request = { space, view: "recent", query: "", offset: 0, limit: 50, requestId: "bound" };
  view.history.currentRequest = request;
  assert.equal(view.history.acceptPage(createHistoryView(historyRegistry([row]), request), request), true);
  const card = find(render(view), "space-agent-bound"); assert.ok(card);
  click(render(view), "space-tree-toggle-one"); render(view);
  card.attributes.on_click[0]({}, context());
  assert.deepEqual(state.commands, [{ name: "space.select", args: { id: "two" } }, { name: "pane.focus", args: { pane: "bound-pane" } }]);
});

test("an old History row cannot open in a newly expanded Space, even when both share a directory", () => {
  const view = fixture(); state.data.allSpaces[0].folder = "/other";
  click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-toggle-two"); render(view); seedHistory(view);
  const row = find(render(view), `session-history-${savedKey}`);
  click(render(view), "history-space-tree-toggle-two"); click(render(view), "history-space-tree-toggle-one"); render(view); state.tasks = [];
  row.attributes.on_click[0]({}, context());
  assert.deepEqual(state.commands, []); assert.equal(state.tasks.length, 0);
});

test("History folding and unfocused tree keyboard activation never select a Space", () => {
  const view = fixture(); let tree = render(view);
  click(tree, "history-area-toggle");
  click(render(view), "history-space-tree-name-one");
  assert.ok(find(render(view), "history-search-all"));
  tree = render(view);
  state.focusedHandle = null;
  find(tree, "space-tree-list").attributes.on_key_down[0]({ keystroke: "down" }, context());
  find(tree, "space-tree-list").attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, []);
});

test("repository group headers have a raised background so they stand apart from the cards", () => {
  const view = fixture(); state.shared["space-agents.view"] = "repository";
  const walk = node => node?.attributes?.id?.[0]?.startsWith?.("space-agent-group-toggle-") ? node : (node?.nodes ?? []).map(walk).find(Boolean);
  const header = walk(render(view));
  assert.ok(header, "group header renders");
  assert.ok(header.attributes.bg?.length, "group header has a background");
});
