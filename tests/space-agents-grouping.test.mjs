import assert from "node:assert/strict";
import test from "node:test";
import { agentGroups, agentViewMode, WorkingDirectories } from "../mods/space-agents/model.js";
import { projectSessionCard } from "../mods/space-agents/session-metadata.js";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";

const project = name => ({ host: "github.com", owner: "team", name });
test("List remains the default and invalid saved view values fail back to it", () => {
  assert.equal(agentViewMode(null), "list");
  assert.equal(agentViewMode("list"), "list");
  assert.equal(agentViewMode("repository"), "repository");
  assert.equal(agentViewMode("unknown"), "list");
});

test("repository groups combine worktrees and independent clones instead of their temporary folder names", () => {
  const cards = [
    { address: "one", cwd: "/repos/incident-docs", projectRepo: project("incident-docs") },
    { address: "two", cwd: "/worktrees/proj-101", projectRepo: project("incident-docs") },
    { address: "three", cwd: "/temp/separate-clone", projectRepo: project("incident-docs") },
    { address: "four", cwd: "/repos/blackfish", projectRepo: project("blackfish") },
  ];
  const before = JSON.stringify(cards), groups = agentGroups(cards);
  assert.deepEqual(groups.map(g => g.name), ["blackfish", "incident-docs"]);
  assert.deepEqual(groups[1].cards.map(c => c.address), ["one", "two", "three"]);
  assert.equal(JSON.stringify(cards), before);
});

test("group ordering is alphabetical, case-insensitive, and independent of agent arrival order", () => {
  const groups = agentGroups(["zebra", "Beta", "alpha"].map(name => ({ address: name, projectRepo: project(name) })));
  assert.deepEqual(groups.map(g => g.name), ["alpha", "Beta", "zebra"]);
});

test("equal repo basenames with different owners never merge", () => {
  const groups = agentGroups([{ projectRepo: project("same") }, { projectRepo: { ...project("same"), owner: "other" } }]);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
});

test("non-Git folders use their real basename but keep distinct paths and hosts separate", () => {
  const groups = agentGroups([
    { address: "one", cwd: "/a/scripts", executionHost: "local" },
    { address: "two", cwd: "/b/scripts", executionHost: "local" },
    { address: "three", cwd: "/a/scripts", executionHost: "devbox" },
    { address: "four", cwd: "/a/scripts/", executionHost: "local" },
  ]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(g => g.name === "scripts"));
  assert.deepEqual(groups.find(g => g.cards.some(c => c.address === "one")).cards.map(c => c.address), ["one", "four"]);
  assert.deepEqual(agentGroups([{ cwd: null }]).map(g => g.name), ["Unknown directory"]);
});

test("cards expose canonical project identity and branch separately from the physical worktree", () => {
  const { record, context } = metadataFixture();
  const actual = projectSessionCard({ directory: "temp" }, { ...record, contexts: { [record.activeRepo]: {
    ...context, repo: { ...project("repo-a"), owner: "fork-owner" }, projectRepo: project("repo-a"), cwd: "/worktrees/proj-101", gitRoot: "/worktrees/proj-101",
  } } });
  assert.deepEqual(actual.projectRepo, project("repo-a"));
  assert.equal(actual.branch, "proj-101-features");
  assert.ok(actual.metadataHint.includes("/worktrees/proj-101"));
});

test("repository identity is discovered independently of open PRs for unbound clones and worktrees", async () => {
  const directories = new WorkingDirectories(), cards = [{ address: "one", cwd: "/repos/repo-a", branch: "main" }, { address: "two", cwd: "/worktrees/task-101", branch: "task-101" }];
  const execute = async (command, args, options) => {
    if (command === "git") return { code: 0, stdout: args.includes("--show-toplevel") ? options.cwd + "\n" : args.includes("--show-prefix") ? ""
      : args[0] === "config" ? "https://github.com/team/repo-a.git\n" : options.cwd.startsWith("/repos") ? "main\n" : "task-101\n", stderr: "" };
    assert.equal(command, "gh"); assert.equal(args[0], "repo", "repository discovery must not depend on a PR lookup");
    return { code: 0, stdout: JSON.stringify({ url: "https://github.com/team/repo-a", name: "repo-a", owner: { login: "team" }, parent: null }), stderr: "" };
  };
  for (const card of cards) await directories.refresh(card, execute);
  const groups = agentGroups(cards.map(card => ({ ...card, ...directories.peek(card) })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "repo-a");
});

test("unbound remote filesystem reports are never probed on the local host", async () => {
  const directories = new WorkingDirectories(), card = { cwd: "/home/example/repo", filesystemTrusted: false };
  assert.equal(directories.needs(card), false);
  assert.equal(await directories.refresh(card, async () => assert.fail("unpaired remote path must not reach local Git")), null);
});
