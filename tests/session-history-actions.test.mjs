import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { prepareSessionResume } from "../integrations/session-metadata/src/history-view.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";
import { historySpace, historyEntry, historyRegistry } from "./helpers/session-history-fixtures.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";

async function fixture(t, harness = "opencode-v2") {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const session = { host: "local", authority: harness === "claude" ? "claude" : "local", harness, id: harness === "claude" ? "claude_saved" : "ses_saved" };
  const sourceId = JSON.stringify([session.host, session.authority, session.harness]);
  const entry = historyEntry(session.id, { session, sourceId, directory: f.root });
  const source = { ...session, id: sourceId, state: "ready", complete: true, checkedAt: 1000 };
  const space = { ...historySpace, folder: f.root };
  await f.store.writeHistory(historyRegistry([entry], [source]), null);
  const calls = [];
  const runtime = { ...f, env: {}, peers: [], clock: () => 1000, historySources: [source], sdk: { getSessionInfo: async () => ({ sessionId: session.id }) },
    run: async (_host, command, args) => {
      calls.push([command, args]);
      if (args[0] === "service") return { code: 0, stdout: "http://127.0.0.1:4096", stderr: "" };
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ data: { id: session.id } }), stderr: "" };
      assert.deepEqual(args, ["--version"]);
      return { code: 0, stdout: "2.2.5", stderr: "" };
    } };
  return { ...f, entry, source, session, space, runtime, calls };
}
test("resume prepares an exact argument array without running a model turn", async t => {
  for (const harness of ["opencode-v2", "claude"]) {
    const f = await fixture(t, harness);
    const result = await prepareSessionResume(f.runtime, { session: f.session, space: f.space });
    assert.equal(result.kind, "launch"); assert.equal(result.args.space, "one"); assert.equal(result.args.folder, f.root);
    assert.deepEqual(result.args.argv, harness === "claude" ? ["claude", "--resume", "claude_saved"] : ["opencode", "--session", "ses_saved"]);
    assert.ok(!f.calls.some(([, args]) => args.includes("run") || args.includes("--prompt")));
  }
});
test("failed exact lookup never produces a launch descriptor", async t => {
  const f = await fixture(t, "claude"); f.runtime.sdk.getSessionInfo = async () => undefined;
  const result = await prepareSessionResume(f.runtime, { session: f.session, space: f.space });
  assert.equal(result.error, "session-missing"); assert.equal(result.kind, undefined);
});
test("missing folder, unavailable harness and wrong authority do not fall back", async t => {
  const f = await fixture(t);
  await f.store.writeHistory({ ...historyRegistry([{ ...f.entry, directory: f.root + "/missing" }], [f.source]), revision: 2 }, 1);
  assert.equal((await prepareSessionResume(f.runtime, { session: f.session, space: { ...f.space, folder: f.root + "/missing" } })).error, "directory-unavailable");
  assert.equal((await prepareSessionResume(f.runtime, { session: { ...f.session, authority: "unknown" }, space: f.space })).error, "session-unavailable");
  const current = await f.store.readHistory();
  await f.store.writeHistory({ ...historyRegistry([f.entry], [f.source]), revision: current.revision + 1 }, current.revision);
  const run = f.runtime.run;
  f.runtime.run = (host, command, args) => args[0] === "--version" ? { code: 1, stdout: "", stderr: "not installed" } : run(host, command, args);
  assert.equal((await prepareSessionResume(f.runtime, { session: f.session, space: f.space })).error, "harness-unavailable");
});
test("an already-open session is focused rather than launched again", async t => {
  const f = await fixture(t);
  const binding = { ...f.binding, session: f.session, space: f.space, address: "t-fixture", tab: "tab1", pane: "p1", presence: "open", connection: "confirmed", activity: "idle" };
  await f.store.bind(binding, null);
  await f.store.writeHistory({ ...historyRegistry([{ ...f.entry, bindings: [binding] }], [f.source]), revision: 2 }, 1);
  const run = f.runtime.run;
  f.runtime.run = (host, command, args) => command === "hc" ? { code: 0, stdout: JSON.stringify({ state: "live", created_ms: 100, pid: 10,
    foreground: { pid: 20 }, status: "idle", labels: { "herdr.space": "one", "herdr.tab": "tab1", "herdr.meta-binding": JSON.stringify({ key: bindingKey(binding), generation: binding.generation }) } }) }
    : command === "ps" ? { code: 0, stdout: args.includes("lstart=") ? "Thu Oct 01 12:00:00 2026" : "20" } : run(host, command, args);
  const result = await prepareSessionResume(f.runtime, { session: f.session, space: f.space });
  assert.equal(result.kind, "focus"); assert.equal(result.terminal, "t-fixture");
});

test("shell-special characters in a folder or title remain literal launch arguments", async t => {
  const f = await fixture(t);
  const directory = f.root + "/space; literal $(text)";
  await mkdir(directory);
  await f.store.writeHistory({ ...historyRegistry([{ ...f.entry, directory, title: "title; literal $(text)" }], [f.source]), revision: 2 }, 1);
  const result = await prepareSessionResume(f.runtime, { session: f.session, space: { ...f.space, folder: directory } });
  assert.equal(result.args.folder, directory); assert.equal(result.args.name, "title; literal $(text)");
  assert.deepEqual(result.args.argv, ["opencode", "--session", "ses_saved"]);
});

test("configured remote preparation stays on its machine and rejects arbitrary remote commands", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const session = { host: "remote", authority: "local", harness: "opencode-v2", id: "ses_remote" };
  const source = { ...session, id: JSON.stringify(["remote", "local", "opencode-v2"]), peerId: "box", state: "ready", complete: true };
  const space = { ...historySpace, host: "remote", id: "box/one", machine: "box", folder: "/srv/repo" };
  const saved = historyEntry("ses_remote", { session, sourceId: source.id, directory: "/srv/repo" });
  await f.store.writeHistory(historyRegistry([saved], [source]), null);
  const peer = { id: "box", host: "remote", transport: "ssh", target: "box" };
  let malicious = false;
  const runtime = { ...f, env: {}, peers: [peer], historySources: [], clock: () => 1000, run: async (_host, command, args) => {
    assert.equal(command, "ssh");
    if (args.some(a => a.includes("presence-snapshot"))) return { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", presence: [] }) };
    return { code: 0, stdout: JSON.stringify({ kind: "launch", sessionKey: JSON.stringify(["remote", "local", "opencode-v2", "ses_remote"]), command: "tab.new",
      args: { space: "one", folder: "/srv/repo", name: "Remote", argv: malicious ? ["sh", "-c", "unsafe"] : ["opencode", "--session", "ses_remote"] } }) };
  } };
  assert.equal((await prepareSessionResume(runtime, { session, space })).args.space, "box/one");
  malicious = true;
  assert.equal((await prepareSessionResume(runtime, { session, space })).error, "remote-resume-unavailable");
  runtime.peers = [];
  assert.equal((await prepareSessionResume(runtime, { session, space })).error, "execution-host-unavailable");
});

test("opening from History claims a browsing binding and repeated open focuses it", async t => {
  const f = await fixture(t), run = f.runtime.run;
  f.runtime.run = (host, command, args) => args[0] === "api" ? { code: 0, stdout: JSON.stringify({ data: { id: f.session.id, time: { created: 1, updated: 100, busy: 150, idle: 180 }, location: { directory: f.root } } }) } : run(host, command, args);
  const opened = await prepareSessionResume(f.runtime, { session: f.session, space: f.space, browsing: true });
  assert.equal(opened.kind, "launch");
  const binding = { ...f.binding, session: f.session, space: f.space, address: "t-fixture", pane: "p1", tab: "tab1", presence: "open", connection: "confirmed", activity: "idle" };
  await f.store.bind(binding, null);
  assert.equal((await f.store.listBindings())[0].browsing, true);
  assert.equal((await f.store.listBindings())[0].browseBaseline, 180);
  f.runtime.run = (host, command, args) => command === "hc" ? { code: 0, stdout: JSON.stringify({ state: "live", created_ms: 100, pid: 10,
    foreground: { pid: 20 }, status: "idle", labels: { "herdr.space": "one", "herdr.tab": "tab1", "herdr.meta-binding": JSON.stringify({ key: bindingKey(binding), generation: binding.generation }) } }) }
    : command === "ps" ? { code: 0, stdout: args.includes("lstart=") ? "Thu Oct 01 12:00:00 2026" : "20" } : run(host, command, args);
  assert.equal((await prepareSessionResume(f.runtime, { session: f.session, space: f.space, browsing: true })).kind, "focus");
});
