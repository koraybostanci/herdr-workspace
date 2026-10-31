import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { resolveWorkContext } from "../integrations/session-metadata/src/work-context.mjs";
import { WorkingDirectories } from "../mods/space-agents/model.js";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";

const exec = promisify(execFile);
const origin = "https://github.com/fixture/repo-a.git";
const github = { code: 0, stderr: "", stdout: "[]" };
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

test("real Git checkouts and linked worktrees are classified independently of branch or directory names", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const primary = join(f.root, "primary"), feature = join(f.root, "linked feature"), linkedMain = join(f.root, "linked-main");
  const git = args => exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { env });
  await git(["init", "-b", "main", primary]);
  await git(["-C", primary, "config", "remote.origin.url", origin]);
  await git(["-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Checkout detection fixture"]);
  const run = async (host, command, args, options) => {
    assert.equal(host, "local");
    if (command === "gh") return github;
    try { const r = await exec(command, args, { cwd: options.cwd, env }); return { code: 0, stdout: r.stdout, stderr: r.stderr }; }
    catch (e) { return { code: 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }; }
  };
  async function check(cwd, type, branch) {
    const observation = { ...f.observation, kind: "tool", payload: { cwd, command: "git status" } };
    const bound = await resolveWorkContext(observation, null, run);
    assert.equal(bound.state, "resolved");
    assert.equal(bound.context.checkoutType, type, `${cwd}: producer classification`);
    assert.equal(bound.context.branch, branch);
    const unbound = await new WorkingDirectories().refresh({ cwd }, (command, args, options) => {
      assert.equal(options.on, null);
      return run("local", command, args, options);
    });
    assert.equal(unbound.checkoutType, type, `${cwd}: unbound classification`);
    assert.equal(unbound.branch, branch);
  }
  await check(primary, "checkout", "main");
  await git(["-C", primary, "worktree", "add", "-b", "feature/task", feature]);
  await check(feature, "worktree", "feature/task");
  await git(["-C", primary, "switch", "-c", "feature/primary"]);
  await check(primary, "checkout", "feature/primary");
  await git(["-C", primary, "worktree", "add", linkedMain, "main"]);
  await check(linkedMain, "worktree", "main");
  const misleading = join(f.root, "worktrees", "looks-like-a-worktree");
  await git(["init", "-b", "main", misleading]);
  await git(["-C", misleading, "config", "remote.origin.url", origin]);
  await check(misleading, "checkout", "main");
  const separate = join(f.root, "separate-checkout");
  await git(["init", "-b", "main", "--separate-git-dir", join(f.root, "external-git-dir"), separate]);
  await git(["-C", separate, "config", "remote.origin.url", origin]);
  await check(separate, "checkout", "main");
});

test("missing or malformed checkout metadata never becomes a guessed checkout indicator", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  for (const metadata of [null, "/repo/.git", "relative\n/repo/.git", "/repo/.git\n/repo/.git\nextra"]) {
    const execute = async (command, args) => {
      if (command === "gh") return github;
      if (args.includes("--git-dir")) return { code: metadata === null ? 1 : 0, stdout: metadata ?? "", stderr: "" };
      return { code: 0, stderr: "", stdout: args.includes("--show-toplevel") ? "/repo" : args[0] === "config" ? origin : args.includes("--show-prefix") ? "" : "main" };
    };
    const bound = await resolveWorkContext({ ...f.observation, kind: "tool", payload: { cwd: "/repo", command: "git status" } }, null, (_host, command, args) => execute(command, args));
    assert.equal(bound.context.checkoutType, null);
    assert.equal((await new WorkingDirectories().refresh({ cwd: "/repo" }, execute)).checkoutType, null);
  }
});

test("checkout metadata reads stay on their configured execution host", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const execute = async (command, args) => command === "gh" ? github : { code: 0, stderr: "", stdout: args.includes("--git-dir") ? "/source/.git/worktrees/task\n/source/.git"
    : args.includes("--show-toplevel") ? "/workspace/task" : args[0] === "config" ? origin : args.includes("--show-prefix") ? "" : "main" };
  const bound = await resolveWorkContext({ ...f.observation, session: { ...f.key, host: "devbox" }, kind: "tool", payload: { cwd: "/workspace/task", command: "git status" } }, null,
    (host, command, args) => { assert.equal(host, "devbox"); return execute(command, args); });
  assert.equal(bound.context.checkoutType, "worktree");
  const unbound = await new WorkingDirectories().refresh({ cwd: "/workspace/task", machine: "devbox" }, (command, args, options) => {
    assert.equal(options.on, "devbox"); return execute(command, args);
  });
  assert.equal(unbound.checkoutType, "worktree");
});
