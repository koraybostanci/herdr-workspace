import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadHerdrMod } from "./helpers/load-herdr-mod.mjs";
import { state, context, render, text, find } from "./helpers/herdr-runtime.mjs";
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
  const space = { ...historySpace, id: "two", folder: "/other" };
  const request = { space, view: "recent", query: "", offset: 0, limit: 50, requestId: "second" };
  view.history.currentRequest = request;
  return view.history.acceptPage(createHistoryView(historyRegistry([historyEntry("ses_second", { directory: "/other", title: "Second saved" })]), request), request);
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
    assert.ok(find(find(tree, "space-tree-children-one"), "agents-section-toggle"));
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

test("the native local-machine entry never duplicates Space branches or their sections", () => {
  const view = fixture(); state.data.allMachines = [{ name: null, layout: "ready" }];
  const ids = node => [node?.attributes?.id?.[0], ...(node?.nodes ?? []).flatMap(ids)].filter(Boolean);
  const rendered = ids(render(view));
  assert.equal(rendered.filter(id => id === "space-tree-branch-one").length, 1);
  assert.equal(rendered.filter(id => id === "space-tree-branch-two").length, 1);
  assert.equal(rendered.filter(id => id === "session-history").length, 1);
});

test("expanding another Space collapses the previous one without switching the workspace", () => {
  const view = fixture(); click(render(view), "space-tree-toggle-two");
  const tree = render(view);
  assert.equal(find(tree, "space-tree-children-one"), undefined);
  assert.ok(find(tree, "space-tree-children-two")); assert.ok(find(tree, "space-agent-a2"));
  assert.equal(find(tree, "space-agent-a1"), undefined);
  assert.deepEqual(state.commands, []); assert.equal(state.data.selectedSpace, "one");
  click(tree, "space-tree-toggle-two");
  assert.equal(find(render(view), "space-agent-sections"), undefined);
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

test("History loads for a browsed inactive Space and late responses cannot populate a different branch", () => {
  const view = fixture(); click(render(view), "space-tree-toggle-two"); render(view);
  assert.equal(seedHistory(view), true);
  click(render(view), "session-history-toggle");
  assert.ok(find(render(view), `session-history-${savedKey}`));
  click(render(view), "space-tree-toggle-one"); render(view);
  assert.equal(seedHistory(view), false);
  assert.equal(find(render(view), `session-history-${savedKey}`), undefined);
});

test("opening inactive-Space History selects its owner and resumes the exact saved conversation", async () => {
  const view = fixture(); click(render(view), "space-tree-toggle-two"); render(view); seedHistory(view);
  click(render(view), "session-history-toggle"); state.tasks = [];
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
  click(render(view), "space-tree-toggle-two"); render(view); seedHistory(view);
  click(render(view), "session-history-toggle"); const row = find(render(view), `session-history-${savedKey}`);
  click(render(view), "space-tree-toggle-one"); render(view); state.tasks = [];
  row.attributes.on_click[0]({}, context());
  assert.deepEqual(state.commands, []); assert.equal(state.tasks.length, 0);
});

test("nested section folding and keyboard activation never select a Space", () => {
  const view = fixture(); let tree = render(view);
  click(tree, "agents-section-toggle");
  assert.equal(find(render(view), "space-agent-a1"), undefined);
  click(render(view), "session-history-toggle");
  assert.ok(find(render(view), "session-history-search"));
  tree = render(view);
  state.focusedHandle = null;
  find(tree, "space-tree-list").attributes.on_key_down[0]({ keystroke: "down" }, context());
  find(tree, "space-tree-list").attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, []);
});
