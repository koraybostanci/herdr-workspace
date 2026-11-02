import assert from "node:assert/strict";
import test from "node:test";
import { loadHerdrMod } from "./helpers/load-herdr-mod.mjs";
import { state, context, render, text, find } from "./helpers/herdr-runtime.mjs";
import { historySpace, historyEntry, historyRegistry } from "./helpers/session-history-fixtures.mjs";
import { createHistoryView } from "../integrations/session-metadata/src/history-view.mjs";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";

const { default: SpaceAgents } = await loadHerdrMod("mods/space-agents");
const program = { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: false, agent: true };
function fixture(saved = {}) {
  state.data = { allSpaces: [{ ...historySpace, name: "First", active: true, tabs: [{ id: "tab1" }] },
    { ...historySpace, id: "two", name: "Second", folder: "/other", tabs: [{ id: "tab2" }] }],
  allAgents: [{ address: "a1", pane: "p1", tab: "tab1", space: "one", title: "First task", program },
    { address: "a2", pane: "p2", tab: "tab2", space: "two", title: "Second task", program }],
  allPanes: [], allTerminals: [], allMachines: [], selectedSpace: "one" };
  state.commands = []; state.tasks = []; state.timers = []; state.shared = saved; state.files = {};
  state.width = 320; state.layout = null; state.props = null; state.focusedHandle = null; state.execute = null; state.theme = null;
  const view = new SpaceAgents(); view.init({ tree: true }, context()); return view;
}
function click(tree, id) { const node = find(tree, id); assert.ok(node, id); node.attributes.on_click[0]({}, context()); }
function seed(view, id, entries) {
  const controller = view.controllers.get(id), space = controller.space;
  const request = { space, view: controller.mode ?? "recent", query: controller.query, offset: 0, limit: 50, requestId: `seed-${id}` };
  controller.currentRequest = request;
  assert.equal(controller.acceptPage(createHistoryView(historyRegistry(entries), request), request), true);
}
function ownedRuntime() {
  state.files = { "/fixture/herdr/data/space-agents/runtime.json": JSON.stringify({ schema: 1, owner: "herdr-session-metadata", node: "/verified/node", stateRoot: "/fixture/state",
    helperPath: "/fixture/herdr/integrations/session-metadata/releases/11111111-1111-4111-8111-111111111111/bin/herdr-session-meta.mjs" }) };
}

test("Agents directly owns Space cards and History defaults to a bottom collapsed area", () => {
  const tree = render(fixture({ "space-agents.sections": { history: false } }));
  const agents = find(tree, "agents-area"), history = find(tree, "history-area");
  assert.ok(agents); assert.ok(history); assert.ok(tree.nodes.indexOf(history) > tree.nodes.indexOf(agents));
  assert.ok(agents.attributes.flex_1); assert.equal(history.attributes.h[0], 38);
  assert.ok(text(agents).includes("Agents")); assert.ok(!text(agents).includes("Spaces"));
  assert.equal(find(agents, "agents-section-toggle"), undefined);
  assert.equal(find(agents, "session-history"), undefined);
  assert.ok(find(find(agents, "space-tree-children-one"), "space-agent-a1"));
  assert.equal(find(history, "history-space-tree-list"), undefined);
  assert.deepEqual(find(tree, "history-area-toggle").attributes.accessibility_label, ["Expand History"]);
  assert.ok(find(tree, "history-area-toggle").attributes.justify_start);
});

test("History expansion and Space browsing stay independent from Agents and workspace selection", () => {
  const view = fixture(); click(render(view), "history-area-toggle");
  click(render(view), "history-space-tree-name-two");
  const tree = render(view);
  assert.ok(find(find(tree, "agents-area"), "space-agent-a1"));
  assert.ok(find(find(tree, "history-area"), "history-space-tree-children-two"));
  assert.deepEqual(find(tree, "space-tree-name-one").attributes.aria_selected, [true]);
  assert.deepEqual(find(tree, "history-space-tree-name-two").attributes.aria_selected, [true]);
  assert.equal(find(find(tree, "history-area"), "space-agent-a2"), undefined);
  assert.equal(find(tree, "session-history-toggle"), undefined);
  assert.equal(find(tree, "history-space-tree-new-local"), undefined);
  assert.deepEqual(state.commands, []); assert.equal(state.data.selectedSpace, "one");
  seed(view, "two", [historyEntry("saved-two", { title: "Second saved", directory: "/other" })]);
  assert.ok(text(find(render(view), "history-area")).includes("Second saved"));
  click(render(view), "space-tree-toggle-two");
  click(render(view), "history-space-tree-name-one");
  const next = render(view);
  assert.ok(find(find(next, "agents-area"), "space-agent-a2"));
  assert.ok(find(find(next, "history-area"), "history-space-tree-children-one"));
  assert.deepEqual(state.commands, []);
});

test("closing History restores working space without collapsing the Agents branch", () => {
  const view = fixture(); click(render(view), "history-area-toggle");
  click(render(view), "history-space-tree-name-two");
  assert.ok(find(render(view), "agent-history-split"));
  click(render(view), "history-area-toggle");
  const tree = render(view);
  assert.equal(find(tree, "history-area").attributes.h[0], 38);
  assert.equal(find(tree, "history-space-tree-list"), undefined);
  assert.ok(find(tree, "space-agent-a1"));
});

test("History and Agents share one Space partition so browsing cannot duplicate an active session", () => {
  const view = fixture(), f = metadataFixture(), binding = { ...f.binding, terminal: "a1", lookupDir: "/repo", browsing: true };
  const proof = { key: bindingKey(binding), generation: binding.generation };
  state.data.allTerminals = [{ address: "a1", created_ms: 100, state: "live", labels: { "herdr.meta-binding": JSON.stringify(proof) } }];
  state.data.allPanes = [{ pane: "p1", terminal: "a1", tab: "tab1", cwd: "/repo", program }];
  view.sessionView = { schema: 1, owner: "herdr-session-metadata", entries: [{ binding, record: { ...f.record, canonicalTitle: "Browsing session", bindings: [proof] } }] };
  click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view);
  seed(view, "one", [historyEntry("ses_fixture_A", { session: f.key, bindings: [{ ...binding, address: "a1", pane: "p1", tab: "tab1", space: historySpace,
    presence: "open", connection: "confirmed", activity: "idle" }] })]);
  const key = '["local","local","opencode-v2","ses_fixture_A"]';
  let tree = render(view);
  assert.ok(find(find(tree, "history-area"), `session-history-${key}`));
  assert.equal(find(find(tree, "agents-area"), "space-agent-a1"), undefined);
  view.sessionView.entries[0].binding = { ...binding, browsing: false };
  tree = render(view);
  assert.ok(find(find(tree, "agents-area"), "space-agent-a1"));
  assert.equal(find(find(tree, "history-area"), `session-history-${key}`), undefined);
});

test("collapsed History does not request another Space and expansion loads only the browsed one", async () => {
  const view = fixture(), requested = [];
  state.files = { "/fixture/herdr/data/space-agents/runtime.json": JSON.stringify({ schema: 1, owner: "herdr-session-metadata", node: "/verified/node", stateRoot: "/fixture/state",
    helperPath: "/fixture/herdr/integrations/session-metadata/releases/11111111-1111-4111-8111-111111111111/bin/herdr-session-meta.mjs" }) };
  state.execute = async (_command, args) => {
    if (args[1] !== "history-view") return { code: 0, stdout: "{}", stderr: "" };
    const request = JSON.parse(args[args.indexOf("--request") + 1]); requested.push(request.space.id);
    return { code: 0, stdout: JSON.stringify(createHistoryView(historyRegistry([]), request)), stderr: "" };
  };
  try {
    render(view); await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.deepEqual([...new Set(requested)], ["one"]);
    click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-two");
    render(view); await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.deepEqual([...new Set(requested)], ["one", "two"]);
  } finally { state.execute = null; }
});

test("successful deletion removes the session from other Space controllers and rejects their stale pages", async () => {
  const view = fixture(); state.data.allSpaces[1].folder = "/repo";
  const entry = historyEntry("shared"), key = '["local","local","opencode-v2","shared"]';
  click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view); seed(view, "one", [entry]);
  click(render(view), "history-space-tree-name-two"); render(view); seed(view, "two", [entry]);
  const other = view.controllers.get("two"), staleRequest = other.currentRequest;
  const stalePage = createHistoryView(historyRegistry([entry]), staleRequest);
  click(render(view), "history-space-tree-name-one"); render(view); state.tasks = [];
  state.files = { "/fixture/herdr/data/space-agents/runtime.json": JSON.stringify({ schema: 1, owner: "herdr-session-metadata", node: "/verified/node", stateRoot: "/fixture/state",
    helperPath: "/fixture/herdr/integrations/session-metadata/releases/11111111-1111-4111-8111-111111111111/bin/herdr-session-meta.mjs" }) };
  state.execute = async () => ({ code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", deleted: true, sessionKey: key }), stderr: "" });
  try {
    click(render(view), `session-history-delete-${key}`); click(render(view), `session-history-delete-confirm-${key}`);
    await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.equal(other.registry.sessions.some(row => row.session.id === "shared"), false);
    assert.equal(other.acceptPage(stalePage, staleRequest), false);
  } finally { state.execute = null; }
});

test("Spaces added after initialization acquire retained controls outside render", async () => {
  const view = fixture(); render(view);
  state.data.allSpaces.push({ ...historySpace, id: "new", name: "New", folder: "/new", tabs: [{ id: "tab3" }] });
  state.data.allAgents.push({ address: "a3", pane: "p3", tab: "tab3", space: "new", title: "New task", program });
  state.data.selectedSpace = "new";
  assert.doesNotThrow(() => render(view));
  await Promise.all(state.tasks.splice(0).map(task => task()));
  assert.ok(find(render(view), "space-agent-a3"));
});

test("returning to a cached History Space requests the newly selected history view", () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-two"); render(view);
  assert.equal(view.controllers.get("two").currentRequest.view, "recent");
  click(render(view), "history-space-tree-name-one");
  const menu = find(render(view), "session-history-view-options").attributes.content[0];
  click(menu, "session-history-view-folder");
  click(render(view), "history-space-tree-name-two"); render(view);
  assert.equal(view.controllers.get("two").currentRequest.view, "folder");
});

test("confirmed deletion invalidates a delayed resume operation in another Space", { timeout: 5000 }, async () => {
  const view = fixture(); state.data.allSpaces[1].folder = "/repo";
  const entry = historyEntry("shared"), key = '["local","local","opencode-v2","shared"]';
  click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view); seed(view, "one", [entry]);
  click(render(view), "history-space-tree-name-two"); render(view); seed(view, "two", [entry]);
  click(render(view), "history-space-tree-name-one"); render(view); state.tasks = []; ownedRuntime();
  let finishDelete, finishResume, notifyDelete, notifyResume;
  const deleteStarted = new Promise(resolve => { notifyDelete = resolve; }), resumeStarted = new Promise(resolve => { notifyResume = resolve; });
  state.execute = async (_command, args) => {
    if (args[1] === "delete-session") { notifyDelete(); return new Promise(resolve => { finishDelete = resolve; }); }
    if (args[1] === "prepare-resume") { notifyResume(); return new Promise(resolve => { finishResume = resolve; }); }
    const request = JSON.parse(args[args.indexOf("--request") + 1] ?? "null");
    return { code: 0, stdout: JSON.stringify(request ? createHistoryView(historyRegistry([entry]), request) : {}), stderr: "" };
  };
  try {
    click(render(view), `session-history-delete-${key}`); click(render(view), `session-history-delete-confirm-${key}`);
    const deleting = state.tasks.splice(0).map(task => task()); await deleteStarted;
    click(render(view), "history-space-tree-name-two"); render(view); state.tasks = [];
    click(find(render(view), "history-space-tree-children-two"), `session-history-${key}`); state.data.selectedSpace = "two";
    const opening = state.tasks.splice(0).map(task => task()); await resumeStarted; render(view);
    finishDelete({ code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", deleted: true, sessionKey: key }), stderr: "" }); await Promise.all(deleting);
    finishResume({ code: 0, stdout: JSON.stringify({ kind: "launch", sessionKey: key, command: "tab.new", args: { space: "two", folder: "/repo", argv: ["opencode", "--session", "shared"] } }), stderr: "" }); await Promise.all(opening);
    assert.equal(state.commands.some(command => command.name === "tab.new"), false);
    assert.equal(view.controllers.get("two").pending.has(key), false);
  } finally { state.execute = null; }
});

test("removed Spaces dispose their controls and cannot run queued History searches", async () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-two"); render(view);
  const controller = view.controllers.get("two"), released = [], requests = [];
  for (const name of ["search", "listHandle", "menuHandle", "deleteHandle", "agentHandle"]) controller[name].release = () => released.push(name);
  state.tasks = []; state.timers = []; ownedRuntime();
  state.execute = async (_command, args) => { requests.push(args[1]); return { code: 1, stdout: "", stderr: "unavailable" }; };
  try {
    controller.search.set_value("queued");
    const debounce = state.timers.find(timer => timer.once && timer.ms === 250);
    state.data.allSpaces = state.data.allSpaces.filter(space => space.id !== "two"); render(view);
    debounce.handler(context()); await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.equal(view.controllers.has("two"), false);
    assert.deepEqual(released.sort(), ["agentHandle", "deleteHandle", "listHandle", "menuHandle", "search"]);
    assert.equal(requests.includes("history-view"), false);
  } finally { state.execute = null; }
});

test("Agents keeps independently opened Spaces and keyboard navigation follows their combined rows", () => {
  const view = fixture();
  state.data.allSpaces[0].tabs.push({ id: "tab3" });
  state.data.allAgents.push({ address: "a3", pane: "p3", tab: "tab3", space: "one", title: "Third task", program });
  click(render(view), "space-tree-toggle-two");
  let tree = render(view);
  assert.ok(find(tree, "space-agent-a1")); assert.ok(find(tree, "space-agent-a2"));
  assert.deepEqual(state.order, ["a1", "a3", "a2"]);
  find(tree, "space-agent-list-one").attributes.track_focus[0].focus();
  find(tree, "space-agent-list-one").attributes.on_key_down[0]({ keystroke: "down" }, context());
  tree = render(view);
  find(tree, "space-agent-list-one").attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, [{ name: "pane.focus", args: { pane: "p3" } }]);
  click(tree, "space-tree-toggle-one");
  tree = render(view);
  assert.equal(find(tree, "space-agent-a1"), undefined); assert.ok(find(tree, "space-agent-a2"));
});

test("malformed saved Agent expansion falls back to the active Space", () => {
  const view = fixture({ "space-agents.tree": { expandedIds: { invalid: true } } });
  assert.ok(find(render(view), "space-agent-a1"));
});

test("one History search queries all Spaces and groups saved results without changing Agents", async () => {
  const view = fixture(); ownedRuntime();
  const requested = [], entries = [historyEntry("first", { title: "needle first", directory: "/repo" }), historyEntry("second", { title: "needle second", directory: "/other" })];
  state.execute = async (_command, args) => {
    if (args[1] !== "history-view") return { code: 0, stdout: "{}", stderr: "" };
    const request = JSON.parse(args[args.indexOf("--request") + 1]); requested.push({ space: request.space.id, query: request.query });
    return { code: 0, stdout: JSON.stringify(createHistoryView(historyRegistry(entries), request)), stderr: "" };
  };
  try {
    click(render(view), "history-area-toggle");
    assert.ok(find(render(view), "history-search-all"));
    view.historySearch.set_value("needle");
    state.timers.filter(timer => timer.once && timer.ms === 250).at(-1).handler(context());
    render(view); await Promise.all(state.tasks.splice(0).map(task => task()));
    const tree = render(view), history = find(tree, "history-area");
    assert.ok(text(history).includes("needle first")); assert.ok(text(history).includes("needle second"));
    assert.ok(find(history, "history-space-tree-children-one")); assert.ok(find(history, "history-space-tree-children-two"));
    assert.equal(find(history, "session-history-search"), undefined);
    assert.deepEqual([...new Set(requested.filter(request => request.query === "needle").map(request => request.space))].sort(), ["one", "two"]);
    assert.ok(find(find(tree, "agents-area"), "space-agent-a1")); assert.deepEqual(state.order, ["a1"]);
    assert.deepEqual(state.commands, []);
  } finally { state.execute = null; }
});

test("History has a native resize divider and remembers the height through collapse", () => {
  const view = fixture(); click(render(view), "history-area-toggle");
  let tree = render(view), split = find(tree, "agent-history-split"); assert.ok(split);
  split.attributes.on_resize[0]([400, 260], context());
  assert.equal(state.shared["space-agents.history.height"], 260);
  click(tree, "history-area-toggle");
  assert.equal(find(render(view), "agent-history-split"), undefined);
  click(render(view), "history-area-toggle");
  split = find(render(view), "agent-history-split");
  assert.equal(split.nodes[1].attributes.size[0], 260);
});

test("flat agent rows use fills for selection and reserve their outline for keyboard focus", () => {
  const view = fixture(); state.data.allAgents[0].focused = true;
  state.theme = { chrome: "#111111", surface: "#222222", selected: "#333333", accent: "#55aaff" };
  click(render(view), "space-tree-toggle-two");
  let tree = render(view);
  assert.deepEqual(find(tree, "space-agent-a1").attributes.border_color, ["#00000000"]);
  assert.deepEqual(find(tree, "space-agent-a1").attributes.bg, ["#333333"]);
  assert.deepEqual(find(tree, "space-agent-a2").attributes.bg, ["#111111"]);
  find(tree, "space-agent-list-one").attributes.track_focus[0].focus();
  tree = render(view);
  assert.deepEqual(find(tree, "space-agent-a1").attributes.border_color, ["#55aaff"]);
});

test("a row from an older global History query cannot start a resume", () => {
  const view = fixture(), key = '["local","local","opencode-v2","saved"]';
  click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view);
  seed(view, "one", [historyEntry("saved", { title: "Old result" })]);
  const row = find(render(view), `session-history-${key}`);
  view.historySearch.set_value("different"); state.timers.filter(timer => timer.once && timer.ms === 250).at(-1).handler(context());
  render(view); state.commands = []; state.tasks = [];
  row.attributes.on_click[0]({}, context());
  assert.deepEqual(state.commands, []); assert.equal(state.tasks.length, 0);
});

test("collapsing a normal or search History branch rejects a pending resume before redraw", { timeout: 5000 }, async () => {
  for (const searching of [false, true]) {
    const view = fixture(), key = '["local","local","opencode-v2","saved"]';
    click(render(view), "history-area-toggle");
    if (searching) {
      view.historySearch.set_value("saved"); state.timers.filter(timer => timer.once && timer.ms === 250).at(-1).handler(context());
    } else click(render(view), "history-space-tree-name-one");
    render(view);
    seed(view, "one", [historyEntry("saved")]); const tree = render(view); state.tasks = []; ownedRuntime();
    let finish, started;
    const ready = new Promise(resolve => { started = resolve; });
    state.execute = async (_command, args) => {
      if (args[1] === "prepare-resume") { started(); return new Promise(resolve => { finish = resolve; }); }
      return { code: 0, stdout: "{}", stderr: "" };
    };
    try {
      click(tree, `session-history-${key}`);
      const opening = state.tasks.splice(0).map(task => task()); await ready;
      click(tree, "history-space-tree-toggle-one"); click(tree, "history-space-tree-name-two");
      assert.equal((searching ? view.searchExpandedIds : view.historyTree.expandedIds).has("one"), false);
      assert.equal(view.historyVisibleIds.has("one"), true, "no redraw has updated the rendered snapshot yet");
      finish({ code: 0, stdout: JSON.stringify({ kind: "launch", sessionKey: key, command: "tab.new", args: { space: "one", folder: "/repo", argv: ["opencode", "--session", "saved"] } }), stderr: "" });
      await Promise.all(opening);
      assert.equal(state.commands.some(command => command.name === "tab.new"), false);
    } finally { state.execute = null; }
  }
});

test("History Spaces remain independently open until their own chevron is collapsed", () => {
  const view = fixture(); click(render(view), "history-area-toggle");
  click(render(view), "history-space-tree-name-one"); click(render(view), "history-space-tree-name-two");
  let tree = render(view);
  assert.ok(find(tree, "history-space-tree-children-one")); assert.ok(find(tree, "history-space-tree-children-two"));
  click(tree, "history-space-tree-toggle-one"); tree = render(view);
  assert.equal(find(tree, "history-space-tree-children-one"), undefined);
  assert.ok(find(tree, "history-space-tree-children-two")); assert.ok(find(find(tree, "agents-area"), "space-agent-a1"));
  assert.deepEqual(state.commands, []);
});

test("partial History availability stays in the Space tooltip instead of a repeated banner", () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view);
  seed(view, "one", [historyEntry("saved")]); const controller = view.controllers.get("one"); controller.page.complete = false;
  let tree = render(view);
  assert.ok(!text(find(tree, "history-area")).some(value => value.includes("Some history sources are unavailable")));
  assert.ok(find(tree, "history-space-tree-name-one").attributes.tooltip[0].includes("Some history sources are unavailable"));
  assert.equal(controller.page.complete, false);
  controller.error = "History unavailable. Retry."; tree = render(view);
  assert.ok(text(find(tree, "history-area")).includes("History unavailable. Retry."));
  assert.ok(find(tree, "session-history-retry"));
});

test("global History keyboard traversal stays inside visible matching Spaces", async () => {
  const view = fixture(); ownedRuntime();
  state.execute = async (_command, args) => {
    if (args[1] !== "history-view") return { code: 0, stdout: "{}", stderr: "" };
    const request = JSON.parse(args[args.indexOf("--request") + 1]);
    return { code: 0, stdout: JSON.stringify(createHistoryView(historyRegistry([historyEntry("match", { title: "needle", directory: "/other" })]), request)), stderr: "" };
  };
  try {
    click(render(view), "history-area-toggle"); view.historySearch.set_value("needle");
    state.timers.filter(timer => timer.once && timer.ms === 250).at(-1).handler(context()); render(view);
    await Promise.all(state.tasks.splice(0).map(task => task()));
    await Promise.all(state.tasks.splice(0).map(task => task()));
    const tree = render(view), list = find(tree, "history-space-tree-list");
    assert.equal(find(tree, "history-space-tree-name-one"), undefined);
    assert.ok(find(tree, "history-space-tree-name-two"));
    assert.equal(view.historyTree.highlightedId, "two");
    list.attributes.track_focus[0].focus();
    for (const key of ["home", "down", "up", "end"]) {
      list.attributes.on_key_down[0]({ keystroke: key }, context());
      assert.equal(view.historyTree.highlightedId, "two");
    }
    assert.deepEqual(state.commands, []);
  } finally { state.execute = null; }
});

test("History harness, session title and group headings share the Space icon and text columns", () => {
  for (const mode of ["recent", "folder", "harness"]) {
    const view = fixture({ "space-agents.history.view": mode }), key = '["local","local","opencode-v2","saved"]';
    click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view);
    seed(view, "one", [historyEntry("saved")]);
    const tree = render(view), spaceRow = find(tree, "history-space-tree-row-one"), name = find(tree, "history-space-tree-name-one");
    const markerLeft = spaceRow.attributes.px[0] + find(spaceRow, "history-space-tree-toggle-one").attributes.size[0] + spaceRow.attributes.gap[0] + name.attributes.px[0];
    const markerWidth = name.nodes[0].attributes.size[0], textLeft = markerLeft + markerWidth + name.attributes.gap[0];
    const children = find(tree, "history-space-tree-children-one"), list = find(children, "session-history-list"), row = find(list, `session-history-${key}`);
    const icon = find(row, `session-history-icon-${key}`), inset = children.attributes.pl[0] + (list.attributes.pl?.[0] ?? list.attributes.px[0]);
    const iconLeft = inset + row.attributes.px[0];
    assert.equal(iconLeft + icon.attributes.w[0] / 2, markerLeft + markerWidth / 2, mode);
    assert.equal(iconLeft + icon.attributes.w[0] + row.attributes.gap[0], textLeft, mode);
    if (mode !== "recent") assert.equal(inset + (list.nodes[0].nodes[0].attributes.pl?.[0] ?? list.nodes[0].nodes[0].attributes.px[0]), textLeft, mode);
  }
});

test("Recent tree History omits redundant date headings and retains session rows", () => {
  const view = fixture(); click(render(view), "history-area-toggle"); click(render(view), "history-space-tree-name-one"); render(view);
  seed(view, "one", [historyEntry("saved")]);
  const history = find(render(view), "history-area");
  assert.ok(text(history).includes("Saved session"));
  for (const label of ["Today", "Yesterday", "Older"]) assert.ok(!text(history).includes(label));
  assert.equal(find(history, 'session-history-["local","local","opencode-v2","saved"]').attributes.h[0], 28);
});
