import assert from "node:assert/strict";
import test from "node:test";
import { loadHerdrMod } from "./helpers/load-herdr-mod.mjs";
import { state, context, render, text, find } from "./helpers/herdr-runtime.mjs";
import { agentCards } from "../mods/space-agents/model.js";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";

const { default: SpaceAgents } = await loadHerdrMod(new URL("../mods/space-agents", import.meta.url).pathname);

const program = { name: "OpenCode", key: "opencode", icon: "icons/opencode.svg", tint: false, agent: true };
function fixture() {
  state.data = {
    allSpaces: [
      { id: "one", name: "First", machine: null, folder: "/repos/first", active: true, tabs: [{ id: "tab-1", name: "Fix login", named: true }] },
      { id: "two", name: "Second", machine: null, folder: "/repos/second", active: false, tabs: [{ id: "tab-2", name: "Deploy API", named: true }] },
    ],
    allAgents: [
      { address: "t1", pane: "p1", tab: "tab-1", space: "one", title: "Fix login", program, status: "working", focused: true },
      { address: "t2", pane: "p2", tab: "tab-2", space: "two", title: "Deploy API", program, status: "idle", focused: false },
    ],
    allPanes: [{ pane: "p1", terminal: "t1", cwd: "/repos/login", branch: "fix/login" }],
    allTerminals: [], selectedSpace: "one",
  };
  state.commands = [];
  state.openedUrls = [];
  state.tasks = [];
  state.width = 320;
  state.shared = {};
  const view = new SpaceAgents();
  view.init({}, context());
  return view;
}

function directoryGroup(node, name) {
  if (node?.attributes?.role?.[0] === "group" && node.attributes.accessibility_label?.[0]?.startsWith(`${name}, `)) return node;
  for (const child of node?.nodes ?? []) {
    const group = directoryGroup(child, name);
    if (group) return group;
  }
}

function directoryToggle(tree, name) {
  return directoryGroup(tree, name)?.nodes.find(node => ["Expand", "Collapse"].some(action => node?.attributes?.accessibility_label?.[0] === `${action} ${name}`));
}

test("populated cards render without creating native resources during render", () => {
  const tree = render(fixture());
  const output = text(tree);
  assert.ok(output.includes("Fix login"));
  assert.ok(output.includes("login"));
  assert.ok(!output.includes("OpenCode"));
  assert.ok(find(tree, "space-agent-t1").attributes.accessibility_label[0].includes("OpenCode"));
  assert.ok(!output.includes("Deploy API"));
  assert.deepEqual(state.order, ["t1"]);
});

test("metadata collection uses the installed checked release rather than the obsolete unversioned reader", async () => {
  const view=fixture();state.tasks=[];const commands=[];
  const release="/fixture/herdr/integrations/session-metadata/releases/11111111-1111-4111-8111-111111111111";
  state.files={"/fixture/herdr/data/space-agents/runtime.json":JSON.stringify({schema:1,owner:"herdr-session-metadata",node:"/verified/node",helperPath:release+"/bin/herdr-session-meta.mjs",stateRoot:"/fixture/state",buildHash:"a".repeat(64)})};
  state.execute=async(command,args)=>{commands.push({command,args});return {code:0,stdout:"{}",stderr:""};};
  try {
    view.refreshMetadata(context());await Promise.all(state.tasks.splice(0).map(task=>task()));
    assert.equal(commands[0].command,"/verified/node");assert.equal(commands[0].args[0],release+"/bin/herdr-session-meta.mjs");
    assert.ok(commands[0].args.includes("/fixture/state"));
  } finally {state.execute=null;state.files={};}
});

test("a bound session with no repo metadata cannot freeze the selected-space card list", () => {
  const view = fixture();
  const f = metadataFixture(), binding = { ...f.binding, terminal: "t1" };
  const key = bindingKey(binding);
  const record = { ...f.record, canonicalTitle: "Canonical session", activeRepo: null, contexts: {},
    bindings: [{ key, generation: binding.generation }] };
  state.data.allTerminals = [{ address: "t1", state: "live", created_ms: binding.createdMs,
    labels: { "herdr.meta-binding": JSON.stringify({ key, generation: binding.generation }) } }];
  view.sessionView = { schema: 1, owner: "herdr-session-metadata", entries: [{ binding, record }] };
  const tree = render(view);
  assert.ok(text(tree).includes("Canonical session"));
  assert.ok(text(tree).includes("login"));
  assert.ok(!find(tree, "space-agent-pr-t1"));
  assert.ok(!text(tree).includes("PR…"));
  state.data.selectedSpace = "two";
  const next = render(view);
  assert.ok(text(next).includes("Deploy API"));
  assert.ok(!text(next).includes("Canonical session"));
});

test("the same view switches its rendered cards when the selected space changes", () => {
  const view = fixture();
  render(view);
  state.data.selectedSpace = "two";
  const output = text(render(view));
  assert.ok(output.includes("Deploy API"));
  assert.ok(output.includes("second"));
  assert.ok(!output.includes("Fix login"));
  assert.deepEqual(state.order, ["t2"]);
});

test("clicking a card focuses that agent's pane", () => {
  const output = render(fixture());
  find(output, "space-agent-t1").attributes.on_click[0]();
  assert.deepEqual(state.commands, [{ name: "pane.focus", args: { pane: "p1" } }]);
});

test("an open PR is rendered as a number badge, not a full path", async () => {
  const view = fixture();
  await view.prs.refresh(agentCards(state.data)[0], async () => ({ code: 0, stdout: '[{"number":6029,"state":"OPEN"}]', stderr: "" }));
  const output = text(render(view));
  assert.ok(output.includes("#6029"));
  assert.ok(!output.includes("/repos/login"));
  state.data.selectedSpace = "two";
  assert.ok(!text(render(view)).includes("#6029"));
});

test("spaces without agents show an empty state instead of another space's agents", () => {
  const view = fixture();
  state.data.allAgents = state.data.allAgents.filter(a => a.space !== "one");
  const output = text(render(view));
  assert.ok(output.includes("No agents in this space"));
  assert.ok(!output.includes("Deploy API"));
  assert.deepEqual(state.order, []);
});

test("keyboard navigation activates the highlighted card in the current space", () => {
  const view = fixture();
  state.data.allAgents.push({ ...state.data.allAgents[0], address: "t3", pane: "p3", focused: false });
  const list = find(render(view), "space-agent-list-one");
  list.attributes.on_key_down[0]({ keystroke: "down" }, context());
  list.attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, [{ name: "pane.focus", args: { pane: "p3" } }]);
});

test("a newly reported agent appears on the next live render without a space switch", () => {
  const view = fixture();
  render(view);
  state.data.allSpaces[0].tabs.push({ id: "tab-3", name: "New session", named: true });
  state.data.allAgents.push({ ...state.data.allAgents[0], title: "New session", address: "t3", pane: "p3", tab: "tab-3", focused: false });
  const output = text(render(view));
  assert.ok(output.includes("New session"));
  assert.deepEqual(state.order, ["t1", "t3"]);
});

test("the compact expand control has an accessible name and expands the sidebar", () => {
  const view = fixture();
  state.width = 76;
  const button = find(render(view), "expand-space-sidebar");
  assert.deepEqual(button.attributes.accessibility_label, ["Expand sidebar"]);
  button.attributes.on_click[0]();
  assert.deepEqual(state.commands, [{ name: "layout.resize", args: { id: "sidebar", px: 320 } }]);
});

test("launching Claude in a numbered tab shows a focusable card before any status report", async () => {
  const view = fixture();
  await Promise.all(state.tasks.splice(0).map(task => task()));
  render(view);
  state.data.allSpaces[0].tabs.push({ id: "tab-3", name: "3", named: false });
  state.data.allPanes.push({ pane: "p3", terminal: "t1b", tab: "tab-3", title: "claude", cwd: "/repos/claude-checkout", branch: null,
    status: null, app: null, program: { ...program, key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, agent: false }, focused: false, zoomed: false, movable: false });
  const output = render(view);
  assert.ok(text(output).includes("Claude Code"));
  assert.ok(text(output).includes("No status"));
  assert.ok(find(output, "space-agent-t1b").attributes.accessibility_label[0].includes("Status unavailable"));
  assert.deepEqual(state.order, ["t1", "t1b"]);
  find(output, "space-agent-t1b").attributes.on_click[0]();
  assert.deepEqual(state.commands, [{ name: "pane.focus", args: { pane: "p3" } }]);
});

function shellFixture(stdout = "10 1 Ss /bin/zsh\n") {
  const view = fixture();
  state.tasks = [];
  state.data.allTerminals = [{ address: "t1", state: "live", created_ms: 100, pid: 10,
    foreground: { pid: 10, name: "zsh", argv: ["/bin/zsh", "-l"] } }];
  state.execute = async command => command === "ps" ? { code: 0, stdout, stderr: "" }
    : { code: 1, stdout: "", stderr: "unavailable" };
  return view;
}

test("a shell-looking row stays until a process check confirms there is no live agent child", async () => {
  const view = shellFixture();
  try {
    assert.ok(find(render(view), "space-agent-t1"), "shell state alone cannot prove that the agent exited");
    await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.equal(find(render(view), "space-agent-t1"), undefined);
    assert.deepEqual(state.order, []);
  } finally { state.execute = null; }
});

test("an interactive shell with job control disabled cannot hide a live child agent", async () => {
  const view = shellFixture("10 1 Ss /bin/zsh\n20 10 S opencode\n");
  try {
    assert.ok(find(render(view), "space-agent-t1"));
    await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.ok(find(render(view), "space-agent-t1"));
    assert.deepEqual(state.order, ["t1"]);
  } finally { state.execute = null; }
});

test("stale program detection cannot recreate a card after verified process closure", async () => {
  const view = shellFixture();
  state.data.allAgents = [];
  Object.assign(state.data.allPanes[0], { tab: "tab-1", program, title: "Old session", status: "idle" });
  try {
    render(view);
    await Promise.all(state.tasks.splice(0).map(task => task()));
    assert.equal(find(render(view), "space-agent-t1"), undefined);
  } finally { state.execute = null; }
});

test("failed, malformed and replaced-root process snapshots do not remove an agent", async () => {
  for (const response of [{ code: 1, stdout: "", stderr: "offline" }, { code: 0, stdout: "bad snapshot", stderr: "" },
    { code: 0, stdout: "20 1 S opencode\n", stderr: "" }, { code: 0, stdout: "10 1 S opencode\n", stderr: "" }]) {
    const view = shellFixture();
    state.execute = async () => response;
    try {
      render(view);
      await Promise.all(state.tasks.splice(0).map(task => task()));
      assert.ok(find(render(view), "space-agent-t1"));
    } finally { state.execute = null; }
  }
});

test("compact cards retain status descriptions without repeating harness and idle labels", () => {
  const view = fixture();
  state.data.allAgents[0].status = "idle";
  const tree = render(view);
  const card = find(tree, "space-agent-t1");
  assert.ok(!text(card).includes("Idle"));
  assert.ok(!text(card).includes("OpenCode"));
  assert.deepEqual(find(card, "space-agent-status-t1").attributes.tooltip, ["Idle"]);
  assert.ok(card.attributes.accessibility_label[0].includes("Idle"));
});

test("blocked agents retain a readable urgent status cue", () => {
  const view = fixture();
  state.data.allAgents[0].status = "blocked";
  assert.ok(text(render(view)).includes("Needs you"));
});

test("title fallback produces a separate unverified badge and preserves the full title tooltip", async () => {
  const view = fixture();
  state.data.allAgents[0].title = "PROJ-101 #6104 Features";
  await view.prs.refresh(agentCards(state.data)[0], async command => command === "hc"
    ? { code: 0, stdout: "No PR URL", stderr: "" }
    : { code: 1, stdout: "", stderr: "not a git repository" });
  const tree = render(view);
  const badge = find(tree, "space-agent-pr-t1");
  assert.ok(badge);
  assert.ok(text(badge).includes("#6104"));
  assert.match(badge.attributes.tooltip[0], /not verified on GitHub/);
  assert.ok(find(tree, "space-agent-t1").attributes.accessibility_label[0].includes("unverified"));
  const heading = find(tree, "space-agent-title-t1");
  assert.deepEqual(text(heading), ["PROJ-101 Features"]);
  assert.deepEqual(heading.attributes.tooltip, ["PROJ-101 #6104 Features"]);
});

test("automatically discovered PRs display without a manually renamed title", async () => {
  const view = fixture();
  await view.prs.refresh(agentCards(state.data)[0], async (command, args) => {
    if (command === "hc") return { code: 0, stdout: "https://github.com/team/repo/pull/6028", stderr: "" };
    if (args[1] === "view") return { code: 0, stdout: '{"number":6028,"state":"OPEN"}', stderr: "" };
    return { code: 1, stdout: "", stderr: "not a git repository" };
  });
  const tree = render(view);
  const badge = find(tree, "space-agent-pr-t1");
  assert.ok(badge);
  assert.ok(text(badge).includes("#6028"));
  assert.match(badge.attributes.tooltip[0], /Verified on GitHub.*terminal output/);
  assert.deepEqual(text(find(tree, "space-agent-title-t1")), ["Fix login"]);
});

test("only the verified PR control opens the browser and it focuses its own pane", async () => {
  const view = fixture();
  await view.prs.refresh(agentCards(state.data)[0], async () => ({ code: 0, stderr: "", stdout: JSON.stringify([
    { number: 6104, state: "OPEN", url: "https://github.com/team/repo-a/pull/6104" },
  ]) }));
  const tree = render(view);
  find(tree, "space-agent-t1").attributes.on_click[0]();
  assert.deepEqual(state.openedUrls, []);
  const badge = find(tree, "space-agent-pr-t1");
  assert.ok(badge.attributes.on_click, "verified PR needs a browser activation handler");
  badge.attributes.on_click[0]({}, context());
  assert.deepEqual(state.openedUrls, ["https://github.com/team/repo-a/pull/6104"]);
  assert.deepEqual(state.commands.at(-1), { name: "pane.focus", args: { pane: "p1" } });
  assert.ok(text(tree).includes("repo-a"));
});

test("title-only PR numbers cannot open a guessed URL", async () => {
  const view = fixture();
  state.data.allAgents[0].title = "Task #6104";
  await view.prs.refresh(agentCards(state.data)[0], async command => command === "hc"
    ? { code: 0, stdout: "No PR URL", stderr: "" }
    : { code: 1, stdout: "", stderr: "not a git repository" });
  const badge = find(render(view), "space-agent-pr-t1");
  assert.equal(badge.attributes.on_click, undefined);
  assert.deepEqual(state.openedUrls, []);
});

test("a bound canonical PR number has a non-truncating badge before verification finishes", () => {
  const view = fixture();
  const f = metadataFixture(), binding = { ...f.binding, terminal: "t1" }, key = bindingKey(binding);
  const title = "PROJ-102 #6029 " + "Long task description ".repeat(8);
  state.width = 180;
  state.data.allTerminals = [{ address: "t1", state: "live", created_ms: binding.createdMs,
    labels: { "herdr.meta-binding": JSON.stringify({ key, generation: binding.generation }) } }];
  view.sessionView = { schema: 1, owner: "herdr-session-metadata", entries: [{ binding,
    record: { ...f.record, canonicalTitle: title, activeRepo: null, contexts: {}, bindings: [{ key, generation: binding.generation }] } }] };
  const tree = render(view), badge = find(tree, "space-agent-pr-t1");
  assert.ok(badge, "known PR number needs a badge while verification is pending");
  assert.ok(text(badge).includes("#6029"));
  assert.ok(badge.attributes.flex_none);
  assert.equal(badge.attributes.truncate, undefined);
  assert.equal(badge.attributes.on_click, undefined);
  assert.ok(!text(tree).includes("PR…"));
  assert.ok(!text(find(tree, "space-agent-title-t1")).join("").includes("#6029"));
  assert.deepEqual(find(tree, "space-agent-title-t1").attributes.tooltip, [title]);
});

test("cards without a known PR never display loading or error placeholders", async () => {
  for (const lookup of ["loading", "error", "none"]) {
    const view = fixture();
    if (lookup !== "loading") await view.prs.refresh(agentCards(state.data)[0], async () => lookup === "error"
      ? { code: 1, stdout: "", stderr: "authentication required" }
      : { code: 0, stdout: "[]", stderr: "" });
    const tree = render(view);
    assert.ok(!find(tree, "space-agent-pr-t1"));
    assert.ok(!text(tree).includes("PR…"), lookup);
    assert.ok(!text(tree).includes("PR ?"), lookup);
  }
});

test("view options default to List, save the repository choice, and close after selection", () => {
  const view = fixture();
  const popover = find(render(view), "space-agent-view-options");
  assert.ok(popover, "view menu must be available beside the agent count");
  popover.attributes.on_open_change[0](true, context());
  const menu = find(render(view), "space-agent-view-options").attributes.content[0];
  assert.ok(text(menu).includes("List (default)"));
  find(menu, "space-agent-view-repository").attributes.on_click[0]({}, context());
  assert.equal(state.shared["space-agents.view"], "repository");
  assert.equal(find(render(view), "space-agent-view-options").attributes.open[0], false);
});

test("view options support keyboard selection and retain the saved mode across view instances", () => {
  const view = fixture();
  find(render(view), "space-agent-view-options").attributes.on_open_change[0](true, context());
  let menu = find(render(view), "space-agent-view-options").attributes.content[0];
  menu.attributes.on_key_down[0]({ keystroke: "down" }, context());
  menu = find(render(view), "space-agent-view-options").attributes.content[0];
  menu.attributes.on_key_down[0]({ keystroke: "enter" }, context());
  const reopened = new SpaceAgents(); reopened.init({}, context());
  find(render(reopened), "space-agent-view-options").attributes.on_open_change[0](true, context());
  const selected = find(find(render(reopened), "space-agent-view-options").attributes.content[0], "space-agent-view-repository");
  assert.ok(selected.attributes.accessibility_label[0].includes("selected"));
});

test("grouped rendering uses alphabetical repo headings, branch details and matching keyboard order", async () => {
  const view = fixture();
  state.shared["space-agents.view"] = "repository";
  state.data.allAgents.push({ ...state.data.allAgents[0], address: "t3", pane: "p3", title: "Alpha task", focused: false });
  state.data.allPanes.push({ pane: "p3", terminal: "t3", cwd: "/clone/alpha", branch: "fix/alpha" });
  await view.prs.refresh(agentCards(state.data)[0], async () => ({ code: 0, stdout: JSON.stringify([{ number: 6104, state: "OPEN", url: "https://github.com/team/zebra/pull/6104" }]), stderr: "" }));
  await view.prs.refresh(agentCards(state.data).find(c => c.address === "t3"), async () => ({ code: 0, stdout: JSON.stringify([{ number: 6029, state: "OPEN", url: "https://github.com/team/alpha/pull/6029" }]), stderr: "" }));
  const tree = render(view);
  assert.deepEqual(state.order, ["t3", "t1"]);
  assert.ok(text(find(tree, "space-agent-list-one").nodes[0]).includes("alpha"));
  assert.ok(text(find(tree, "space-agent-list-one").nodes[1]).includes("zebra"));
  assert.ok(text(find(tree, "space-agent-t3")).includes("fix/alpha"));
  const tooltips = node => typeof node === "object" && node ? [node.attributes?.tooltip?.[0], ...node.nodes.flatMap(tooltips)].filter(Boolean) : [];
  assert.ok(tooltips(find(tree, "space-agent-t3")).some(hint => hint.includes("/clone/alpha")), "grouped cards retain their physical checkout path in a tooltip");
  assert.ok(find(tree, "space-agent-pr-t1"));
  const list = find(tree, "space-agent-list-one");
  list.attributes.on_key_down[0]({ keystroke: "up" }, context());
  list.attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands.at(-1), { name: "pane.focus", args: { pane: "p3" } });
  state.data.selectedSpace = "two";
  assert.ok(!text(render(view)).includes("Alpha task"));
});

test("unbound agents in separate checkouts group together even without any PR", async () => {
  const view = fixture();
  state.shared["space-agents.view"] = "repository";
  state.data.allAgents.push({ ...state.data.allAgents[0], address: "t3", pane: "p3", title: "Another checkout", focused: false });
  state.data.allPanes.push({ pane: "p3", terminal: "t3", cwd: "/worktrees/other-checkout", branch: "main" });
  assert.ok(view.workingDirs, "grouping needs repository discovery independent of PR discovery");
  for (const card of agentCards(state.data)) await view.workingDirs.refresh(card, async (command, args, options) => ({ code: 0, stderr: "",
    stdout: command === "gh" ? JSON.stringify({ url: "https://github.com/team/repo-a", parent: null })
      : args.includes("--show-toplevel") ? options.cwd : args.includes("--show-prefix") ? "" : args[0] === "config" ? "https://github.com/team/repo-a.git" : "main" }));
  const tree = render(view);
  assert.ok(text(directoryGroup(tree, "repo-a")).includes("repo-a"));
  assert.equal(find(tree, "space-agent-list-one").nodes.length, 1);
  assert.ok(!find(tree, "space-agent-pr-t1"));
  assert.ok(!find(tree, "space-agent-pr-t3"));
});

test("grouped checkout indicators distinguish checkout type from main or feature branch names", () => {
  for (const [checkoutType, branch] of [["checkout", "main"], ["checkout", "proj-101-features"], ["worktree", "main"], ["worktree", "proj-101-features"], [null, "main"], ["guess", "main"]]) {
    const view = fixture(), f = metadataFixture(), binding = { ...f.binding, terminal: "t1" }, key = bindingKey(binding);
    state.shared["space-agents.view"] = "repository";
    const cwd = checkoutType === "worktree" ? "/worktrees/task" : "/repos/repo-a";
    const context = { ...f.context, cwd, gitRoot: cwd, checkoutType, branch,
      ...(branch === "main" ? { activePrUrl: null, prs: {}, prStatus: "ready" } : {}) };
    state.data.allTerminals = [{ address: "t1", state: "live", created_ms: binding.createdMs,
      labels: { "herdr.meta-binding": JSON.stringify({ key, generation: binding.generation }) } }];
    view.sessionView = { schema: 1, owner: "herdr-session-metadata", entries: [{ binding,
      record: { ...f.record, canonicalTitle: "Session", contexts: { [f.record.activeRepo]: context }, bindings: [{ key, generation: binding.generation }] } }] };
    const tree = render(view), card = find(tree, "space-agent-t1"), indicator = find(tree, "space-agent-checkout-t1");
    assert.equal(card.nodes.length, 2, "the indicator must not add a third card row");
    assert.ok(text(card).includes(branch));
    if (["checkout", "worktree"].includes(checkoutType)) {
      assert.ok(indicator, `${checkoutType} on ${branch}`);
      assert.deepEqual(text(indicator), [checkoutType === "worktree" ? "W" : "C"]);
      assert.ok(indicator.attributes.tooltip[0].includes(checkoutType === "worktree" ? "Worktree" : "Checkout"));
      assert.ok(indicator.attributes.tooltip[0].includes(branch));
      assert.ok(indicator.attributes.tooltip[0].includes(cwd));
      assert.deepEqual(indicator.attributes.accessibility_label, [checkoutType === "worktree" ? "Worktree" : "Checkout"]);
      assert.ok(indicator.attributes.flex_none);
    } else assert.equal(indicator, undefined);
    if (branch !== "main") assert.ok(text(find(card, "space-agent-pr-t1")).includes("#6104"));
    state.shared["space-agents.view"] = "list";
    assert.equal(find(render(view), "space-agent-checkout-t1"), undefined, "flat view keeps its current repository line");
  }
});

function groupedFixture() {
  const view = fixture();
  state.shared["space-agents.view"] = "repository";
  state.data.allAgents.push({ ...state.data.allAgents[0], address: "t3", pane: "p3", title: "Alpha task", focused: false },
    { ...state.data.allAgents[0], address: "t4", pane: "p4", title: "Another login task", focused: false });
  state.data.allPanes.push({ pane: "p3", terminal: "t3", cwd: "/repos/alpha", branch: "main" },
    { pane: "p4", terminal: "t4", cwd: "/repos/login", branch: "another-login" });
  return view;
}

test("directory headings collapse only their own cards and keep their name and total count", () => {
  const view = groupedFixture();
  let tree = render(view);
  const toggle = directoryToggle(tree, "login");
  assert.ok(toggle, "each directory heading needs a collapse control");
  assert.deepEqual(toggle.attributes.accessibility_label, ["Collapse login"]);
  assert.ok(find(tree, "space-agent-t1"));
  assert.ok(find(tree, "space-agent-t4"));
  toggle.attributes.on_click[0]({}, context());
  tree = render(view);
  assert.equal(find(tree, "space-agent-t1"), undefined);
  assert.equal(find(tree, "space-agent-t4"), undefined);
  assert.ok(find(tree, "space-agent-t3"));
  assert.deepEqual(text(directoryToggle(tree, "login")), ["login", "2"]);
  assert.deepEqual(directoryToggle(tree, "login").attributes.accessibility_label, ["Expand login"]);
  assert.deepEqual(state.commands, [], "collapsing must not focus or close an agent");
  directoryToggle(tree, "login").attributes.on_click[0]({}, context());
  tree = render(view);
  assert.ok(find(tree, "space-agent-t1"));
  assert.ok(find(tree, "space-agent-t4"));
});

test("collapsed directory state survives new view instances and alphabetical group insertion", () => {
  const view = groupedFixture();
  const toggle = directoryToggle(render(view), "login");
  assert.ok(toggle, "each directory heading needs a collapse control");
  toggle.attributes.on_click[0]({}, context());
  state.data.allAgents.push({ ...state.data.allAgents[0], address: "t5", pane: "p5", title: "Aardvark task", focused: false });
  state.data.allPanes.push({ pane: "p5", terminal: "t5", cwd: "/repos/aardvark", branch: "main" });
  const reopened = new SpaceAgents(); reopened.init({}, context());
  const tree = render(reopened);
  assert.ok(find(tree, "space-agent-t5"));
  assert.ok(find(tree, "space-agent-t3"));
  assert.equal(find(tree, "space-agent-t1"), undefined);
  assert.equal(find(tree, "space-agent-t4"), undefined);
  assert.deepEqual(directoryToggle(tree, "login").attributes.accessibility_label, ["Expand login"]);
});

test("directory controls retain their native focus identity across group insertion and removal", () => {
  const view = groupedFixture();
  let tree = render(view);
  const groupId = directoryGroup(tree, "login").attributes.id[0];
  const toggleId = directoryToggle(tree, "login").attributes.id[0];
  state.data.allAgents.push({ ...state.data.allAgents[0], address: "t5", pane: "p5", title: "Aardvark task", focused: false });
  state.data.allPanes.push({ pane: "p5", terminal: "t5", cwd: "/repos/aardvark", branch: "main" });
  tree = render(view);
  assert.equal(directoryGroup(tree, "login").attributes.id[0], groupId);
  assert.equal(directoryToggle(tree, "login").attributes.id[0], toggleId);
  find(tree, toggleId).attributes.on_click[0]({}, context());
  tree = render(view);
  assert.equal(find(tree, "space-agent-t1"), undefined);
  assert.ok(find(tree, "space-agent-t5"));
  assert.ok(find(tree, "space-agent-t3"));
  state.data.allAgents = state.data.allAgents.filter(agent => agent.address !== "t5");
  state.data.allPanes = state.data.allPanes.filter(pane => pane.pane !== "p5");
  tree = render(view);
  assert.equal(directoryGroup(tree, "login").attributes.id[0], groupId);
  assert.equal(directoryToggle(tree, "login").attributes.id[0], toggleId);
  assert.equal(find(tree, "space-agent-t1"), undefined);
  state.data.allPanes.push({ pane: "p2", terminal: "t2", cwd: "/repos/login", branch: "main" });
  state.data.selectedSpace = "two";
  tree = render(view);
  assert.notEqual(directoryGroup(tree, "login").attributes.id[0], groupId);
  assert.notEqual(directoryToggle(tree, "login").attributes.id[0], toggleId);
});

test("a full Enter or Space press toggles the directory once without activating an agent", () => {
  const view = groupedFixture();
  const toggle = directoryToggle(render(view), "login");
  assert.ok(toggle, "each directory heading needs a collapse control");
  assert.ok(toggle.attributes.on_key_down, "directory toggles need keyboard activation");
  let stopped = 0;
  const cx = { ...context(), stop_propagation() { stopped++; } };
  toggle.attributes.on_key_down[0]({ keystroke: "enter" }, cx);
  assert.ok(find(render(view), "space-agent-t1"), "key-down must leave activation to the native Button click on release");
  // GPUI synthesizes the focused Button's click on Enter/Space key-up.
  toggle.attributes.on_key_up?.[0]({ keystroke: "enter" }, cx);
  toggle.attributes.on_click[0]({}, cx);
  let tree = render(view);
  assert.equal(find(tree, "space-agent-t1"), undefined);
  const expand = directoryToggle(tree, "login");
  expand.attributes.on_key_down[0]({ keystroke: "space" }, cx);
  assert.equal(find(render(view), "space-agent-t1"), undefined);
  expand.attributes.on_key_up?.[0]({ keystroke: "space" }, cx);
  expand.attributes.on_click[0]({}, cx);
  tree = render(view);
  assert.ok(find(tree, "space-agent-t1"));
  assert.equal(stopped, 4);
  assert.deepEqual(state.commands, []);
});

test("the same directory has independent collapse state in each Space", () => {
  const view = groupedFixture();
  state.data.allPanes.push({ pane: "p2", terminal: "t2", cwd: "/repos/login", branch: "main" });
  const toggle = directoryToggle(render(view), "login");
  assert.ok(toggle, "each directory heading needs a collapse control");
  toggle.attributes.on_click[0]({}, context());
  state.data.selectedSpace = "two";
  let tree = render(view);
  assert.ok(find(tree, "space-agent-t2"));
  directoryToggle(tree, "login").attributes.on_click[0]({}, context());
  assert.equal(find(render(view), "space-agent-t2"), undefined);
  state.data.selectedSpace = "one";
  tree = render(view);
  assert.equal(find(tree, "space-agent-t1"), undefined);
  directoryToggle(tree, "login").attributes.on_click[0]({}, context());
  assert.ok(find(render(view), "space-agent-t1"));
  state.data.selectedSpace = "two";
  assert.equal(find(render(view), "space-agent-t2"), undefined);
});

test("agent keyboard navigation skips collapsed cards and does nothing when all groups are collapsed", () => {
  const view = groupedFixture();
  const toggle = directoryToggle(render(view), "login");
  assert.ok(toggle, "each directory heading needs a collapse control");
  toggle.attributes.on_click[0]({}, context());
  let tree = render(view), list = find(tree, "space-agent-list-one");
  assert.deepEqual(state.order, ["t3"]);
  list.attributes.on_key_down[0]({ keystroke: "down" }, context());
  list.attributes.on_key_down[0]({ keystroke: "enter" }, context());
  assert.deepEqual(state.commands, [{ name: "pane.focus", args: { pane: "p3" } }]);
  directoryToggle(tree, "alpha").attributes.on_click[0]({}, context());
  tree = render(view); list = find(tree, "space-agent-list-one");
  assert.deepEqual(state.order, []);
  list.attributes.on_key_down[0]({ keystroke: "down" }, context());
  list.attributes.on_key_down[0]({ keystroke: "space" }, context());
  assert.equal(state.commands.length, 1);
  assert.ok(!text(tree).includes("No agents in this space"), "collapsed agents still exist");
});

test("collapsed directories do not hide agents in List view or the compact sidebar", () => {
  const view = groupedFixture();
  const toggle = directoryToggle(render(view), "login");
  assert.ok(toggle, "each directory heading needs a collapse control");
  toggle.attributes.on_click[0]({}, context());
  state.shared["space-agents.view"] = "list";
  let tree = render(view);
  assert.ok(find(tree, "space-agent-t1"));
  assert.ok(find(tree, "space-agent-t4"));
  assert.equal(directoryToggle(tree, "login"), undefined);
  state.shared["space-agents.view"] = "repository";
  state.width = 76;
  tree = render(view);
  assert.ok(find(tree, "space-agent-t1"));
  assert.ok(find(tree, "space-agent-t4"));
  assert.equal(directoryToggle(tree, "login"), undefined);
  assert.deepEqual(state.order, ["t3", "t1", "t4"]);
  state.width = 320;
  assert.equal(find(render(view), "space-agent-t1"), undefined);
});
