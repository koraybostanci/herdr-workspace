import assert from "node:assert/strict";
import test from "node:test";
import { stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sessionKey, bindingKey, validateSnapshot, verifyInheritedBinding, commitBinding } from "../integrations/session-metadata/src/contracts.mjs";
import { metadataFixture, isolatedFixture, projectRoot } from "./helpers/session-metadata-fixtures.mjs";

test("session and terminal identities never depend on their display names", () => {
  const { key, binding } = metadataFixture();
  assert.notEqual(sessionKey(key), sessionKey({ ...key, id: "ses_fixture_B" }));
  assert.notEqual(sessionKey(key), sessionKey({ ...key, host: "devbox" }));
  assert.notEqual(bindingKey(binding), bindingKey({ ...binding, coreSession: "other" }));
  assert.notEqual(bindingKey(binding), bindingKey({ ...binding, createdMs: 101 }));
});

test("versioned metadata collector honors its explicit app and private state paths", async t => {
  const f=await isolatedFixture();t.after(f.cleanup);
  const app=join(f.root,"app"),state=join(f.root,"state");
  const result=spawnSync(process.execPath,["integrations/session-metadata/bin/herdr-session-meta.mjs","refresh-view","--app-home",app,"--state-root",state],
    {cwd:projectRoot,encoding:"utf8",env:{...process.env,HERDR_APP_HOME:join(f.root,"wrong-app"),HERDR_METADATA_STATE_DIR:join(f.root,"wrong-state")}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(await readFile(join(app,"data/space-agents/session-view.json"),"utf8")).owner,"herdr-session-metadata");
});

test("record writes compare revisions and stay private under concurrent writers", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  assert.equal(await f.store.write(f.record, null), true);
  const next = { ...f.record, revision: 1 };
  const results = await Promise.all([f.store.write(next, 0), f.store.write(next, 0)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal((await f.store.read(f.key)).revision, 1);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
});

test("snapshot assembly rejects corrupt records and mismatched binding generations", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  assert.equal(await f.store.bind(f.binding, null), true);
  const record = { ...f.record, bindings: [{ key: bindingKey(f.binding), generation: f.binding.generation }] };
  await f.store.write(record, null);
  const terminal = { address: f.binding.terminal, state: "live", created_ms: 100,
    foreground: { pid: 20 }, labels: { "herdr.meta-binding": JSON.stringify({ key: bindingKey(f.binding), generation: f.binding.generation }) } };
  assert.equal((await f.store.view([terminal])).entries.length, 1);
  assert.equal((await f.store.view([{ ...terminal, created_ms: 101 }])).entries.length, 0);
  await f.store.invalidate(bindingKey(f.binding), f.binding.generation);
  assert.equal((await f.store.view([terminal])).entries.length, 0);
});

test("foreign or malformed snapshots cannot supply card metadata", () => {
  assert.equal(validateSnapshot({ schema: 1, owner: "foreign", entries: [] }), null);
  assert.equal(validateSnapshot({ schema: 1, owner: "herdr-session-metadata", entries: [{ binding: {} }] }), null);
});

test("inherited identity accepts a real foreground harness or its owned child without any agent status", async () => {
  const { key } = metadataFixture();
  const term = { state: "live", created_ms: 100, pid: 10, foreground: { pid: 21 }, labels: { "herdr.space": "space", "herdr.tab": "tab" } };
  const run = async (_host, command, args) => ({ code: 0, stderr: "", stdout: command === "hc" ? JSON.stringify(term) : args.at(-1) === "21" ? "20\n" : "10\n" });
  const binding = await verifyInheritedBinding({ env: { HC_TERMINAL_ID: "t-fixture", HC_SESSION: "default" }, producerPid: 20, session: key, run });
  assert.ok(binding);
  assert.equal(binding.processPid, 20);
  assert.equal(binding.createdMs, 100);
  assert.equal(await verifyInheritedBinding({ env: {}, producerPid: 20, session: key, run }), null);
  const unrelated = async (_h, c) => ({ code: 0, stderr: "", stdout: c === "hc" ? JSON.stringify(term) : "1\n" });
  assert.equal(await verifyInheritedBinding({ env: { HC_TERMINAL_ID: "t-fixture" }, producerPid: 99, session: key, run: unrelated }), null);
});

test("failed core label writes never acknowledge a binding", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const term = { state: "live", created_ms: 100, pid: 10, foreground: { pid: 20 }, labels: { "herdr.space": "space", "herdr.tab": "tab" } };
  const run = async (_h, _c, args) => ({ code: args[0] === "label" ? 1 : 0, stderr: "denied", stdout: JSON.stringify(term) });
  assert.equal(await commitBinding(f.binding, { store: f.store, run }), false);
  assert.equal((await f.store.view([])).entries.length, 0);
});

test("private storage refuses a foreign owner and never persists raw event payloads", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await writeFile(join(f.root, "owner.json"), '{"owner":"foreign"}');
  await assert.rejects(f.store.write(f.record, null), /owner|foreign/i);
});

test("doctor CLI defaults to observe mode in an isolated state directory", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const result = spawnSync(process.execPath, ["integrations/session-metadata/bin/herdr-session-meta.mjs", "doctor", "--json"], {
    cwd: projectRoot, encoding: "utf8",
    env: { ...process.env, HERDR_METADATA_STATE_DIR: f.root, HERDR_APP_HOME: join(f.root, "app"), HC_SESSION: "herdr-meta-test" },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).mode, "observe");
});

test("records cannot smuggle raw prompt or tool payload fields into durable state", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await assert.rejects(f.store.write({ ...f.record, payload: { prompt: "private text" } }, null), /invalid|payload/i);
});

test("installed hc get records prove direct and shell-launched owners through foreground tty ancestry", async () => {
  const { key } = metadataFixture();
  const term = { state: "live", created_ms: 100, pid: 10, labels: { "herdr.space": "space", "herdr.tab": "tab" } };
  const run = async (_h, command, args) => ({ code: 0, stdout: command === "hc" ? JSON.stringify(term)
    : args.at(-1) === "10" ? "1 10 20 ttys007 Ss\n" : "10 20 20 ttys007 S+\n", stderr: "" });
  const input = { env: { HC_TERMINAL_ID: "t1" }, producerPid: 20, session: key, run };
  assert.ok(await verifyInheritedBinding(input));
  term.foreground = { pid: 10 };
  assert.ok(await verifyInheritedBinding(input), "foreground group leaders may supervise the real harness in the same tty job");
  assert.equal(await verifyInheritedBinding({ ...input, run: async (_h, c) => ({ code: 0, stdout: c === "hc" ? JSON.stringify(term) : "10 21 20 ttys007 S\n", stderr: "" }) }), null);
});
