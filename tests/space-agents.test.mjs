import assert from "node:assert/strict";
import test from "node:test";
import { agentCards, PullRequests, sessionPullRequest, cardPullRequest, repositoryLabel } from "../mods/space-agents/model.js";

const program = { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: false, agent: true };
const input = {
  allSpaces: [
    { id: "work", active: true, machine: null, folder: "/repos/fallback", tabs: [{ id: "tab-1", name: "Fix login", named: true }] },
    { id: "remote/work", active: false, machine: "remote", folder: "/srv/fallback", tabs: [{ id: "remote/tab-1", name: "Deploy API", named: true }] },
  ],
  allAgents: [
    { address: "t1", pane: "pane-1", space: "work", tab: "tab-1", tab_name: "Fix login", title: "OC | terminal title", status: "working", program, focused: true },
    { address: "remote/t1", pane: "remote/pane-1", space: "remote/work", tab: "remote/tab-1", tab_name: "Deploy API", title: "Deploy API", status: "idle", program, focused: false },
  ],
  allPanes: [
    { pane: "pane-1", terminal: "t1", cwd: "/repos/login-service/", branch: "fix/login" },
    { pane: "remote/pane-1", terminal: "remote/t1", cwd: "/srv/api", branch: "deploy/api" },
  ],
  allTerminals: [],
  selectedSpace: "work",
};

test("cards contain only agents in the selected space", () => {
  assert.deepEqual(agentCards(input).map(c => c.address), ["t1"]);
});

test("changing the selected space replaces cards without retaining the previous space", () => {
  const cards = agentCards({ ...input, selectedSpace: "remote/work" });
  assert.deepEqual(cards.map(c => c.address), ["remote/t1"]);
  assert.equal(cards[0].machine, "remote");
  assert.equal(cards[0].title, "Deploy API");
});

test("a stale selection never leaks agents from another space", () => {
  assert.deepEqual(agentCards({ ...input, selectedSpace: "deleted" }), []);
});

test("the active space is used when window focus is absent", () => {
  assert.deepEqual(agentCards({ ...input, selectedSpace: null }).map(c => c.address), ["t1"]);
});

test("card details ignore stale named tabs and use the reported session title", () => {
  const card = agentCards(input)[0];
  assert.equal(card.title, "terminal title");
  assert.equal(card.program.name, "OpenCode");
  assert.equal(card.directory, "login-service");
  assert.equal(card.cwd, "/repos/login-service/");
  assert.equal(card.branch, "fix/login");
  assert.equal(card.status, "working");
});

test("automatic tab numbers use the session title rather than the number", () => {
  const cards = agentCards({ ...input, allSpaces: [{ ...input.allSpaces[0], tabs: [{ id: "tab-1", name: "1", named: false }] }] });
  assert.equal(cards[0].title, "terminal title");
});

test("a generic terminal title falls back to the harness name", () => {
  const cards = agentCards({ ...input,
    allSpaces: [{ ...input.allSpaces[0], tabs: [{ id: "tab-1", name: "1", named: false }] }],
    allAgents: [{ ...input.allAgents[0], title: "OpenCode" }],
  });
  assert.equal(cards[0].title, "OpenCode");
});

test("missing pane folders fall back to the matching core terminal, not another pane", () => {
  const cards = agentCards({ ...input,
    allPanes: [{ pane: "pane-1", cwd: null }],
    allTerminals: [{ address: "t1", cwd: "C:\\work\\checkout\\" }],
  });
  assert.equal(cards[0].directory, "checkout");
});

test("space folder is the last fallback and filesystem roots are not blank", () => {
  assert.equal(agentCards({ ...input, allPanes: [] })[0].directory, "fallback");
  assert.equal(agentCards({ ...input, allPanes: [{ pane: "pane-1", cwd: "/" }] })[0].directory, "/");
});

const claude = { ...program, key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: true };
function withUnreportedClaude() {
  return {
    ...input,
    knownAgentKeys: ["claude"],
    allSpaces: [{ ...input.allSpaces[0], tabs: [...input.allSpaces[0].tabs, { id: "tab-3", name: "3", named: false }] }, input.allSpaces[1]],
    allPanes: [...input.allPanes, {
      pane: "pane-3", terminal: "t1b", tab: "tab-3", title: "claude", cwd: "/repos/new-checkout", branch: null,
      status: null, app: null, program: { ...claude, agent: false }, focused: false, zoomed: false, movable: false,
    }],
    allTerminals: [{ address: "t1b", state: "live", argv: ["/bin/zsh", "-l"], reported: false, status: null,
      cwd: "/repos/new-checkout", foreground: { argv: ["claude"], name: "2.1.308", cwd: "/repos/new-checkout", pid: 21360 } }],
  };
}

test("recognized Claude panes appear before the first status report", () => {
  const cards = agentCards(withUnreportedClaude());
  assert.deepEqual(cards.map(c => c.address), ["t1", "t1b"]);
  assert.equal(cards[1].title, "Claude Code");
  assert.equal(cards[1].program.icon, "icons/claude.svg");
  assert.equal(cards[1].directory, "new-checkout");
  assert.equal(cards[1].pane, "pane-3");
  assert.equal(cards[1].status, null);
});

test("recognized panes cannot leak into another selected space", () => {
  assert.deepEqual(agentCards({ ...withUnreportedClaude(), selectedSpace: "remote/work" }).map(c => c.address), ["remote/t1"]);
});

test("the first status report updates the existing recognized card without duplicating it", () => {
  const data = withUnreportedClaude();
  assert.equal(agentCards(data).filter(c => c.address === "t1b").length, 1);
  data.allAgents = [...data.allAgents, { address: "t1b", pane: "pane-3", space: "work", tab: "tab-3", title: "Review API", program: claude, status: "working", focused: false }];
  const cards = agentCards(data).filter(c => c.address === "t1b");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "working");
});

test("exiting an unreported agent removes its card when the pane becomes a shell", () => {
  const data = withUnreportedClaude();
  assert.ok(agentCards(data).some(c => c.address === "t1b"));
  data.allPanes = data.allPanes.map(p => p.terminal === "t1b" ? { ...p, program: { ...program, key: "shell", name: "zsh", agent: false, shell: true } } : p);
  assert.deepEqual(agentCards(data).map(c => c.address), ["t1"]);
});

const checkout = { cwd: "/repos/login", branch: "fix/login", machine: null };
const result = (number, state = "OPEN") => ({ code: 0, stdout: JSON.stringify([{ number, state }]), stderr: "" });

test("PR lookup queries the card's checkout and branch without a shell", async () => {
  const prs = new PullRequests();
  const value = await prs.refresh(checkout, async (command, args, options) => {
    assert.equal(command, "gh");
    assert.deepEqual(args, ["pr", "list", "--head", "fix/login", "--state", "open", "--limit", "1", "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"]);
    assert.deepEqual(options, { cwd: "/repos/login", on: null });
    return result(6029);
  }, 1000);
  assert.deepEqual(value, { state: "ready", number: 6029 });
  assert.deepEqual(prs.peek(checkout), { state: "ready", number: 6029 });
});

test("closed PRs and branches without PRs have no badge", async () => {
  for (const response of [result(6029, "CLOSED"), result(6029, "MERGED"),
    { code: 1, stdout: "", stderr: "no pull requests found for branch fix/login" },
  ]) {
    assert.deepEqual(await new PullRequests().refresh(checkout, async () => response, 1000), { state: "none" });
  }
});

test("authentication, invalid output, and missing gh failures remain visible and retryable", async () => {
  for (const execute of [
    async () => ({ code: 1, stdout: "", stderr: "gh auth login required" }),
    async () => ({ code: 0, stdout: "invalid json", stderr: "" }),
    async () => { throw new Error("gh is not installed"); },
  ]) {
    const prs = new PullRequests();
    const value = await prs.refresh(checkout, execute, 1000);
    assert.equal(value.state, "error");
    assert.ok(value.message);
    assert.equal(prs.needs(checkout, 61001), true);
  }
});

test("PR results including absence are cached for one minute", async () => {
  for (const response of [result(6104), { code: 1, stdout: "", stderr: "no pull requests found" }]) {
    const prs = new PullRequests();
    let calls = 0;
    const execute = async () => { calls++; return response; };
    await prs.refresh(checkout, execute, 1000);
    await prs.refresh(checkout, execute, 60999);
    assert.equal(calls, 1);
    assert.equal(prs.needs(checkout, 60999), false);
    await prs.refresh(checkout, execute, 61000);
    assert.equal(calls, 2);
  }
});

test("a new branch, directory, or machine cannot inherit another checkout's PR", async () => {
  const prs = new PullRequests();
  await prs.refresh(checkout, async () => result(6029), 1000);
  for (const card of [{ ...checkout, branch: "other" }, { ...checkout, cwd: "/repos/other" }, { ...checkout, machine: "devbox" }]) {
    assert.equal(prs.peek(card).state, "loading");
    assert.equal(prs.needs(card, 1001), true);
  }
});

test("concurrent cards for one checkout share the in-flight request", async () => {
  const prs = new PullRequests();
  let finish;
  let calls = 0;
  const execute = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = prs.refresh(checkout, execute, 1000);
  const second = prs.refresh(checkout, execute, 1000);
  assert.equal(prs.needs(checkout, 1001), false);
  finish(result(6029));
  assert.deepEqual(await first, { state: "ready", number: 6029 });
  assert.deepEqual(await second, { state: "ready", number: 6029 });
  assert.equal(calls, 1);
});

test("a late response for the previous space cannot replace the new space's PR", async () => {
  const prs = new PullRequests();
  let finish;
  const old = prs.refresh(checkout, () => new Promise(resolve => { finish = resolve; }), 1000);
  const current = { ...checkout, machine: "devbox" };
  await prs.refresh(current, async (_command, _args, options) => {
    assert.equal(options.on, "devbox");
    return result(6104);
  }, 1000);
  finish(result(6029));
  await old;
  assert.deepEqual(prs.peek(current), { state: "ready", number: 6104 });
});

test("a missing directory never starts a PR lookup", async () => {
  const prs = new PullRequests();
  const card = { cwd: null, branch: null, machine: null };
  assert.equal(prs.needs(card, 1000), false);
  assert.deepEqual(await prs.refresh(card, () => assert.fail("lookup without a directory"), 1000), { state: "unavailable" });
});

test("a synchronous process-launch failure can be retried after the cache expires", async () => {
  const prs = new PullRequests();
  const failure = await prs.refresh(checkout, () => { throw new Error("Could not start gh"); }, 1000);
  assert.equal(failure.state, "error");
  assert.equal(prs.needs(checkout, 61000), true);
  assert.deepEqual(await prs.refresh(checkout, async () => result(6104), 61000), { state: "ready", number: 6104 });
});

test("numeric branch names are head filters, never PR-number selectors", async () => {
  const value = await new PullRequests().refresh({ ...checkout, branch: "123" }, async (_command, args) => {
    assert.deepEqual(args, ["pr", "list", "--head", "123", "--state", "open", "--limit", "1", "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"]);
    return { code: 0, stdout: '[{"number":6029,"state":"OPEN"}]', stderr: "" };
  });
  assert.deepEqual(value, { state: "ready", number: 6029 });
});

test("an empty head-filter result has no PR badge", async () => {
  assert.deepEqual(await new PullRequests().refresh(checkout, async () => ({ code: 0, stdout: "[]", stderr: "" })), { state: "none" });
});

test("without pane branch metadata gh resolves the checkout's current branch", async () => {
  const value = await new PullRequests().refresh({ ...checkout, branch: null }, async (_command, args) => {
    assert.deepEqual(args, ["pr", "view", "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"]);
    return { code: 0, stdout: '{"number":6029,"state":"OPEN"}', stderr: "" };
  });
  assert.deepEqual(value, { state: "ready", number: 6029 });
});

test("a non-repository is unavailable, not a confirmed absence of a PR", async () => {
  const value = await new PullRequests().refresh(checkout, async () => ({ code: 1, stdout: "", stderr: "not a git repository" }));
  assert.deepEqual(value, { state: "unavailable" });
});

test("session discovery takes the most recent complete GitHub PR link", () => {
  const output = 'Old https://github.com/team/repo/pull/12#discussion_r123\n┃ {"url":"https://github.com/team/incident-docs/pull/6104"}\n';
  assert.equal(sessionPullRequest(output), "https://github.com/team/incident-docs/pull/6104");
  assert.equal(sessionPullRequest("draft PR #6104; https://github.com/team/repo/issues/15"), null);
  assert.equal(sessionPullRequest("https://github.com.example.org/team/repo/pull/12"), null);
});

test("a session's PR link is verified automatically when its terminal folder is not a checkout", async () => {
  const card = { ...checkout, address: "t12" };
  const calls = [];
  const value = await new PullRequests().refresh(card, async (command, args, options) => {
    calls.push([command, args, options]);
    if (command === "hc") return { code: 0, stdout: 'Pushed: https://github.com/team/incident-docs/pull/6104', stderr: "" };
    if (args[1] === "view") return { code: 0, stdout: '{"number":6104,"state":"OPEN"}', stderr: "" };
    return { code: 1, stdout: "", stderr: "not a git repository" };
  });
  assert.deepEqual(calls[1], ["hc", ["read", "t12", "--lines", "250"], { on: null }]);
  assert.deepEqual(calls[2], ["gh", ["pr", "view", "https://github.com/team/incident-docs/pull/6104", "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"], { on: null }]);
  assert.deepEqual(value, { state: "ready", number: 6104, source: "terminal", url: "https://github.com/team/incident-docs/pull/6104", repo: { host: "github.com", owner: "team", name: "incident-docs" } });
});

test("agents sharing a generic folder cannot inherit each other's discovered PR", async () => {
  const prs = new PullRequests();
  const execute = async (command, args) => {
    if (command === "hc") return { code: 0, stdout: `https://github.com/team/repo/pull/${args[1] === "t2" ? 6029 : 6104}`, stderr: "" };
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ number: args[2].endsWith("6029") ? 6029 : 6104, state: "OPEN" }), stderr: "" };
    return { code: 1, stdout: "", stderr: "not a git repository" };
  };
  await prs.refresh({ ...checkout, address: "t2" }, execute, 1000);
  await prs.refresh({ ...checkout, address: "t12" }, execute, 1000);
  assert.equal(prs.peek({ ...checkout, address: "t2" }).number, 6029);
  assert.equal(prs.peek({ ...checkout, address: "t12" }).number, 6104);
});

test("a confirmed no-PR checkout result never revives an old PR from terminal output", async () => {
  const value = await new PullRequests().refresh({ ...checkout, address: "t12" }, async (command) => {
    assert.equal(command, "gh");
    return { code: 0, stdout: "[]", stderr: "" };
  });
  assert.deepEqual(value, { state: "none" });
});

test("a closed discovered PR does not fall back to an older link", async () => {
  const value = await new PullRequests().refresh({ ...checkout, address: "t12" }, async (command, args) => {
    if (command === "hc") return { code: 0, stdout: "https://github.com/team/repo/pull/1\nhttps://github.com/team/repo/pull/2", stderr: "" };
    if (args[1] === "view") {
      assert.equal(args[2], "https://github.com/team/repo/pull/2");
      return { code: 0, stdout: '{"number":2,"state":"CLOSED"}', stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "not a git repository" };
  });
  assert.deepEqual(value, { state: "none" });
});

test("remote terminal history is read by qualified address and its PR is queried on that machine", async () => {
  const value = await new PullRequests().refresh({ cwd: null, branch: null, address: "devbox/t12", machine: "devbox" }, async (command, args, options) => {
    if (command === "hc") {
      assert.deepEqual(args, ["read", "devbox/t12", "--lines", "250"]);
      assert.deepEqual(options, { on: null });
      return { code: 0, stdout: "https://github.com/team/repo/pull/6104", stderr: "" };
    }
    assert.deepEqual(options, { on: "devbox" });
    return { code: 0, stdout: '{"number":6104,"state":"OPEN"}', stderr: "" };
  });
  assert.equal(value.number, 6104);
  assert.equal(value.source, "terminal");
});

test("a terminal without a PR link stays unavailable rather than inventing a number", async () => {
  const value = await new PullRequests().refresh({ ...checkout, address: "t12" }, async (command) => command === "hc"
    ? { code: 0, stdout: "Working on PROJ-101", stderr: "" }
    : { code: 1, stdout: "", stderr: "not a git repository" });
  assert.deepEqual(value, { state: "unavailable" });
});

test("known title PR numbers remain visible while lookup loads or is unavailable", () => {
  const card = { title: "PROJ-101 #6104 Features" };
  assert.deepEqual(cardPullRequest(card, { state: "unavailable" }), { number: 6104, source: "title" });
  assert.deepEqual(cardPullRequest(card, { state: "error", message: "login required" }), { number: 6104, source: "title" });
  assert.deepEqual(cardPullRequest(card, { state: "loading" }), { number: 6104, source: "title" });
  assert.equal(cardPullRequest(card, { state: "none" }), null);
});

test("bound session PR numbers remain visible before a verified association is available", () => {
  const card = { title: "PROJ-102 #6029 normalization", sessionBound: true, sessionPr: null };
  for (const state of ["loading", "error", "unavailable", "none"]) {
    assert.deepEqual(cardPullRequest(card, { state }), { number: 6029, source: "title" });
  }
  const sessionPr = { number: 6104, source: "session", url: "https://github.com/team/repo/pull/6104" };
  assert.deepEqual(cardPullRequest({ ...card, sessionPr }, { state: "loading" }), sessionPr);
});

test("verified GitHub results take priority over manually named title references", () => {
  assert.deepEqual(cardPullRequest({ title: "Old #6029 title" }, { state: "ready", number: 6104 }), { number: 6104, source: "github" });
  assert.deepEqual(cardPullRequest({ title: "No manual number" }, { state: "ready", number: 6028, source: "terminal", url: "https://github.com/team/repo/pull/6028" }),
    { number: 6028, source: "terminal", url: "https://github.com/team/repo/pull/6028", repo: { host: "github.com", owner: "team", name: "repo" } });
});

test("title fallback rejects ambiguous or malformed references and updates after a rename", () => {
  for (const title of ["PROJ-101", "#0", "#6104abc", "C#6104", "Compare #6104 and #6029", "#99999999999999999999"]) {
    assert.equal(cardPullRequest({ title }, { state: "unavailable" }), null, title);
  }
  assert.deepEqual(cardPullRequest({ title: "Renamed #6029 task" }, { state: "unavailable" }), { number: 6029, source: "title" });
});

test("verified URL metadata distinguishes repos below one launch folder", async () => {
  const card = { ...checkout, directory: "github" };
  for (const name of ["repo-a", "repo-b"]) {
    const prs = new PullRequests();
    const value = await prs.refresh(card, async () => ({ code: 0, stderr: "", stdout: JSON.stringify([
      { number: 6104, state: "OPEN", url: `https://github.com/team/${name}/pull/6104` },
    ]) }));
    const badge = cardPullRequest(card, value);
    assert.equal(badge.url, `https://github.com/team/${name}/pull/6104`);
    assert.deepEqual(badge.repo, { host: "github.com", owner: "team", name });
    assert.equal(repositoryLabel(card, badge), name);
  }
});

test("unsafe or mismatched PR URLs never become clickable metadata", async () => {
  for (const url of ["javascript:alert(1)", "https://github.com.evil/team/repo/pull/6104", "https://github.com/team/repo/pull/1"]) {
    const value = await new PullRequests().refresh(checkout, async () => ({ code: 0, stderr: "", stdout: JSON.stringify([{ number: 6104, state: "OPEN", url }]) }));
    assert.equal(cardPullRequest(checkout, value)?.url, undefined);
  }
});

test("SSH panes cannot authorize local filesystem discovery from a remote directory report", () => {
  const cards = agentCards({ ...input, allTerminals: [{ address: "t1", cwd: "/local/launch", foreground: { name: "ssh", argv: ["ssh", "devbox"] } }] });
  assert.equal(cards[0].filesystemTrusted, false);
});

test("unbound SSH PR compatibility checks use canonical URLs without opening the remote path locally", async () => {
  const value = await new PullRequests().refresh({ address: "t1", cwd: "/remote/repo", filesystemTrusted: false }, async (command, args, options) => {
    assert.equal(options.cwd, undefined);
    if (command === "hc") return { code: 0, stdout: "https://github.com/team/repo/pull/6104", stderr: "" };
    assert.equal(args[2], "https://github.com/team/repo/pull/6104");
    return { code: 0, stdout: '{"number":6104,"state":"OPEN","url":"https://github.com/team/repo/pull/6104"}', stderr: "" };
  });
  assert.equal(value.number, 6104);
});

test("reused terminal addresses cannot inherit a previous process's cached PR badge", async () => {
  const prs = new PullRequests(), card = { ...checkout, address: "t1", createdMs: 100 };
  await prs.refresh(card, async () => result(6104));
  assert.equal(prs.peek({ ...card, createdMs: 101 }).state, "loading");
});
