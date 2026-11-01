import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { prepareSessionResume } from "../integrations/session-metadata/src/history-view.mjs";
import * as historyActions from "../integrations/session-metadata/src/history-view.mjs";
import { refreshSessionCatalog } from "../integrations/session-metadata/src/history-catalog.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";
import { historySpace, historyEntry, historyRegistry } from "./helpers/session-history-fixtures.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";
import { main } from "../integrations/session-metadata/bin/herdr-session-meta.mjs";

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
test("unavailable exact metadata never produces a launch descriptor", async t => {
  const f = await fixture(t, "claude"); f.runtime.sdk.getSessionInfo = async () => undefined;
  const result = await prepareSessionResume(f.runtime, { session: f.session, space: f.space });
  assert.equal(result.error, "session-unavailable"); assert.equal(result.kind, undefined);
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

async function deletionFixture(t, harness = "opencode-v2") {
  const f = await fixture(t, harness);
  let exists = true;
  f.runtime.sdk = {
    getSessionInfo: async id => exists ? { sessionId: id } : undefined,
    deleteSession: async (id, options) => {
      assert.equal(id, f.session.id); assert.deepEqual(options, { dir: f.root }); exists = false;
    },
    listSessions: async () => exists ? [{ sessionId: f.session.id, cwd: f.root, summary: "Saved session", lastModified: 1000 }] : [],
  };
  f.runtime.run = async (_host, command, args) => {
    f.calls.push([command, args]);
    assert.equal(command, "opencode");
    if (args[0] === "service") return { code: 0, stdout: "http://127.0.0.1:4096", stderr: "" };
    if (args[2] === "/api/session") return { code: 0, stdout: JSON.stringify({ data: [], cursor: { next: null } }), stderr: "" };
    assert.equal(args[2], "/api/session/ses_saved");
    if (args[1] === "delete") { exists = false; return { code: 0, stdout: "", stderr: "" }; }
    return exists ? { code: 0, stdout: JSON.stringify({ data: { id: f.session.id } }), stderr: "" }
      : { code: 1, stdout: "", stderr: JSON.stringify({ _tag: "SessionNotFoundError" }) };
  };
  return f;
}
async function deleteSaved(f, extra = {}) {
  assert.equal(typeof historyActions.deleteSavedSession, "function", "native session deletion is implemented");
  return historyActions.deleteSavedSession(f.runtime, { session: f.session, space: f.space, confirmed: true, ...extra });
}

test("confirmed deletion removes only the exact native OpenCode conversation and survives catalog refresh", async t => {
  const f = await deletionFixture(t), neighbor = historyEntry("ses_other", { directory: f.root });
  const binding = { ...f.binding, session: f.session, space: f.space, lookupDir: f.root };
  await f.store.bind(binding, null); await f.store.invalidate(bindingKey(binding), binding.generation);
  await f.store.write({ ...f.record, session: f.session }, null);
  await f.store.writeHistory({ ...historyRegistry([f.entry, neighbor], [f.source]), revision: 2 }, 1);
  const result = await deleteSaved(f);
  assert.equal(result.deleted, true); assert.equal(result.sessionKey, '["local","local","opencode-v2","ses_saved"]');
  assert.deepEqual(f.calls.filter(([, args]) => args[1] === "delete"), [["opencode", ["api", "delete", "/api/session/ses_saved"]]]);
  assert.deepEqual((await f.store.readHistory()).sessions.map(e => e.session.id), ["ses_other"]);
  assert.deepEqual(await f.store.listHistoryAssociations(), []);
  assert.equal(await f.store.read(f.session), null);
  assert.ok(!(await refreshSessionCatalog(f.runtime, { force: true })).sessions.some(e => e.session.id === "ses_saved"));
});

test("Claude deletion uses the SDK and the original directory", async t => {
  const f = await deletionFixture(t, "claude");
  assert.equal((await deleteSaved(f)).deleted, true);
  assert.deepEqual((await f.store.readHistory()).sessions, []);
  assert.deepEqual(f.calls, []);
});

test("deletion requires confirmation and a session visible in the requested Space", async t => {
  const f = await deletionFixture(t);
  for (const request of [{ confirmed: false }, { space: { ...f.space, id: "other", folder: "/other" } },
    { session: { ...f.session, authority: "unconfigured" } }, { session: { ...f.session, id: "../unsafe" } }]) {
    assert.ok((await deleteSaved(f, request)).error);
  }
  assert.equal((await f.store.readHistory()).sessions.length, 1);
  assert.deepEqual(f.calls, []);
});

test("native deletion failure preserves catalog entries and associations", async t => {
  const f = await deletionFixture(t, "claude");
  const binding = { ...f.binding, session: f.session, space: f.space, lookupDir: f.root };
  await f.store.bind(binding, null); await f.store.invalidate(bindingKey(binding), binding.generation);
  f.runtime.sdk.deleteSession = async () => { throw Error("permission denied"); };
  assert.equal((await deleteSaved(f)).error, "delete-failed");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
  assert.equal((await f.store.listHistoryAssociations()).length, 1);
});

test("a successful native call is not reported as deletion until exact lookup confirms it is gone", async t => {
  const f = await deletionFixture(t, "claude");
  f.runtime.sdk.deleteSession = async () => {};
  assert.equal((await deleteSaved(f)).error, "deletion-unverified");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
});

test("Claude not-found without a deletion receipt stays unverified because empty transcripts can produce it", async t => {
  const f = await deletionFixture(t, "claude");
  f.runtime.sdk.getSessionInfo = async () => undefined;
  f.runtime.sdk.deleteSession = async () => { throw Error(`Session ${f.session.id} not found in project directory for ${f.root}`); };
  assert.equal((await deleteSaved(f)).error, "deletion-unverified");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
});

test("missing Claude summary metadata still requires native transcript deletion", async t => {
  const f = await deletionFixture(t, "claude");
  let transcriptExists = true;
  f.runtime.sdk.getSessionInfo = async () => undefined;
  f.runtime.sdk.deleteSession = async (id, options) => {
    assert.equal(id, f.session.id); assert.deepEqual(options, { dir: f.root }); transcriptExists = false;
  };
  assert.equal((await deleteSaved(f)).deleted, true);
  assert.equal(transcriptExists, false, "metadata absence must not stand in for actual transcript deletion");
});

test("open browsing sessions and unavailable presence block deletion", async t => {
  for (const available of [true, false]) {
    const f = await deletionFixture(t);
    const binding = { ...f.binding, session: f.session, space: f.space, lookupDir: f.root, address: "t-fixture", tab: "tab1",
      presence: "open", connection: "confirmed", activity: "idle", browsing: true };
    await f.store.beginHistoryBrowse(f.session, f.space); await f.store.bind(binding, null);
    await f.store.writeHistory({ ...historyRegistry([{ ...f.entry, bindings: [binding] }], [f.source]), revision: 2 }, 1);
    f.runtime.run = async (_host, command, args) => {
      assert.ok(["hc", "ps"].includes(command), "a native delete must never run while presence is open or unknown");
      if (!available) return { code: 1, stdout: "", stderr: "unavailable" };
      return command === "hc" ? { code: 0, stdout: JSON.stringify({ state: "live", created_ms: 100, pid: 10,
        foreground: { pid: 20 }, labels: { "herdr.space": "one", "herdr.tab": "tab1",
          "herdr.meta-binding": JSON.stringify({ key: bindingKey(binding), generation: binding.generation }) } }) }
        : { code: 0, stdout: args.includes("lstart=") ? "Thu Oct 01 12:00:00 2026" : "20" };
    };
    assert.equal((await deleteSaved(f)).error, "session-open");
    assert.equal((await f.store.readHistory()).sessions.length, 1);
  }
});

test("deletion targets an explicitly configured OpenCode authority rather than the local service", async t => {
  const f = await deletionFixture(t), session = { ...f.session, authority: "extra" };
  const source = { ...f.source, authority: "extra", id: '["local","extra","opencode-v2"]', server: "https://sessions.example.test" };
  f.session = session; f.runtime.historySources = [source];
  await f.store.writeHistory({ ...historyRegistry([{ ...f.entry, session, sourceId: source.id }], [source]), revision: 2 }, 1);
  assert.equal((await deleteSaved(f)).deleted, true);
  assert.ok(f.calls.every(([, args]) => args.includes("https://sessions.example.test")));
  assert.deepEqual(f.calls.find(([, args]) => args[1] === "delete"), ["opencode", ["api", "delete", "/api/session/ses_saved", "--server", "https://sessions.example.test"]]);
});

test("remote deletion requires an exact acknowledgement from the configured execution peer", async t => {
  const f = await deletionFixture(t), session = { ...f.session, host: "remote" };
  const source = { ...f.source, host: "remote", id: '["remote","local","opencode-v2"]', peerId: "box" };
  const space = { ...f.space, host: "remote", machine: "box", id: "box/one" };
  f.session = session; f.space = space;
  await f.store.writeHistory({ ...historyRegistry([{ ...f.entry, session, sourceId: source.id }], [source]), revision: 2 }, 1);
  f.runtime.peers = [{ id: "box", host: "remote", transport: "ssh", target: "box" }];
  let wrong = true;
  f.runtime.run = async (_host, command, args) => {
    assert.equal(command, "ssh");
    if (args.some(a => a.includes("presence-snapshot"))) return { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", presence: [] }) };
    assert.ok(args.some(a => a.includes("delete-session")));
    assert.ok(args.some(a => a.includes('"id":"one"') && a.includes('"confirmed":true')));
    return { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", deleted: true,
      sessionKey: wrong ? '["local","local","opencode-v2","ses_saved"]' : '["remote","local","opencode-v2","ses_saved"]' }) };
  };
  assert.equal((await deleteSaved(f)).error, "remote-delete-unavailable");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
  wrong = false;
  assert.equal((await deleteSaved(f)).deleted, true);
  assert.deepEqual((await f.store.readHistory()).sessions, []);
});

test("the helper CLI dispatches a confirmed delete-session request", async t => {
  const f = await deletionFixture(t, "claude"), output = [];
  t.mock.method(process.stdout, "write", value => { output.push(value); return true; });
  assert.equal(await main(["delete-session", "--request", JSON.stringify({ session: f.session, space: f.space, confirmed: true }), "--json"], f.runtime), 0);
  assert.equal(JSON.parse(output.join("")).deleted, true);
  assert.deepEqual((await f.store.readHistory()).sessions, []);
});

test("unavailable native lookup and a stopped OpenCode service never dispatch deletion", async t => {
  for (const harness of ["claude", "opencode-v2"]) {
    const f = await deletionFixture(t, harness);
    f.runtime.sdk.getSessionInfo = async () => { throw Error("unavailable"); };
    f.runtime.sdk.deleteSession = async () => assert.fail("unavailable storage must not be deleted");
    f.runtime.run = async (_host, _command, args) => {
      assert.deepEqual(args, ["service", "status"], "a stopped service must not receive any API request");
      return { code: 1, stdout: "", stderr: "stopped" };
    };
    assert.equal((await deleteSaved(f)).error, "session-unavailable");
    assert.equal((await f.store.readHistory()).sessions.length, 1);
  }
});

test("a durable opening claim blocks deletion from another controller until it expires", async t => {
  const f = await deletionFixture(t, "claude");
  f.runtime.run = async (_host, command, args) => {
    assert.equal(command, "claude"); assert.deepEqual(args, ["--version"]); return { code: 0, stdout: "available" };
  };
  assert.equal((await prepareSessionResume(f.runtime, { session: f.session, space: f.space, browsing: true })).kind, "launch");
  assert.equal((await deleteSaved(f)).error, "session-open");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
  f.runtime.clock = () => 62000;
  assert.equal((await deleteSaved(f)).deleted, true, "a failed launch does not block deletion forever");
});

test("a resume cannot publish an opening claim after concurrent deletion removed its session", async t => {
  const f = await deletionFixture(t, "claude"), get = f.runtime.sdk.getSessionInfo;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  let first = true;
  f.runtime.sdk.getSessionInfo = async id => {
    if (!first) return get(id);
    first = false; started();
    return new Promise(resolve => { release = () => resolve({ sessionId: id }); });
  };
  f.runtime.run = async () => ({ code: 0, stdout: "available" });
  const opening = prepareSessionResume(f.runtime, { session: f.session, space: f.space, browsing: true });
  await ready;
  assert.equal((await deleteSaved(f)).deleted, true);
  release();
  assert.equal((await opening).kind, undefined, "a stale resume must not launch a deleted conversation");
});

async function remoteDeletionFixture(t, paired = false) {
  const local = await deletionFixture(t), remote = await deletionFixture(t);
  const session = { ...remote.session, host: "remote" };
  const source = { ...remote.source, host: "remote", id: '["remote","local","opencode-v2"]' };
  const space = paired ? historySpace : { ...historySpace, host: "remote", machine: "box", id: "box/one", folder: remote.root };
  const entry = { ...remote.entry, session, sourceId: source.id };
  const association = { host: "remote", coreSession: "default", id: "native-space", associatedAt: 1000 };
  await remote.store.writeHistory({ ...historyRegistry([{ ...entry, associations: paired ? [association] : [] }], [source]), revision: 2 }, 1);
  await local.store.writeHistory({ ...historyRegistry([{ ...entry, associations: paired ? [{ ...historySpace, associatedAt: 1000 }] : [] }],
    [{ ...source, peerId: "box" }]), revision: 2 }, 1);
  remote.runtime.env = { HERDR_METADATA_HOST: "remote" }; remote.runtime.historySources = [source];
  local.session = session; local.space = space;
  local.runtime.peers = [{ id: "box", host: "remote", transport: "ssh", target: "box" }];
  let loseAcknowledgement = false;
  local.runtime.run = async (_host, command, args) => {
    assert.equal(command, "ssh");
    if (args.some(a => a.includes("presence-snapshot"))) return { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", presence: [] }) };
    const request = JSON.parse(args.at(-1).match(/'--request' '([^']+)'/)[1]);
    const result = await historyActions.deleteSavedSession(remote.runtime, request);
    if (loseAcknowledgement) { loseAcknowledgement = false; return { code: 1, stdout: "", stderr: "connection lost" }; }
    return { code: 0, stdout: JSON.stringify(result) };
  };
  return { local, remote, loseNextAcknowledgement() { loseAcknowledgement = true; } };
}

test("a paired remote conversation in a local Space deletes through its exact configured peer", async t => {
  const { local, remote } = await remoteDeletionFixture(t, true);
  assert.equal((await deleteSaved(local)).deleted, true);
  assert.deepEqual((await local.store.readHistory()).sessions, []);
  assert.deepEqual((await remote.store.readHistory()).sessions, []);
  assert.equal(remote.calls.filter(([, args]) => args[1] === "delete").length, 1);
});

test("a lost remote deletion acknowledgement can be retried after the peer's catalog row is gone", async t => {
  const f = await remoteDeletionFixture(t);
  f.loseNextAcknowledgement();
  assert.equal((await deleteSaved(f.local)).error, "remote-delete-unavailable");
  assert.deepEqual((await f.remote.store.readHistory()).sessions, []);
  assert.equal((await f.local.store.readHistory()).sessions.length, 1);
  assert.equal((await deleteSaved(f.local)).deleted, true);
  assert.deepEqual((await f.local.store.readHistory()).sessions, []);
  assert.equal(f.remote.calls.filter(([, args]) => args[1] === "delete").length, 1, "retry must acknowledge the completed deletion without deleting again");
});

test("an old deletion receipt cannot acknowledge a rediscovered session in another Space", async t => {
  const f = await deletionFixture(t, "claude");
  assert.equal((await deleteSaved(f)).deleted, true);
  const current = await f.store.readHistory();
  await f.store.writeHistory({ ...current, revision: current.revision + 1, sessions: [{ ...f.entry,
    associations: [{ ...f.space, id: "other", associatedAt: 2000 }] }] }, current.revision);
  assert.equal((await deleteSaved(f)).error, "session-unavailable");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
});

test("Claude deletion retries finish interrupted catalog cleanup, including after refresh", async t => {
  for (const refresh of [false, true]) {
    const f = await deletionFixture(t, "claude"), get = f.runtime.sdk.getSessionInfo, remove = f.runtime.sdk.deleteSession;
    f.runtime.sdk.deleteSession = async (id, options) => {
      if (!await get(id)) throw Error(`Session ${id} not found in project directory for ${options.dir}`);
      return remove(id, options);
    };
    const write = f.store.writeHistory.bind(f.store);
    let fail = true;
    f.store.writeHistory = async (...args) => {
      if (fail) { fail = false; throw Error("interrupted registry write"); }
      return write(...args);
    };
    assert.equal((await deleteSaved(f)).error, "history-unavailable");
    assert.equal(await get(f.session.id), undefined, "the native transcript was already deleted");
    assert.equal(await f.store.historyDeleted(f.session), true);
    assert.equal((await f.store.readHistory()).sessions.length, 1);
    if (refresh) await refreshSessionCatalog(f.runtime, { force: true });
    assert.equal((await deleteSaved(f)).deleted, true, "the durable native deletion proof must allow catalog cleanup to finish");
    assert.deepEqual((await f.store.readHistory()).sessions, []);
  }
});

test("native rediscovery invalidates an old deletion receipt before another ambiguous Claude lookup", async t => {
  const f = await deletionFixture(t, "claude");
  assert.equal((await deleteSaved(f)).deleted, true);
  f.runtime.sdk.listSessions = async () => [{ sessionId: f.session.id, cwd: f.root, summary: "Restored session", lastModified: 2000 }];
  await refreshSessionCatalog(f.runtime, { force: true });
  assert.equal((await f.store.readHistory()).sessions.length, 1);
  assert.equal(await f.store.historyDeleted(f.session), false, "a newly discovered native conversation must not inherit completed deletion proof");
  f.runtime.sdk.deleteSession = async () => { throw Error(`Session ${f.session.id} not found in project directory for ${f.root}`); };
  assert.equal((await deleteSaved(f)).error, "deletion-unverified");
  assert.equal((await f.store.readHistory()).sessions.length, 1);
});
