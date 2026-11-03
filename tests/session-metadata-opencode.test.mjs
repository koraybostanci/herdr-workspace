import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeAdapter, executionScope } from "../integrations/session-metadata/opencode/adapter.mjs";
import { applyObservation } from "../integrations/session-metadata/src/engine.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";

async function fixture(t, { enabled = true } = {}) {
  const f = await isolatedFixture();
  let route = { type: "session", sessionID: "ses_A" };
  const updates = [], reads = [];
  const sessions = new Map(["ses_A", "ses_B", "ses_child"].map(id => [id, { id, title: "Features", projectID: "project-fixture", cost: 0,
    tokens: { input: 0, output: 0 }, time: { created: 1, updated: 1 }, location: { directory: "/parent" }, ...(id === "ses_child" ? { parentID: "ses_A" } : {}) }]));
  const context = { app: { version: "2.2.4" }, options: {}, location: { directory: "/parent" },
    ui: { router: { current: () => route } },
    client: { session: { get: async ({ sessionID }) => { reads.push(sessionID); return sessions.get(sessionID); },
      update: async ({ sessionID, title }) => { updates.push([sessionID, title]); sessions.get(sessionID).title = title; } } },
    data: { listen: () => () => {}, session: { sync: async () => {}, get: id => sessions.get(id), root: id => id === "ses_child" ? "ses_A" : id,
      message: { sync: async () => {}, list: () => [{ type: "user", id: "user-1", time: { created: 1 }, text: "Implement PROJ-101 Features" }] } } },
  };
  let generation = 0, now = 1000;
  const identity = { enabled,
    verify: async session => ({ ...f.binding, session, generation: `g-${++generation}` }),
    commit: async b => f.store.bind(b, (await f.store.getBinding(bindingKey(b)))?.generation ?? null),
    validate: async b => route?.type === "session" && route.sessionID === b.session.id,
    release: async b => f.store.invalidate(bindingKey(b), b.generation),
  };
  const engine = (o, b, deps) => applyObservation(o, b, { ...deps, resolveContext: async () => ({ state: "resolved", context: f.context }) });
  const adapter = createOpenCodeAdapter(context, { engine, store: f.store, identity, clock: () => now,
    activationMode: async () => "active", publish: async () => {} });
  t.after(async () => { await adapter.dispose(); await f.cleanup(); });
  return { ...f, workContext: f.context, context, adapter, sessions, updates, reads, advance: n => { now += n; }, route: value => { route = value; } };
}

test("V2 active session IDs, not equal display names, select the rename target", async t => {
  const f = await fixture(t);
  await f.adapter.refresh();
  assert.deepEqual(f.updates, [["ses_A", "PROJ-101 #6104 Features"]]);
  f.route({ type: "session", sessionID: "ses_B" });
  await f.adapter.refresh();
  assert.deepEqual(f.updates, [["ses_A", "PROJ-101 #6104 Features"], ["ses_B", "PROJ-101 #6104 Features"]]);
});

test("a displayed child cannot rename its parent and unrelated terminals remain inert", async t => {
  const f = await fixture(t);
  f.route({ type: "session", sessionID: "ses_child" });
  await f.adapter.refresh();
  assert.deepEqual(f.updates, []);
  const other = await fixture(t, { enabled: false });
  await other.adapter.refresh();
  assert.deepEqual(other.reads, []);
  assert.deepEqual(other.updates, []);
});

test("route changes or disposal during session lookup discard the stale response", async t => {
  const f = await fixture(t);
  let finish;
  f.context.client.session.get = () => new Promise(resolve => { finish = resolve; });
  const pending = f.adapter.refresh();
  await Promise.resolve();
  assert.equal(typeof finish, "function");
  f.route({ type: "home" });
  finish(f.sessions.get("ses_A"));
  await pending;
  assert.deepEqual(f.updates, []);
});

test("a new V2 session with no generated title is still bindable", async t => {
  const f = await fixture(t);
  delete f.sessions.get("ses_A").title;
  await assert.doesNotReject(f.adapter.refresh());
  assert.equal(f.updates[0]?.[0], "ses_A");
});

test("an explicit unconfigured remote server cannot masquerade as a local execution host", () => {
  assert.equal(executionScope(["opencode", "--server", "https://remote.example"], {}), null);
  assert.deepEqual(executionScope(["opencode"], {}), { host: "local", authority: "local" });
  assert.deepEqual(executionScope(["opencode", "--server=https://remote.example"], {
    servers: { "https://remote.example": { host: "devbox", authority: "devbox-service" } },
  }), { host: "devbox", authority: "devbox-service" });
});

test("resumed extra authorities resolve through owned history sources without changing CLI options", () => {
  const options = { appHome: "/fixture/app", stateRoot: "/fixture/metadata" };
  const sources = [{ harness: "opencode-v2", server: "http://127.0.0.1:4096", host: "local", authority: "other-service" }];
  assert.deepEqual(executionScope(["opencode", "--server", "http://127.0.0.1:4096", "--session", "ses_existing"], options, sources), { host: "local", authority: "other-service" });
  assert.equal(options.servers, undefined);
  assert.equal(executionScope(["opencode", "--server", "https://unconfigured.example"], options, sources), null);
});

test("pairing acknowledges the exact currently displayed root without requiring inherited HC identity", async t => {
  const f = await fixture(t, { enabled: false });
  let paired;
  const adapter = createOpenCodeAdapter(f.context, { store: f.store, identity: { enabled: true, release: async () => {} },
    pair: async (token, live) => { paired = live.key.id; return { ...f.binding, session: live.key, mode: "paired" }; } });
  await adapter.pair("a".repeat(48));
  assert.equal(paired, "ses_A");
  await adapter.dispose();
});

test("unchanged sessions reverify PR state after the one-minute cache expires", async t => {
  const f = await fixture(t);
  await f.adapter.refresh(); await f.adapter.refresh();
  f.workContext.activePrUrl = null;
  f.workContext.prs = {};
  f.advance(61000);
  await f.adapter.refresh();
  const key = (await f.store.listBindings())[0].session;
  assert.equal((await f.store.read(key)).contexts["github.com/team/repo-a"].activePrUrl, null);
});

test("explicit V2 session location changes enter the metadata pipeline", async t => {
  const f = await fixture(t);
  const seen = [];
  f.context.data.session.message.list = () => [{ type: "location-switched", id: "location-1", time: { created: 1 }, location: { directory: "/work/new-checkout" } }];
  const adapter = createOpenCodeAdapter(f.context, { store: f.store, clock: () => 1000,
    identity: { enabled: true, verify: async session => ({ ...f.binding, session }), commit: async () => true, release: async () => {}, validate: async () => true },
    engine: async o => { seen.push(o); return { state: "published", record: null }; } });
  await adapter.refresh(); await adapter.dispose();
  assert.ok(seen.some(o => o.kind === "location" && o.payload.cwd === "/work/new-checkout"));
});

test("reopening an ended OpenCode conversation reactivates it before observations", async t => {
  const f = await fixture(t);
  await f.adapter.refresh();
  const old = (await f.store.listBindings())[0];
  await f.store.releaseSessionBinding(old);
  assert.equal((await f.store.read(old.session)).ended, true);
  const resumed = createOpenCodeAdapter(f.context, { store: f.store, clock: () => 2000,
    identity: { enabled: true, verify: async session => ({ ...old, session, generation: "resumed" }),
      commit: b => f.store.bind(b, null), release: b => f.store.releaseSessionBinding(b) },
    engine: async () => { assert.equal((await f.store.read(old.session)).ended, false); } });
  t.after(() => resumed.dispose());
  await resumed.refresh();
});

test("OpenCode browsing ignores historical messages and old work events but activates on new input", async t => {
  const f = await fixture(t), session = { host: "local", authority: "local", harness: "opencode-v2", id: "ses_A" };
  f.binding.space = { host: "local", coreSession: "default", id: "space" };
  await f.store.beginHistoryBrowse(session, f.binding.space, 100);
  await f.adapter.refresh(); await f.adapter.refresh();
  assert.equal((await f.store.listBindings())[0].browsing, true);
  const event = (created, type = "session.execution.started") => ({ id: `evt_${created}`, created, type,
    durable: { aggregateID: "ses_A", seq: created, version: 1 }, data: { sessionID: "ses_A" } });
  await f.adapter.observeWork(event(50));
  await f.adapter.observeWork(event(200, "session.viewed"));
  assert.equal((await f.store.listBindings())[0].browsing, true);
  await f.adapter.observeWork({ ...event(200, "session.inbox.enqueued"), data: { sessionID: "ses_A", inboxID: "msg_new",
    item: { type: "user", payload: { text: "Continue" }, delivery: "queue" } } });
  assert.equal((await f.store.listBindings())[0].browsing, false);
});

test("a fork ignores the parent's copied history and only reacts to its own messages", async t => {
  const f = await fixture(t);
  const seen = [];
  f.sessions.get("ses_A").time = { created: 5000, updated: 5000 };
  f.context.data.session.message.list = () => [
    { type: "user", id: "inherited", time: { created: 1 }, text: "Implement PROJ-101 Features" },
    { type: "user", id: "own", time: { created: 6000 }, text: "Review something else" }];
  const adapterWithSpy = createOpenCodeAdapter(f.context, { engine: async (o, b, d) => { seen.push(o.eventId); return applyObservation(o, b, { ...d, resolveContext: async () => ({ state: "resolved", context: f.workContext }) }); },
    store: f.store, identity: { enabled: true, verify: async session => ({ ...f.binding, session, generation: "g-fork" }),
      commit: async b => f.store.bind(b, null), validate: async () => true, release: async () => {} },
    clock: () => 7000, activationMode: async () => "observe", publish: async () => {} });
  await adapterWithSpy.refresh();
  await adapterWithSpy.dispose();
  assert.equal(seen.includes("inherited"), false);
  assert.equal(seen.includes("own"), true);
});
