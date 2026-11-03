import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkContext, repoKey } from "../integrations/session-metadata/src/work-context.mjs";
import { applyObservation } from "../integrations/session-metadata/src/engine.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";
import { projectSessionCard } from "../mods/space-agents/session-metadata.js";
import { cardPullRequest } from "../mods/space-agents/model.js";
import { metadataFixture, isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";

function boundary(options = {}) {
  const state = { owner: "person", name: "repo-a", baseOwner: "team", branch: "proj-101-features", githubDown: false, prState: "OPEN", listEmpty: false, ...options };
  const calls = [];
  const pr = () => ({ number: 6104, state: state.prState, url: `https://github.com/${state.baseOwner}/${state.name}/pull/6104`,
    title: "PROJ-101 Features", headRefName: state.branch, headRepository: { name: state.name, nameWithOwner: `${state.headOwner ?? state.owner}/${state.name}` }, headRepositoryOwner: { login: state.headOwner ?? state.owner } });
  const run = async (host, command, args, options = {}) => {
    assert.equal(host, "local"); calls.push({ command, args, cwd: options.cwd });
    if (command === "git") {
      const value = args.includes("--show-toplevel") ? options.cwd : args.includes("--show-prefix") ? ""
        : args[0] === "config" ? `https://github.com/${state.owner}/${state.name}.git` : state.branch;
      return { code: 0, stdout: value + "\n", stderr: "" };
    }
    assert.equal(command, "gh");
    if (state.githubDown) return { code: 1, stdout: "", stderr: "offline" };
    if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ name: state.name, owner: { login: state.owner },
      url: `https://github.com/${state.owner}/${state.name}`, parent: state.owner === state.baseOwner ? null : { name: state.name, owner: { login: state.baseOwner } } }), stderr: "" };
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify(pr()), stderr: "" };
    assert.equal(args[1], "list");
    const upstream = args[args.indexOf("--repo") + 1] === `${state.baseOwner}/${state.name}`;
    return { code: 0, stdout: JSON.stringify(!state.listEmpty && (upstream || state.owner === state.baseOwner) && state.prState === "OPEN" ? [pr()] : []), stderr: "" };
  };
  const f = metadataFixture();
  const oldPr = { ...f.context.prs[f.context.activePrUrl], headRepo: { host: "github.com", owner: state.owner, name: state.name }, verifiedAt: Date.now() - 120000 };
  const previous = { ...f.context, repo: { host: "github.com", owner: state.owner, name: state.name }, gitRoot: "/work/clone-a", cwd: "/work/clone-a", branch: state.branch,
    checkedAt: Date.now() - 120000, prs: { [oldPr.url]: oldPr } };
  const observation = { ...f.observation, kind: "title", payload: { cwd: "/work/clone-a" } };
  return { state, calls, run, previous, observation };
}

test("known upstream PRs are reverified independently of a renamed title and an empty fork listing", async () => {
  const f = boundary();
  const result = await resolveWorkContext(f.observation, { ...f.previous, activePrUrl: null }, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.activePrUrl, "https://github.com/team/repo-a/pull/6104");
  assert.ok(f.calls.some(c => c.command === "gh" && c.args[1] === "view" && c.args.includes("https://github.com/team/repo-a/pull/6104")));
});

test("new fork contexts discover PRs in the verified upstream rather than the empty fork", async () => {
  const f = boundary();
  const result = await resolveWorkContext(f.observation, null, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.activePrUrl, "https://github.com/team/repo-a/pull/6104");
  assert.deepEqual(result.context.projectRepo, { host: "github.com", owner: "team", name: "repo-a" });
});

test("GitHub failures preserve a verified PR only while its repository and branch still match", async () => {
  const f = boundary({ githubDown: true });
  const retained = await resolveWorkContext(f.observation, f.previous, f.run);
  assert.equal(retained.state, "resolved");
  assert.equal(retained.context.activePrUrl, "https://github.com/team/repo-a/pull/6104");
  assert.equal(retained.context.prStatus, "unavailable");
  f.state.branch = "proj-101-other-work";
  const changed = await resolveWorkContext({ ...f.observation, payload: { ...f.observation.payload, ownedWork: true } }, f.previous, f.run);
  assert.equal(changed.state, "resolved");
  assert.equal(changed.context.branch, "proj-101-other-work");
  assert.equal(changed.context.activePrUrl, null);
  const card = projectSessionCard({ title: "PROJ-101 #6104 Features", directory: "parent" },
    { canonicalTitle: "PROJ-101 #6104 Features", activeRepo: repoKey(changed.context.repo), contexts: { [repoKey(changed.context.repo)]: changed.context } });
  assert.equal(cardPullRequest(card, { state: "loading" }), null);
  const repeated = await resolveWorkContext(f.observation, changed.context, f.run);
  assert.equal(cardPullRequest(projectSessionCard({ directory: "parent" }, { canonicalTitle: "PROJ-101 #6104 Features",
    activeRepo: repoKey(repeated.context.repo), contexts: { [repoKey(repeated.context.repo)]: repeated.context } }), { state: "loading" }), null);
});

test("detached checkouts clear branch-specific PRs without needing GitHub availability", async () => {
  const f = boundary({ githubDown: true }); f.state.branch = "";
  const result = await resolveWorkContext(f.observation, f.previous, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.activePrUrl, null);
  assert.equal(result.context.detached, true);
  assert.equal(f.calls.filter(c => c.command === "gh").length, 0);
});

test("confirmed PR closure updates its history and removes the link despite a historical title number", async () => {
  const f = boundary({ prState: "MERGED" });
  const result = await resolveWorkContext(f.observation, f.previous, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.activePrUrl, null);
  assert.equal(result.context.prs["https://github.com/team/repo-a/pull/6104"].state, "MERGED");
  const card = projectSessionCard({ title: "Old", directory: "parent" }, { canonicalTitle: "PROJ-101 #6104 Features",
    activeRepo: repoKey(result.context.repo), contexts: { [repoKey(result.context.repo)]: result.context } });
  assert.equal(cardPullRequest(card, { state: "loading" }), null);
});

test("switching repositories never reuses an old PR URL with the same number", async () => {
  const f = boundary();
  f.state.name = "repo-b";
  const result = await resolveWorkContext({ ...f.observation, kind: "tool", payload: { cwd: "/work/repo-b", command: "git status" } }, f.previous, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.activePrUrl, "https://github.com/team/repo-b/pull/6104");
  assert.equal(result.context.prs["https://github.com/team/repo-a/pull/6104"], undefined);
});

test("a launch-directory prompt cannot replace the last verified working repository", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.bind(f.binding, null);
  f.record.bindings = [{ key: bindingKey(f.binding), generation: f.binding.generation }];
  f.record.workScope = { version: 1, host: "local", path: "/parent/repo-a", source: "successful-task-command", eventId: "task-work", eventAt: 500 };
  await f.store.write(f.record, null);
  await applyObservation({ ...f.observation, kind: "task", payload: { prompt: "Continue PROJ-101", cwd: "/launch/other-repo" } }, f.binding,
    { store: f.store, access: f.access, clock: Date.now, activationMode: async () => "observe", validateBinding: async () => true, hasAuthority: async () => true,
      resolveContext: async observation => {
        assert.equal(observation.payload.cwd, "/parent/repo-a");
        return { state: "resolved", context: f.context };
      } });
});

test("manual renames preserve the session-owned verified link without further automatic title writes", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const network = boundary();
  await f.store.bind(f.binding, null);
  const context = { ...network.previous, activePrUrl: "https://github.com/team/repo-a/pull/6104" };
  const record = { ...f.record, canonicalTitle: "PROJ-101 #6104 Features", lastManagedTitle: "PROJ-101 #6104 Features",
    activeRepo: repoKey(context.repo), contexts: { [repoKey(context.repo)]: context }, bindings: [{ key: bindingKey(f.binding), generation: f.binding.generation }] };
  await f.store.write(record, null);
  f.record.canonicalTitle = "My renamed session";
  const result = await applyObservation({ ...f.observation, kind: "title", payload: { cwd: context.cwd } }, f.binding,
    { store: f.store, access: f.access, run: network.run, clock: Date.now, activationMode: async () => "active", validateBinding: async () => true, hasAuthority: async () => true });
  const actual = await f.store.read(f.key);
  assert.equal(actual.canonicalTitle, "My renamed session");
  assert.equal(actual.manualOverride, true);
  assert.equal(cardPullRequest(projectSessionCard({ directory: "parent" }, actual), { state: "loading" })?.url, "https://github.com/team/repo-a/pull/6104");
  assert.notEqual(result.state, "renamed");
  assert.deepEqual(f.calls, []);
});

test("idle title refreshes cannot discard a newly delivered tool completion from the same turn", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.bind(f.binding, null);
  f.record.bindings = [{ key: bindingKey(f.binding), generation: f.binding.generation }];
  await f.store.write(f.record, null);
  const repoB = { ...f.context, repo: { host: "github.com", owner: "team", name: "repo-b" }, cwd: "/parent/repo-b", gitRoot: "/parent/repo-b", prs: {}, activePrUrl: null };
  const deps = { store: f.store, access: f.access, clock: Date.now, activationMode: async () => "observe", validateBinding: async () => true, hasAuthority: async () => true,
    resolveContext: async o => ({ state: "resolved", context: o.kind === "tool" ? repoB : f.context }) };
  await applyObservation({ ...f.observation, kind: "title", eventId: "idle-refresh", observedAt: 2000 }, f.binding, deps);
  const result = await applyObservation({ ...f.observation, kind: "tool", eventId: "completed-tool", observedAt: 1500, payload: { cwd: "/parent/repo-b", command: "git status" } }, f.binding, deps);
  assert.notEqual(result.state, "ignored");
  assert.equal((await f.store.read(f.key)).activeRepo, "github.com/team/repo-b");
});

test("checking out a contributor fork PR from an upstream clone retains the verified link", async () => {
  const f = boundary({ owner: "team", headOwner: "contributor" });
  const result = await resolveWorkContext({ ...f.observation, kind: "tool", payload: { cwd: "/work/clone-a", command: "gh pr checkout 6104" } }, null, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.activePrUrl, "https://github.com/team/repo-a/pull/6104");
});

test("closed PR history cannot reappear as a title badge after cache expiry and a GitHub outage", async () => {
  const f = boundary({ prState: "MERGED" });
  const closed = await resolveWorkContext(f.observation, f.previous, f.run);
  f.state.githubDown = true;
  const expired = { ...closed.context, prAttemptedAt: 0, checkedAt: 0 };
  const refreshed = await resolveWorkContext(f.observation, expired, (...args) => f.run(...args));
  assert.equal(refreshed.context.prStatus, "unavailable");
  const card = projectSessionCard({ directory: "parent" }, { canonicalTitle: "PROJ-101 #6104 Features",
    activeRepo: repoKey(refreshed.context.repo), contexts: { [repoKey(refreshed.context.repo)]: refreshed.context } });
  assert.equal(cardPullRequest(card, { state: "loading" }), null);
});

test("a branch switched by another session in a shared checkout never moves this session's PR", async () => {
  const f = boundary();
  f.state.branch = "proj-101-other-work";
  const result = await resolveWorkContext(f.observation, f.previous, f.run);
  assert.equal(result.state, "resolved");
  assert.equal(result.context.branch, "proj-101-features");
  assert.equal(result.context.activePrUrl, f.previous.activePrUrl);
});

test("sessions sharing a checkout do not claim a PR that another live session created", async () => {
  const mk = async (id, created) => {
    const f = await isolatedFixture(); return { f, id, created };
  };
  const f = await isolatedFixture();
  try {
    const url = f.context.activePrUrl, name = repoKey(f.context.repo);
    const creator = { ...f.key, id: "ses_creator" }, other = f.key;
    const creatorBinding = { ...f.binding, session: creator, terminal: "t-creator", generation: "generation-creator" };
    assert.equal(await f.store.bind(creatorBinding, null), true);
    assert.equal(await f.store.bind(f.binding, null), true);
    await f.store.write({ ...f.record, session: creator, canonicalTitle: "creator", contexts: { [name]: { ...f.context, lastCreatedPrUrl: url } },
      bindings: [{ key: bindingKey(creatorBinding), generation: creatorBinding.generation }] }, null);
    const deps = { store: f.store, access: f.access, run: async () => ({ code: 1, stdout: "", stderr: "" }), clock: () => 1000,
      activationMode: async () => "observe", validateBinding: async () => true, hasAuthority: async () => true,
      resolveContext: async () => ({ state: "resolved", context: { ...f.context, lastCreatedPrUrl: null } }) };
    await f.store.write({ ...f.record, bindings: [{ key: bindingKey(f.binding), generation: f.binding.generation }] }, null);
    await applyObservation(f.observation, f.binding, deps);
    assert.equal((await f.store.read(other)).contexts[name].activePrUrl, null);
    await applyObservation({ ...f.observation, eventId: "own-work", kind: "tool", observedAt: 2000,
      payload: { tool: "bash", command: "git commit -m x", cwd: "/parent/repo-a" } }, f.binding, deps);
    assert.equal((await f.store.read(other)).contexts[name].activePrUrl, url);
  } finally { await f.cleanup(); }
});
