import assert from "node:assert/strict";
import test from "node:test";
import { proposeTitle } from "../integrations/session-metadata/src/naming.mjs";
import { applyObservation } from "../integrations/session-metadata/src/engine.mjs";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";
import { main } from "../integrations/session-metadata/bin/herdr-session-meta.mjs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { metadataFixture, isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";

test("confirmed ticket/PR names are deterministic and retain their short description", () => {
  const i = metadataFixture().titleInput;
  assert.deepEqual(proposeTitle(i), { action: "rename", title: "PROJ-101 #6104 Features" });
  assert.deepEqual(proposeTitle({ ...i, currentTitle: "PROJ-101 #6104 Features", description: "PROJ-101 #6104 Features" }), { action: "noop", reason: "already-named" });
  const context = { ...i.context, activePrUrl: null, lastCreatedPrUrl: null, prs: {} };
  assert.deepEqual(proposeTitle({ ...i, context }), { action: "rename", title: "PROJ-101 Features" });
});

test("manual overrides, conflicting prefixes and missing tickets never get guessed", () => {
  const i = metadataFixture().titleInput;
  assert.equal(proposeTitle({ ...i, currentTitle: "PROJ-102 Different task" }).action, "pause");
  assert.equal(proposeTitle({ ...i, manualOverride: true }).action, "pause");
  assert.equal(proposeTitle({ ...i, context: { ...i.context, ticket: null } }).action, "noop");
});

test("name truncation counts Unicode characters and never cuts ticket or PR identifiers", () => {
  const i = metadataFixture().titleInput;
  const result = proposeTitle({ ...i, description: "😀".repeat(200) });
  assert.equal([...result.title].length, 120);
  assert.ok(result.title.startsWith("PROJ-101 #6104 "));
  assert.equal(proposeTitle({ ...i, context: { ...i.context, ticket: { id: "TRACK-" + "1".repeat(125), source: "task" } } }).action, "pause");
});

test("a merged PR keeps an already managed historical name", () => {
  const i = metadataFixture().titleInput;
  const url = i.context.activePrUrl;
  const currentTitle = "PROJ-101 #6104 Features";
  assert.equal(proposeTitle({ ...i, currentTitle, lastManagedTitle: currentTitle,
    context: { ...i.context, activePrUrl: null, prs: { [url]: { ...i.context.prs[url], state: "MERGED" } } } }).action, "noop");
});

async function engineFixture(t, mode = "active") {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.bind(f.binding, null);
  f.record.bindings = [{ key: bindingKey(f.binding), generation: f.binding.generation }];
  await f.store.write(f.record, null);
  const deps = { store: f.store, access: f.access, clock: () => 1000,
    validateBinding: async () => true, hasAuthority: async () => true, activationMode: async () => mode,
    resolveContext: async () => ({ state: "resolved", context: f.context }) };
  return { ...f, deps };
}

test("the real engine renames exactly its bound root and acknowledges readback once", async t => {
  const f = await engineFixture(t);
  assert.equal((await applyObservation(f.observation, f.binding, f.deps)).state, "renamed");
  assert.deepEqual(f.calls, ["PROJ-101 #6104 Features"]);
  assert.equal((await f.store.read(f.key)).canonicalTitle, "PROJ-101 #6104 Features");
  await applyObservation(f.observation, f.binding, f.deps);
  assert.equal(f.calls.length, 1);
});

test("observe mode and child/late-generation events never rename", async t => {
  const f = await engineFixture(t, "observe");
  assert.equal((await applyObservation(f.observation, f.binding, f.deps)).state, "pending");
  assert.deepEqual(f.calls, []);
  for (const extra of [{ parentId: "parent" }, { generation: "older" }, { session: { ...f.key, id: "ses_other" } }]) {
    assert.equal((await applyObservation({ ...f.observation, ...extra }, f.binding, f.deps)).state, "ignored");
  }
});

test("external names and failed readback cannot be published as a successful rename", async t => {
  const f = await engineFixture(t);
  f.deps.access = { get: async () => ({ key: f.key, title: "Never changed", parentId: null }), rename: async () => {} };
  assert.notEqual((await applyObservation(f.observation, f.binding, f.deps)).state, "renamed");
  assert.notEqual((await f.store.read(f.key)).canonicalTitle, "PROJ-101 #6104 Features");
});

test("a superseded work-context response loses its revision race instead of overwriting newer state", async t => {
  const f = await engineFixture(t);
  f.deps.resolveContext = async () => {
    const r = await f.store.read(f.key);
    await f.store.write({ ...r, revision: r.revision + 1, canonicalTitle: "Newer session context" }, r.revision);
    return { state: "resolved", context: f.context };
  };
  assert.equal((await applyObservation(f.observation, f.binding, f.deps)).state, "ignored");
  assert.equal((await f.store.read(f.key)).canonicalTitle, "Newer session context");
  assert.deepEqual(f.calls, []);
});

test("explicit resume releases manual ownership without changing a canonical title itself", async t => {
  const f = await engineFixture(t);
  const old = await f.store.read(f.key);
  await f.store.write({ ...old, manualOverride: true, canonicalTitle: "My name", revision: old.revision + 1 }, old.revision);
  await main(["auto-name", "--session", JSON.stringify(f.key), "--resume"], f);
  const actual = await f.store.read(f.key);
  assert.equal(actual.manualOverride, false);
  assert.equal(actual.canonicalTitle, "My name");
  assert.equal(actual.pendingRename, null);
  assert.deepEqual(f.calls, []);
});

test("manual changes during readback pause ownership before any later observation", async t => {
  const f = await engineFixture(t);
  let title = "Features", count = 0;
  f.deps.access = { get: async key => ({ key, title, parentId: null }), rename: async () => { count++; title = "Manual during rename"; } };
  await applyObservation(f.observation, f.binding, f.deps);
  const record = await f.store.read(f.key);
  assert.equal(record.manualOverride, true);
  assert.equal(record.canonicalTitle, "Manual during rename");
  await applyObservation({ ...f.observation, eventId: "next-event", observedAt: 2000 }, f.binding, f.deps);
  assert.equal(count, 1);
});

test("mode changes during the last binding check cancel mutation at dispatch", async t => {
  const f = await engineFixture(t);
  let mode = "active", checks = 0;
  f.deps.activationMode = async () => mode;
  f.deps.validateBinding = async () => { if (++checks === 4) mode = "observe"; return true; };
  await applyObservation(f.observation, f.binding, f.deps);
  assert.deepEqual(f.calls, []);
});

test("separate hook processes cannot let an older rename overwrite a newer canonical title", async t => {
  const f = await engineFixture(t);
  await writeFile(join(f.root, "harness-title"), "Features");
  function worker(role) {
    const child = fork(new URL("./helpers/metadata-rename-worker.mjs", import.meta.url), [f.root, role], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const events = [];
    child.on("message", m => events.push(m));
    const exit = once(child, "exit");
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const event = type => events.some(m => m.type === type) ? Promise.resolve() : new Promise(resolve => {
      const listen = m => { if (m.type === type) { child.off("message", listen); resolve(); } }; child.on("message", listen);
    });
    return { child, exit, event };
  }
  const a = worker("A"); await a.event("rename");
  const b = worker("B"); await b.event("ready");
  let timeout;
  await Promise.race([b.event("done"), new Promise(resolve => { timeout = setTimeout(resolve, 500); })]);
  clearTimeout(timeout);
  a.child.send("release");
  const exits = await Promise.all([a.exit, b.exit]);
  assert.deepEqual(exits.map(e => e[0]), [0, 0]);
  assert.equal(await readFile(join(f.root, "harness-title"), "utf8"), "PROJ-101 #6105 Features");
  assert.equal((await f.store.read(f.key)).canonicalTitle, "PROJ-101 #6105 Features");
});

test("a ticket prefix joined to the name by a dash or colon is replaced without leaving the separator", () => {
  const context = { ticket: { id: "PROJ-101" }, prs: { u: { number: 7, state: "OPEN", title: "" } }, activePrUrl: "u", repo: { name: "repo" } };
  for (const title of ["PROJ-101-refine-scaling", "PROJ-101: refine-scaling", "PROJ-101 - refine-scaling"]) {
    const result = proposeTitle({ currentTitle: title, lastManagedTitle: null, manualOverride: false, description: title, context });
    assert.equal(result.title, "PROJ-101 #7 refine-scaling", title);
  }
});
