import test from "node:test";
import assert from "node:assert/strict";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";
import { historySpace, historyEntry, historyRegistry } from "./helpers/session-history-fixtures.mjs";
import { partitionSpaceSessions, reconcileSessionRegistry } from "../integrations/session-metadata/src/session-registry.mjs";

const bound = (binding, extra = {}) => ({ ...binding, space: historySpace, address: binding.terminal, tab: "tab1", pane: "p1", activity: "idle", presence: "open", connection: "confirmed", ...extra });

test("opening for browsing stays in History independently of startup activity", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const binding = bound(f.binding);
  await f.store.beginHistoryBrowse(f.key, historySpace, 100);
  await f.store.bind(binding, null);
  const browsing = await f.store.getBinding(JSON.stringify([binding.coreHost, binding.coreSession, binding.terminal, binding.createdMs]));
  assert.equal(browsing.browsing, true);
  for (const activity of [null, "idle", "done", "working"]) {
    const result = partitionSpaceSessions({ registry: historyRegistry([historyEntry(f.key.id, { session: f.key, bindings: [{ ...browsing, activity }] })]), space: historySpace });
    assert.equal(result.agents.length, 0);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].primaryBinding.address, binding.terminal);
  }
});

test("only new work activates a browsing binding, and stale generations cannot activate replacements", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const binding = bound(f.binding);
  await f.store.beginHistoryBrowse(f.key, historySpace, 100);
  await f.store.bind(binding, null);
  assert.equal(await f.store.activateSessionBinding(binding, { observedAt: 50 }), false);
  const renewed = { ...binding, generation: "renewed" };
  await f.store.bind(renewed, binding.generation);
  assert.equal(await f.store.activateSessionBinding(binding, { observedAt: 200 }), false);
  assert.equal(await f.store.activateSessionBinding(renewed, { observedAt: 200 }), true);
  const active = (await f.store.listBindings())[0];
  assert.equal(active.browsing, false);
  const result = partitionSpaceSessions({ registry: historyRegistry([historyEntry(f.key.id, { session: f.key, bindings: [active] })]), space: historySpace });
  assert.equal(result.agents.length, 1); assert.equal(result.history.length, 0);
});

test("a browsing intent cannot claim another Space's binding", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.beginHistoryBrowse(f.key, historySpace, 100);
  await f.store.bind(bound(f.binding, { space: { ...historySpace, id: "other" } }), null);
  assert.notEqual((await f.store.listBindings())[0].browsing, true);
});

test("an activated copy wins over browsing copies without duplicating the session", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const browse = bound(f.binding, { browsing: true, focused: true });
  const active = bound(f.binding, { browsing: false, terminal: "t2", address: "t2", generation: "g2", activity: "blocked" });
  const registry = historyRegistry([historyEntry(f.key.id, { session: f.key, bindings: [browse, active] })]);
  const result = partitionSpaceSessions({ registry, space: historySpace });
  assert.equal(result.agents.length, 1); assert.equal(result.history.length, 0);
  assert.equal(result.agents[0].primaryBinding.address, "t2");
  const next = reconcileSessionRegistry(registry, { presence: [{ state: "open", binding: { ...active, browsing: true } }], now: 2000 });
  assert.equal(partitionSpaceSessions({ registry: next, space: historySpace }).agents.length, 1);
});

test("work activation does not wait for unrelated session-metadata enrichment", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const binding = bound(f.binding);
  await f.store.beginHistoryBrowse(f.key, historySpace, 100); await f.store.bind(binding, null);
  let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = f.store.withMutation(f.key, async () => { entered(); await new Promise(resolve => { finish = resolve; }); });
  await ready;
  try { assert.equal(await f.store.activateSessionBinding(binding, { observedAt: 200 }), true); }
  finally { finish(); await held; }
});
