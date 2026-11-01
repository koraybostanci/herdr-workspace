import test from "node:test";
import assert from "node:assert/strict";
import { sessionIdentityKey, validateRegistry, partitionSpaceSessions, reconcileSessionRegistry, normalizedDirectory } from "../integrations/session-metadata/src/session-registry.mjs";

const space = { host: "local", coreSession: "default", id: "one", folder: "/repo", machine: null };
const other = { ...space, id: "two" };
const identity = (id = "ses_A", extra = {}) => ({ host: "local", authority: "local", harness: "opencode-v2", id, ...extra });
const entry = (id = "ses_A", extra = {}) => ({ session: identity(id), title: "Same title", directory: "/repo", updatedAt: 1000,
  sourceId: "local-opencode", saved: "available", associations: [], bindings: [], ...extra });
const binding = (extra = {}) => ({ session: identity(), coreHost: "local", coreSession: "default", terminal: "t1", createdMs: 100,
  processPid: 20, generation: "g1", mode: "inherited", space, tab: "tab1", pane: "p1", address: "t1", focused: false,
  activity: "idle", connection: "confirmed", presence: "open", ...extra });
const registry = sessions => ({ schema: 1, owner: "herdr-session-metadata", revision: 0, updatedAt: 1000, sessions, sources: [] });
const ids = rows => rows.map(row => row.session.id);

test("activity never moves an open session to History", () => {
  for (const activity of ["working", "blocked", "done", "idle", null]) {
    const result = partitionSpaceSessions({ registry: registry([entry("ses_A", { bindings: [binding({ activity })] }), entry("ses_B")]), space });
    assert.deepEqual(ids(result.agents), ["ses_A"]);
    assert.deepEqual(ids(result.history), ["ses_B"]);
    assert.equal(new Set([...result.agents, ...result.history].map(row => row.key)).size, 2);
  }
});

test("identical native IDs remain separate across hosts, authorities and harnesses", () => {
  const keys = [identity(), identity("ses_A", { host: "remote" }), identity("ses_A", { authority: "private" }), identity("ses_A", { harness: "claude" })].map(sessionIdentityKey);
  assert.equal(new Set(keys).size, 4);
  const result = partitionSpaceSessions({ registry: registry([entry(), entry("ses_A", { session: identity("ses_A", { authority: "private" }) })]), space });
  assert.equal(result.history.length, 2);
});

test("folder fallback is exact and host scoped, preserving roots", () => {
  const sessions = [entry("ses_A", { directory: "/repo/" }), entry("ses_B", { directory: "/repo-child" }),
    entry("ses_C", { session: identity("ses_C", { host: "remote" }) }), entry("ses_D", { directory: "/repo/subdir" })];
  assert.deepEqual(ids(partitionSpaceSessions({ registry: registry(sessions), space }).history), ["ses_A"]);
  assert.deepEqual(ids(partitionSpaceSessions({ registry: registry([entry("root", { directory: "/" })]), space: { ...space, folder: "/" } }).history), ["root"]);
});

test("Windows drive roots compare without losing the root separator", () => {
  assert.equal(normalizedDirectory("C:\\"), "C:/");
  const result = partitionSpaceSessions({ registry: registry([entry("root", { directory: "C:\\" })]), space: { ...space, folder: "C:/" } });
  assert.deepEqual(ids(result.history), ["root"]);
});

test("literal POSIX backslashes never alias another Space's directory", () => {
  assert.equal(normalizedDirectory("/repo/a\\b"), "/repo/a\\b");
  const sessions = [entry("literal", { directory: "/repo/a\\b" }), entry("nested", { directory: "/repo/a/b" })];
  assert.deepEqual(ids(partitionSpaceSessions({ registry: registry(sessions), space: { ...space, folder: "/repo/a\\b" } }).history), ["literal"]);
});

test("verified associations beat same-folder discovery before and after closing", () => {
  const saved = entry("ses_A", { associations: [{ ...space, associatedAt: 10 }], bindings: [binding()] });
  assert.deepEqual(partitionSpaceSessions({ registry: registry([saved]), space: other }), { agents: [], history: [] });
  saved.bindings = [];
  assert.deepEqual(ids(partitionSpaceSessions({ registry: registry([saved]), space }).history), ["ses_A"]);
  assert.deepEqual(partitionSpaceSessions({ registry: registry([saved]), space: other }), { agents: [], history: [] });
  assert.equal(partitionSpaceSessions({ registry: registry([entry()]), space: other }).history.length, 1);
});

test("multiple bindings produce one focused row with aggregate activity", () => {
  const first = binding({ activity: "blocked" });
  const second = binding({ terminal: "t2", address: "t2", pane: "p2", generation: "g2", focused: true });
  const result = partitionSpaceSessions({ registry: registry([entry("ses_A", { bindings: [first, second] })]), space });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].primaryBinding.address, "t2");
  assert.equal(result.agents[0].activity, "blocked");
});

test("unknown presence retains a previously open session without inventing new ones", () => {
  const previous = registry([entry("ses_A", { bindings: [binding()] })]);
  const next = reconcileSessionRegistry(previous, { presence: [{ state: "unknown", binding: binding() }, { state: "unknown", binding: binding({ session: identity("new") }) }], now: 2000 });
  assert.equal(next.sessions.length, 1);
  assert.equal(next.sessions[0].bindings[0].connection, "unavailable");
  assert.equal(partitionSpaceSessions({ registry: next, space }).agents.length, 1);
});

test("closing only the exact generation preserves another open binding", () => {
  const second = binding({ terminal: "t2", address: "t2", generation: "g2" });
  const previous = registry([entry("ses_A", { bindings: [binding(), second] })]);
  const unchanged = reconcileSessionRegistry(previous, { presence: [{ state: "closed", binding: binding({ generation: "old" }) }], now: 2000 });
  assert.equal(unchanged.sessions[0].bindings.length, 2);
  const next = reconcileSessionRegistry(previous, { presence: [{ state: "closed", binding: binding() }], now: 2000 });
  assert.deepEqual(next.sessions[0].bindings.map(b => b.address), ["t2"]);
  assert.equal(partitionSpaceSessions({ registry: next, space }).agents.length, 1);
});

test("conversation switches replace the binding without losing the old saved record", () => {
  const previous = registry([entry("ses_A", { bindings: [binding()] })]);
  const next = reconcileSessionRegistry(previous, { presence: [{ state: "open", binding: binding({ session: identity("ses_B"), generation: "new" }) }], now: 2000 });
  const result = partitionSpaceSessions({ registry: next, space });
  assert.deepEqual(ids(result.agents), ["ses_B"]);
  assert.deepEqual(ids(result.history), ["ses_A"]);
});

test("partial discovery preserves native timestamps and verified associations", () => {
  const previous = registry([entry("ses_A", { associations: [{ ...space, associatedAt: 500 }] }), entry("ses_B")]);
  const next = reconcileSessionRegistry(previous, { discoveries: [{ entries: [entry("ses_A", { title: "Updated", updatedAt: 1500 })], complete: false }], now: 9000 });
  assert.equal(next.sessions.length, 2);
  assert.equal(next.sessions[0].updatedAt, 1500);
  assert.equal(next.sessions[0].associations[0].id, "one");
  assert.equal(next.sessions[1].updatedAt, 1000);
});

test("confirmed missing records remain visible while open and disappear only after closure", () => {
  const previous = registry([entry("ses_A", { bindings: [binding()] })]);
  const next = reconcileSessionRegistry(previous, { discoveries: [{ entries: [entry("ses_A", { saved: "missing" })] }], now: 2000 });
  assert.equal(partitionSpaceSessions({ registry: next, space }).agents.length, 1);
  const closed = reconcileSessionRegistry(next, { presence: [{ state: "closed", binding: binding() }], now: 3000 });
  assert.equal(closed.sessions.length, 0);
});

test("invalid records and foreign schemas cannot supply rows", () => {
  assert.equal(validateRegistry({ ...registry([]), owner: "foreign" }), null);
  assert.equal(validateRegistry({ ...registry([]), schema: 2 }), null);
  for (const invalid of [entry("ses_A", { session: { id: "ses_A" } }), entry("ses_A", { title: "unsafe\nvalue" }), entry("ses_A", { bindings: [{}] })]) {
    assert.equal(validateRegistry(registry([invalid])), null);
  }
  assert.deepEqual(partitionSpaceSessions({ registry: registry([entry()]), space: null }), { agents: [], history: [] });
  assert.deepEqual(partitionSpaceSessions({ registry: { owner: "foreign" }, space }), { agents: [], history: [] });
});
