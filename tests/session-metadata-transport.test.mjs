import assert from "node:assert/strict";
import test from "node:test";
import { collectSnapshots, createPairing, installOffer, acceptPairing, reconcileBinding, launchPaired } from "../integrations/session-metadata/src/transport.mjs";
import { verifyInheritedBinding } from "../integrations/session-metadata/src/contracts.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";
import { createRuntime, main } from "../integrations/session-metadata/bin/herdr-session-meta.mjs";
import { dispatchPending, applyPeerPending, watchMailbox } from "../integrations/session-metadata/src/pending.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";

const peer = { id: "devbox", host: "devbox", transport: "ssh", target: "devbox", helperPath: "/home/test user/meta/bin.mjs" };
async function pairFixture(t) {
  const core = await isolatedFixture(), remote = await isolatedFixture();
  t.after(async () => { await core.cleanup(); await remote.cleanup(); });
  let now = 1000;
  const term = { state: "live", created_ms: 100, pid: 10, foreground: { pid: 20 }, labels: { "herdr.space": "space", "herdr.tab": "tab" } };
  const run = async (host, command, args, options = {}) => {
    assert.equal(host, "local");
    if (command === "ssh") {
      await installOffer(JSON.parse(options.input), { store: remote.store, clock: () => now });
      return { code: 0, stdout: '{"offered":true}', stderr: "" };
    }
    assert.equal(command, "hc");
    if (args[0] === "label") term.labels["herdr.meta-binding"] = args[2].slice("herdr.meta-binding=".length);
    return { code: 0, stdout: JSON.stringify(term), stderr: "" };
  };
  const live = { key: { host: "devbox", authority: "claude", harness: "claude", id: "11111111-1111-4111-8111-111111111111" }, title: "Features", parentId: null, lookupDir: "/home/test user/repo" };
  return { core, remote, term, run, live, clock: () => now, advance: n => { now += n; } };
}

test("a peer read uses only its configured transport and preserves quoted helper paths", async () => {
  let calls = 0;
  const result = await collectSnapshots([peer], async (host, command, args, options) => {
    calls++;
    assert.equal(host, "local"); assert.equal(command, "ssh");
    assert.ok(args.includes("devbox"));
    assert.ok(args.at(-1).includes("'/home/test user/meta/bin.mjs'"));
    assert.equal(options.timeout, 5000);
    return { code: 0, stdout: '{"schema":1,"owner":"herdr-session-metadata","updatedAt":1000,"entries":[]}', stderr: "" };
  });
  assert.equal(result.snapshots.length, 1); assert.equal(calls, 1);
});

test("offline peers return diagnostics without attempting to start a core", async () => {
  const r = await collectSnapshots([peer], async (_host, command, args) => {
    assert.equal(command, "ssh"); assert.ok(!args.includes("start"));
    return { code: 1, stdout: "", stderr: "offline" };
  });
  assert.equal(r.errors.length, 1); assert.equal(r.snapshots.length, 0);
});

test("pairing requires an exact live-session acknowledgement and is single-use", async t => {
  const f = await pairFixture(t);
  const issued = await createPairing({ terminal: "t-fixture", peer, harness: "claude", sessionId: f.live.key.id },
    { store: f.core.store, run: f.run, clock: f.clock, env: {} });
  assert.ok(issued?.token);
  const binding = await acceptPairing(issued.token, f.live, { store: f.remote.store, clock: f.clock, producerPid: 42, ownerStartedAt: "process-start" });
  assert.equal(binding.mode, "paired"); assert.equal(binding.session.host, "devbox");
  assert.equal(await reconcileBinding(binding, peer, { store: f.core.store, run: f.run, clock: f.clock }), true);
  assert.ok(f.term.labels["herdr.meta-binding"]);
  await assert.rejects(acceptPairing(issued.token, f.live, { store: f.remote.store, clock: f.clock, producerPid: 42, ownerStartedAt: "process-start" }), /used|replay/i);
});

test("expired or mismatched-host/session challenges cannot bind a terminal", async t => {
  const f = await pairFixture(t);
  const issue = () => createPairing({ terminal: "t-fixture", peer, harness: "claude", sessionId: f.live.key.id }, { store: f.core.store, run: f.run, clock: f.clock, env: {} });
  const a = await issue();
  await assert.rejects(acceptPairing(a.token, { ...f.live, key: { ...f.live.key, host: "other" } }, { store: f.remote.store, clock: f.clock, producerPid: 42, ownerStartedAt: "start" }), /mismatch|host/i);
  f.advance(60001);
  await assert.rejects(acceptPairing(a.token, f.live, { store: f.remote.store, clock: f.clock, producerPid: 42, ownerStartedAt: "start" }), /expired/i);
});

test("HC terminals not adopted by Herdr do not opt in merely by exporting HC_TERMINAL_ID", async () => {
  const run = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ state: "live", pid: 10, foreground: { pid: 20 }, created_ms: 100, labels: {} }) });
  assert.equal(await verifyInheritedBinding({ env: { HC_TERMINAL_ID: "t1" }, producerPid: 20,
    session: { host: "local", authority: "local", harness: "opencode-v2", id: "ses_other_app" }, run }), null);
});

test("runtime delivers offer stdin without interpreting it as shell input", async () => {
  const runtime = createRuntime(process.env);
  const result = await runtime.run("local", process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: '{"offer":"a;$(false)"}' });
  assert.equal(result.stdout, '{"offer":"a;$(false)"}');
});

test("CLI offer validates and stores a received private challenge", async t => {
  const f = await pairFixture(t);
  await createPairing({ terminal: "t-fixture", peer, harness: "claude" }, { store: f.core.store, run: f.run, clock: f.clock, env: {} });
  const offers = await import("node:fs/promises");
  const files = await offers.readdir(f.core.root + "/offers");
  const input = await offers.readFile(f.core.root + "/offers/" + files[0], "utf8");
  await assert.doesNotReject(main(["offer"], { store: f.remote.store, clock: f.clock, input, env: {} }));
});

test("remote pending renames require a fresh core dispatch and exact revision", async t => {
  const f = await pairFixture(t);
  const issued = await createPairing({ terminal: "t-fixture", peer, harness: "claude", sessionId: f.live.key.id }, { store: f.core.store, run: f.run, clock: f.clock, env: {} });
  const binding = await acceptPairing(issued.token, f.live, { store: f.remote.store, clock: f.clock, producerPid: 42, ownerStartedAt: "start" });
  const old = await f.remote.store.read(f.live.key);
  const record = { ...old, revision: 1, pendingRename: { expectedTitle: "Features", title: "PROJ-101 #6104 Features", revision: 1, generation: binding.generation } };
  await f.remote.store.write(record, 0);
  let title = "Features", renamed = 0;
  const deps = { store: f.remote.store, clock: f.clock, validateOwner: async () => true,
    access: { get: async key => ({ key, title, parentId: null }), rename: async (_key, next) => { title = next; renamed++; } }, activationMode: async () => "active" };
  assert.equal(await applyPeerPending({ session: f.live.key, generation: binding.generation, revision: 1 }, deps), null);
  const run = async (host, command, args, options) => {
    if (command !== "ssh") return f.run(host, command, args, options);
    const result = await applyPeerPending(JSON.parse(options.input), deps);
    return { code: 0, stdout: JSON.stringify({ record: result }), stderr: "" };
  };
  assert.equal((await dispatchPending({ binding, record }, peer, { store: f.core.store, run, clock: f.clock }))?.canonicalTitle, "PROJ-101 #6104 Features");
  assert.equal(renamed, 1);
  f.term.created_ms++;
  assert.equal(await dispatchPending({ binding, record }, peer, { store: f.core.store, run, clock: f.clock }), null);
  assert.equal(renamed, 1);
});

test("an idle mailbox initializes store ownership before creating its private subdirectory", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const stop = await watchMailbox(f, async () => null); t.after(stop);
  await assert.doesNotReject(f.store.listBindings());
});
