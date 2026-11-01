import test from "node:test";
import assert from "node:assert/strict";
import { loadHerdrMod } from "./helpers/load-herdr-mod.mjs";
import { state, context, render, find, text } from "./helpers/herdr-runtime.mjs";
import { historySpace, historyEntry, historyRegistry } from "./helpers/session-history-fixtures.mjs";
import { createHistoryView } from "../integrations/session-metadata/src/history-view.mjs";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";

const { default: SpaceAgents } = await loadHerdrMod(new URL("../mods/space-agents", import.meta.url).pathname);
const runtime = { schema: 1, owner: "herdr-session-metadata", node: "/verified/node", stateRoot: "/fixture/state",
  helperPath: "/fixture/herdr/integrations/session-metadata/releases/11111111-1111-4111-8111-111111111111/bin/herdr-session-meta.mjs" };
function fixture(entries = [historyEntry()]) {
  state.data = { allSpaces: [{ ...historySpace, name: "First", active: true, tabs: [{ id: "tab1", name: "1" }] },
    { ...historySpace, id: "two", folder: "/other", name: "Second", tabs: [] }], allAgents: [], allPanes: [], allTerminals: [], selectedSpace: "one" };
  state.commands = []; state.tasks = []; state.timers = []; state.shared = {}; state.width = 320; state.layout = null;
  state.files = { "/fixture/herdr/data/space-agents/runtime.json": JSON.stringify(runtime) }; state.execute = null;
  const view = new SpaceAgents(); view.init({}, context());
  const request = { space: historySpace, view: "recent", query: "", offset: 0, limit: 50, requestId: "fixture" };
  if (view.history) { view.history.setSpace(historySpace); view.history.currentRequest = request; view.history.acceptPage(createHistoryView(historyRegistry(entries), request), request); }
  return view;
}
const key = '["local","local","opencode-v2","ses_saved"]';
test("History renders below Agents and every visible view retains its harness icon", () => {
  for (const mode of ["recent", "folder", "harness"]) for (const width of [76, 180, 320, 480]) {
    const view = fixture(); state.shared["space-agents.history.view"] = mode; state.width = width;
    const tree = render(view);
    assert.ok(find(tree, "session-history"));
    assert.ok(find(tree, `session-history-icon-${key}`)?.attributes.flex_none);
    if (width >= 160) assert.ok(text(tree).includes("Session History"));
    assert.deepEqual(state.order, []);
  }
});

test("the History heading aligns with the sidebar's leading content", () => {
  assert.ok(find(render(fixture()), "session-history-toggle").attributes.justify_start);
});

test("folder headings expose distinguishing path tails while retaining full tooltips", () => {
  const view = fixture([historyEntry("ses_a", { directory: "/repo" }), historyEntry("ses_b", { directory: "/repo/worktree",
    associations: [{ ...historySpace, associatedAt: 1000 }] })]);
  state.shared["space-agents.history.view"] = "folder";
  const output = text(render(view));
  assert.ok(output.includes("local · repo"));
  assert.ok(output.includes("local · repo/worktree"));
});
test("Space changes replace history without leaking the previous Space's sessions", () => {
  const view = fixture(); assert.ok(text(render(view)).includes("Saved session"));
  state.data.selectedSpace = "two";
  assert.ok(!text(render(view)).includes("Saved session"));
});
test("idle and done stay in Agents, then a confirmed exit moves the same session to History", () => {
  const f = metadataFixture(), binding = { ...f.binding, terminal: "t1", lookupDir: "/repo" };
  const proof = { key: bindingKey(binding), generation: binding.generation };
  const entry = historyEntry("ses_fixture_A", { session: f.key, bindings: [{ ...binding, space: historySpace, tab: "tab1", address: "t1", pane: "p1", presence: "open", connection: "confirmed", activity: "idle" }] });
  const view = fixture([entry]);
  const program = { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: false, agent: true };
  state.data.allAgents = [{ address: "t1", pane: "p1", space: "one", tab: "tab1", title: "Saved session", program, status: "idle" }];
  state.data.allPanes = [{ pane: "p1", terminal: "t1", tab: "tab1", cwd: "/repo", program }];
  state.data.allTerminals = [{ address: "t1", created_ms: 100, state: "live", labels: { "herdr.meta-binding": JSON.stringify(proof) } }];
  view.sessionView = { schema: 1, owner: "herdr-session-metadata", entries: [{ binding, record: { ...f.record, canonicalTitle: "Saved session", bindings: [proof] } }] };
  for (const status of ["idle", "done"]) {
    state.data.allAgents[0].status = status;
    assert.ok(find(render(view), "space-agent-t1"));
    assert.equal(find(render(view), 'session-history-["local","local","opencode-v2","ses_fixture_A"]'), undefined);
  }
  state.data.allAgents = []; state.data.allPanes = []; state.data.allTerminals = []; view.sessionView = null;
  const request = view.history.currentRequest;
  view.history.acceptPage(createHistoryView(historyRegistry([{ ...entry, bindings: [] }]), request), request);
  assert.ok(find(render(view), 'session-history-["local","local","opencode-v2","ses_fixture_A"]'));
  assert.deepEqual(state.order, []);
});
test("a disconnected known agent remains visible with a warning rather than disappearing", () => {
  const f = metadataFixture(), entry = historyEntry("ses_fixture_A", { session: f.key, bindings: [{ ...f.binding, space: historySpace, tab: "tab1", address: "t1", pane: null, presence: "unknown", connection: "unavailable", activity: "idle" }] });
  assert.ok(text(render(fixture([entry]))).includes("Connection unavailable"));
});
test("pointer and keyboard Resume use the same exact target and duplicate activation launches once", async () => {
  const view = fixture(), tree = render(view); state.tasks = [];
  let prepares = 0;
  state.execute = async (_command, args) => {
    assert.equal(args[1], "prepare-resume"); prepares++;
    return { code: 0, stdout: JSON.stringify({ kind: "launch", sessionKey: key, command: "tab.new", args: { space: "one", folder: "/repo", name: "Saved session", argv: ["opencode", "--session", "ses_saved"] } }) };
  };
  find(tree, `session-history-resume-${key}`).attributes.on_click[0]({}, context());
  find(tree, "session-history-list").attributes.on_key_down[0]({ keystroke: "enter" }, context());
  await Promise.all(state.tasks.splice(0).map(task => task()));
  assert.equal(prepares, 1);
  assert.deepEqual(state.commands, [{ name: "tab.new", args: { space: "one", folder: "/repo", name: "Saved session", argv: ["opencode", "--session", "ses_saved"] } }]);
  assert.ok(text(render(view)).includes("Opening…"));
  state.execute = null;
});
test("history view choice persists and collapsed History does not hide Agents", () => {
  const view = fixture(), menu = find(render(view), "session-history-view-options").attributes.content[0];
  find(menu, "session-history-view-folder").attributes.on_click[0]({}, context());
  assert.equal(state.shared["space-agents.history.view"], "folder");
  find(render(view), "session-history-toggle").attributes.on_click[0]({}, context());
  assert.equal(find(render(view), `session-history-${key}`), undefined);
  assert.ok(find(render(view), "space-agent-list-one"));
});

test("search and failed refresh states preserve usable known history", () => {
  const view = fixture();
  view.history.search.set_value("no such session");
  assert.ok(text(render(view)).includes("No matching sessions in this Space."));
  view.history.search.set_value(""); view.history.error = "History unavailable. Retry.";
  const tree = render(view);
  assert.ok(find(tree, `session-history-${key}`));
  assert.ok(find(tree, "session-history-retry"));
});

test("incomplete discovery never claims the Space has no saved sessions", () => {
  const view = fixture([]); view.history.page.complete = false;
  const output = text(render(view));
  assert.ok(output.includes("No sessions found in the available history sources."));
  assert.ok(!output.includes("No saved sessions in this Space yet."));
});

test("unverified saved availability is labelled rather than claimed as confirmed", () => {
  assert.ok(text(render(fixture([historyEntry("ses_saved", { saved: "checking" })]))).includes("Checking saved-session availability…"));
});

test("malformed and stale-query pages cannot erase the last valid registry", () => {
  const view = fixture(), request = view.history.currentRequest;
  const page = createHistoryView(historyRegistry([historyEntry()]), request);
  assert.equal(view.history.acceptPage({ ...page, sources: undefined }, request), false);
  assert.equal(view.history.registry.sessions.length, 1);
  view.history.search.set_value("new query");
  assert.equal(view.history.acceptPage(page, request), false);
});

test("additional pages append without duplicate sessions and Agents can fold independently", () => {
  const view = fixture(), entries = Array.from({ length: 51 }, (_, i) => historyEntry(`ses_${i}`, { updatedAt: i }));
  const firstRequest = { ...view.history.currentRequest, requestId: "page1" };
  view.history.currentRequest = firstRequest;
  view.history.acceptPage(createHistoryView(historyRegistry(entries), firstRequest), firstRequest);
  const nextRequest = { ...firstRequest, offset: 50, requestId: "page2" };
  view.history.currentRequest = nextRequest;
  view.history.acceptPage(createHistoryView(historyRegistry(entries), nextRequest), nextRequest, true);
  assert.equal(view.history.registry.sessions.length, 51);
  find(render(view), "agents-section-toggle").attributes.on_click[0]({}, context());
  assert.ok(find(render(view), 'session-history-["local","local","opencode-v2","ses_50"]'));
});

test("failed Resume leaves the History row with a useful error and no launch", async () => {
  const view = fixture(), tree = render(view); state.tasks = [];
  state.execute = async () => ({ code: 0, stdout: JSON.stringify({ error: "session-missing" }) });
  find(tree, `session-history-resume-${key}`).attributes.on_click[0]({}, context());
  await Promise.all(state.tasks.splice(0).map(task => task()));
  assert.deepEqual(state.commands, []);
  assert.ok(text(render(view)).includes("Saved session no longer exists."));
  state.execute = null;
});

test("switching Spaces while a helper response is pending discards that response", async () => {
  const view = fixture(); state.tasks = [];
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  state.execute = async (_command, args) => {
    const request = JSON.parse(args[args.indexOf("--request") + 1]);
    return new Promise(resolve => { finish = () => resolve({ code: 0, stdout: JSON.stringify(createHistoryView(historyRegistry([historyEntry()]), request)) }); started(); });
  };
  view.history.refresh(context());
  const task = state.tasks.shift()(); await ready;
  state.data.selectedSpace = "two"; render(view); finish(); await task;
  assert.ok(!text(render(view)).includes("Saved session"));
  state.execute = null;
});

test("history calls reject unowned runtime descriptors before executing a helper", async () => {
  const view = fixture();
  state.files["/fixture/herdr/data/space-agents/runtime.json"] = JSON.stringify({ ...runtime, owner: "foreign" });
  state.execute = () => assert.fail("unowned helper must not execute");
  await assert.rejects(view.history.call("history-view", {}), /metadata-unavailable/);
  state.execute = null;
});
