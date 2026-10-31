import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkContext } from "../integrations/session-metadata/src/work-context.mjs";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";

function runner({ host = "local", name = "repo-a", owner = "team", count = 1, prefix = "packages/api/", headOwner = owner } = {}) {
  return async (on, command, args, options) => {
    assert.equal(on, host, "filesystem operations must stay on their execution host");
    if (command === "git") {
      assert.ok(options.cwd.startsWith("/"));
      const value = args.includes("--show-toplevel") ? "/worktrees/task-101" : args.includes("--show-prefix") ? prefix
        : args[0] === "config" ? `git@github.com:${owner}/${name}.git` : "proj-101-features";
      return { code: 0, stdout: value + "\n", stderr: "" };
    }
    assert.equal(command, "gh");
    const pr = { number: 6104, state: "OPEN", url: `https://github.com/team/${name}/pull/6104`, title: "PROJ-101 Features",
      headRefName: "proj-101-features", headRepository: { name }, headRepositoryOwner: { login: headOwner } };
    return { code: 0, stdout: JSON.stringify(Array.from({ length: count }, (_, i) => ({ ...pr, number: 6104 + i, url: pr.url.replace("6104", String(6104 + i)) }))), stderr: "" };
  };
}

test("worktrees and nested directories use repository identity, not the launch folder", async () => {
  const { observation } = metadataFixture();
  const r = await resolveWorkContext({ ...observation, kind: "tool", payload: { workdir: "/parent/repo-a/packages/api", command: "git status" } }, null, runner());
  assert.equal(r.state, "resolved");
  assert.equal(r.context.repo.name, "repo-a");
  assert.equal(r.context.subdir, "packages/api");
  assert.equal(r.context.ticket.id, "PROJ-101");
});

test("remote lookalike paths are verified remotely and fork PR ownership is respected", async () => {
  const { observation } = metadataFixture();
  const r = await resolveWorkContext({ ...observation, session: { ...observation.session, host: "devbox" }, kind: "tool", payload: { cwd: "/parent/repo-a", command: "git status" } }, null,
    runner({ host: "devbox", owner: "my-fork", headOwner: "my-fork" }));
  assert.equal(r.state, "resolved");
  assert.equal(r.context.repo.owner, "my-fork");
  assert.equal(r.context.activePrUrl, "https://github.com/team/repo-a/pull/6104");
});

test("multiple branch PRs and conflicting references are ambiguous", async () => {
  const { observation } = metadataFixture();
  const tool = { ...observation, kind: "tool", payload: { cwd: "/parent/repo-a", command: "git status" } };
  assert.equal((await resolveWorkContext(tool, null, runner({ count: 2 }))).state, "ambiguous");
  assert.equal((await resolveWorkContext({ ...tool, payload: { ...tool.payload, taskTicket: { id: "PROJ-102", ambiguous: false } } }, null, runner())).state, "ambiguous");
});

test("arbitrary output mentions and shell expansions cannot authorize a repository switch", async () => {
  const { observation } = metadataFixture();
  const fail = async () => assert.fail("must not execute or probe an inferred command");
  assert.equal((await resolveWorkContext({ ...observation, kind: "tool", payload: { command: "cd $(evil) && git status", output: "https://github.com/team/repo/pull/2" } }, null, fail)).state, "unavailable");
});
