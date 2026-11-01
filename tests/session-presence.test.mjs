import test from "node:test";
import assert from "node:assert/strict";
import { probeSessionBinding, collectSessionPresence } from "../integrations/session-metadata/src/session-presence.mjs";
import { metadataFixture, isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";
import { bindingKey, verifyInheritedBinding } from "../integrations/session-metadata/src/contracts.mjs";

function fixture() {
  const { binding } = metadataFixture();
  const terminal = { address: binding.terminal, state: "live", created_ms: binding.createdMs, pid: 10, foreground: { pid: 20 },
    status: "idle", labels: { "herdr.space": "one", "herdr.tab": "tab1", "herdr.meta-binding": JSON.stringify({ key: bindingKey(binding), generation: binding.generation }) } };
  const run = async (_host, command, args) => command === "hc" ? { code: 0, stdout: JSON.stringify(terminal), stderr: "" }
    : { code: 0, stdout: args.includes("lstart=") ? "Thu Oct 01 12:00:00 2026\n" : "20\n", stderr: "" };
  return { binding, terminal, run };
}

test("open session presence is independent of activity and captures its Space", async () => {
  for (const status of ["idle", "done", "blocked", "working", null]) {
    const f = fixture(); f.terminal.status = status;
    const result = await probeSessionBinding(f.binding, f);
    assert.equal(result.state, "open");
    assert.equal(result.binding.space.id, "one");
    assert.equal(result.binding.activity, status);
    assert.ok(result.binding.processStartedAt);
  }
});

test("an exited agent is closed even when the terminal remains a live shell", async () => {
  const f = fixture(); f.terminal.foreground.pid = 10;
  const result = await probeSessionBinding(f.binding, { run: async (host, command, args, options) => command === "ps"
    ? { code: 1, stdout: "", stderr: "" } : f.run(host, command, args, options) });
  assert.equal(result.state, "closed");
});

test("terminal replacement, explicit release and confirmed terminal death close only that binding", async () => {
  for (const change of [{ created_ms: 101 }, { state: "finished" }, { labels: { "herdr.space": "one", "herdr.tab": "tab1" } }, { foreground: null, pid: null, reason: "holder_lost" }]) {
    const f = fixture(); Object.assign(f.terminal, change);
    assert.equal((await probeSessionBinding(f.binding, f)).state, "closed");
  }
});

test("transport failures and malformed snapshots are unknown, not closure", async () => {
  const { binding } = fixture();
  for (const run of [async () => { throw Error("offline"); }, async () => ({ code: 1, stdout: "", stderr: "permission denied" }),
    async () => ({ code: 0, stdout: "bad json" }), async () => ({ code: 0, stdout: "{}" })]) {
    assert.equal((await probeSessionBinding(binding, { run })).state, "unknown");
  }
  assert.equal((await probeSessionBinding(binding, { run: async () => ({ code: 3, stdout: "", stderr: '{"error":{"kind":"not_found"}}' }) })).state, "closed");
});

test("reused producer PIDs do not rebind an older conversation", async () => {
  const f = fixture(); f.binding.processStartedAt = "Wed Sep 30 12:00:00 2026";
  assert.equal((await probeSessionBinding(f.binding, f)).state, "closed");
});

test("successful empty binding inventory differs from failed inventory", async t => {
  const f = fixture();
  const previous = { schema: 1, owner: "herdr-session-metadata", revision: 1, updatedAt: 1, sources: [], sessions: [{ bindings: [f.binding] }] };
  for (const failed of [false, true]) {
    const result = await collectSessionPresence({ store: { listBindings: async () => { if (failed) throw Error("unavailable"); return []; } }, previous, run: f.run, env: {} }, []);
    assert.equal(result.presence[0].state, failed ? "unknown" : "closed");
  }
  const isolated = await isolatedFixture(); t.after(isolated.cleanup);
  await isolated.store.bind(f.binding, null);
  const result = await collectSessionPresence({ ...isolated, run: f.run, env: {} }, []);
  assert.equal(result.presence[0].state, "open");
});

test("release preserves a second binding and ignores stale generations", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const first = f.binding, second = { ...first, terminal: "t-other", generation: "other" };
  await f.store.bind(first, null); await f.store.bind(second, null);
  await f.store.write({ ...f.record, bindings: [first, second].map(b => ({ key: bindingKey(b), generation: b.generation })) }, null);
  assert.equal(await f.store.releaseSessionBinding({ ...first, generation: "stale" }), false);
  assert.equal(await f.store.releaseSessionBinding(first), true);
  assert.equal((await f.store.read(f.key)).ended, false);
  assert.equal((await f.store.listBindings()).length, 1);
  assert.equal(await f.store.releaseSessionBinding(second), true);
  assert.equal((await f.store.read(f.key)).ended, true);
});

test("binding registration captures the verified Space before a short-lived session ends", async () => {
  const f = fixture();
  const value = await verifyInheritedBinding({ env: { HC_TERMINAL_ID: f.binding.terminal }, producerPid: 20, session: f.binding.session, run: f.run });
  assert.equal(value.space.id, "one");
  assert.equal(value.tab, "tab1");
});

test("peer reconnect reconciles a complete empty inventory without treating outages as closure", async () => {
  const f = fixture(), old = { ...f.binding, fromPeerId: "peer", coreHost: "remote", session: { ...f.binding.session, host: "remote" } };
  const peer = { id: "peer", host: "remote", transport: "ssh", target: "box" };
  const runtime = { env: {}, store: { listBindings: async () => [] }, previous: { sessions: [{ bindings: [old] }] } };
  for (const connected of [false, true]) {
    const result = await collectSessionPresence({ ...runtime, run: async () => connected
      ? { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", presence: [] }), stderr: "" }
      : { code: 1, stdout: "", stderr: "offline" } }, [peer]);
    assert.equal(result.presence[0].state, connected ? "closed" : "unknown");
  }
});
