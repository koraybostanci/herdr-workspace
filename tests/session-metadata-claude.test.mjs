import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { atomicJson, readJson } from "../integrations/session-metadata/src/store.mjs";
import { main } from "../integrations/session-metadata/bin/herdr-session-meta.mjs";
import { handleClaudeHook, createClaudeSessionAccess } from "../integrations/session-metadata/claude/adapter.mjs";
import { applyObservation } from "../integrations/session-metadata/src/engine.mjs";
import { isolatedFixture, projectRoot } from "./helpers/session-metadata-fixtures.mjs";

const id = "11111111-1111-4111-8111-111111111111";
async function fixture(t, mode = "active") {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.listBindings();
  await atomicJson(join(f.root, "activation.json"), { schema: 1, owner: "herdr-session-metadata", mode });
  let title = "Features";
  const calls = [], lookups = [];
  const sdk = { getSessionInfo: async (sessionId, options) => {
    lookups.push(options?.dir); return { sessionId, summary: title, customTitle: title, cwd: "/parent" };
  }, renameSession: async (sessionId, name, options) => { calls.push({ sessionId, name, dir: options?.dir }); title = name; } };
  const term = { state: "live", created_ms: 100, pid: 10, foreground: { pid: 20 }, labels: { "herdr.space": "space", "herdr.tab": "tab" } };
  const run = async (_host, command, args) => {
    assert.equal(command, "hc");
    if (args[0] === "label") term.labels["herdr.meta-binding"] = args[2].slice("herdr.meta-binding=".length);
    return { code: 0, stdout: JSON.stringify(term), stderr: "" };
  };
  const deps = { env: { HC_TERMINAL_ID: "t-fixture", HC_SESSION: "default" }, producerPid: 20, store: f.store, sdk, run,
    clock: (() => { let time = 1000; return () => ++time; })(),
    engine: (o, b, d) => applyObservation(o, b, { ...d, resolveContext: async () => ({ state: "resolved", context: f.context }) }) };
  const input = { hook_event_name: "UserPromptSubmit", session_id: id, prompt_id: "prompt-1", cwd: "/parent", prompt: "Implement PROJ-101 Features", permission_mode: "default" };
  return { ...f, deps, sdk, calls, lookups, input, setTitle: value => { title = value; } };
}

test("Claude's exact root UUID is renamed and normal title hooks return acknowledged names", async t => {
  const f = await fixture(t);
  const result = await handleClaudeHook(f.input, f.deps);
  assert.deepEqual(f.calls, [{ sessionId: id, name: "PROJ-101 #6104 Features", dir: "/parent" }]);
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(result.hookSpecificOutput.sessionTitle, "PROJ-101 #6104 Features");
  assert.equal(result.decision, undefined);
});

test("Claude lookup directory stays separate from later repository work directories", async t => {
  const f = await fixture(t);
  await handleClaudeHook(f.input, f.deps);
  await handleClaudeHook({ ...f.input, hook_event_name: "PostToolUse", cwd: "/parent/repo-b", tool_use_id: "tool-2", tool_name: "Bash", tool_input: { command: "git status" }, tool_response: { stdout: "clean", stderr: "" } }, f.deps);
  assert.ok(f.lookups.every(dir => dir === "/parent"));
  assert.equal(f.calls.length, 1);
});

test("unbound, child, and observe-only hooks cannot mutate sessions", async t => {
  const f = await fixture(t);
  assert.deepEqual(await handleClaudeHook(f.input, { ...f.deps, env: {} }), {});
  assert.deepEqual(await handleClaudeHook({ ...f.input, agent_id: "child-1" }, f.deps), {});
  assert.deepEqual(f.calls, []);
  const observing = await fixture(t, "observe");
  assert.deepEqual(await handleClaudeHook(observing.input, observing.deps), {});
  assert.deepEqual(observing.calls, []);
});

test("root agent_type is not mistaken for a child and manual names are not overwritten", async t => {
  const f = await fixture(t);
  await handleClaudeHook({ ...f.input, agent_type: "reviewer" }, f.deps);
  assert.equal(f.calls.length, 1);
  f.setTitle("My manual title");
  const output = await handleClaudeHook({ ...f.input, prompt_id: "prompt-2", session_title: "My manual title" }, f.deps);
  assert.deepEqual(output, {});
  assert.equal(f.calls.length, 1);
});

test("SDK response identity is validated before any rename", async () => {
  const access = createClaudeSessionAccess({ getSessionInfo: async () => ({ sessionId: "other", summary: "Wrong" }), renameSession: () => assert.fail("wrong target") }, "/parent");
  await assert.rejects(access.get({ host: "local", authority: "claude", harness: "claude", id }), /identity|session/i);
});

test("an ordinary CLI hook outside Herdr performs no state writes", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const r = spawnSync(process.execPath, ["integrations/session-metadata/bin/herdr-session-meta.mjs", "hook", "claude"], {
    cwd: projectRoot, encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: id, cwd: f.root, prompt: "private" }),
    env: { ...process.env, HC_TERMINAL_ID: "", HERDR_METADATA_STATE_DIR: f.root, HERDR_APP_HOME: join(f.root, "app") },
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {});
  assert.deepEqual(await readdir(f.root), []);
});

test("clear/fork registration cannot be undone by a late tool hook from the previous session", async t => {
  const f = await fixture(t);
  await handleClaudeHook(f.input, f.deps);
  const next = "22222222-2222-4222-8222-222222222222";
  f.setTitle("Features");
  await handleClaudeHook({ ...f.input, hook_event_name: "SessionStart", session_id: next, source: "clear" }, f.deps);
  assert.equal((await f.store.listBindings())[0].session.id, next);
  await handleClaudeHook({ ...f.input, hook_event_name: "PostToolUse", tool_use_id: "late-old-tool", tool_input: { command: "git status" }, tool_response: { stdout: "clean" } }, f.deps);
  assert.equal((await f.store.listBindings())[0].session.id, next);
});

test("an ignored stale hook never emits a previously managed title into the new session", async t => {
  const f = await fixture(t);
  await handleClaudeHook(f.input, f.deps);
  f.deps.engine = async (_o, binding) => {
    await f.store.bind({ ...binding, generation: "new-generation", session: { ...binding.session, id: "22222222-2222-4222-8222-222222222222" } }, binding.generation);
    return { state: "ignored", record: null };
  };
  assert.deepEqual(await handleClaudeHook({ ...f.input, prompt_id: "prompt-2" }, f.deps), {});
});

test("session end invalidates only its own generation without querying the SDK", async t => {
  const f = await fixture(t);
  await handleClaudeHook(f.input, f.deps);
  f.deps.sdk = () => assert.fail("session cleanup must not query SDK/network");
  assert.deepEqual(await handleClaudeHook({ ...f.input, hook_event_name: "SessionEnd" }, f.deps), {});
  assert.equal((await f.store.listBindings()).length, 0);
});

test("whole pairing prompts are intercepted even outside HC and never forwarded to a model", async t => {
  const f = await fixture(t);
  const result = await handleClaudeHook({ ...f.input, prompt: "herdr-pair " + "a".repeat(48) }, { ...f.deps, env: {}, pair: async () => { throw new Error("expired"); } });
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes("Pairing"));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await handleClaudeHook({ ...f.input, prompt: "Please explain herdr-pair abc" }, { ...f.deps, env: {} }), {});
});

test("producer hook updates never replace the collector's assembled remote view", async t => {
  const f = await fixture(t, "observe");
  const assembled = { schema: 1, owner: "herdr-session-metadata", updatedAt: 1000, entries: [], remoteMarker: "keep" };
  await f.store.publish(assembled);
  await main(["hook", "claude"], { ...f.deps, input: JSON.stringify(f.input) });
  assert.deepEqual(await readJson(f.store.viewFile), assembled);
});

test("initial lifecycle titles remain canonical before Claude flushes the session to SDK storage", async t => {
  const f = await fixture(t, "observe");
  f.deps.sdk = { getSessionInfo: async () => undefined, renameSession: async () => assert.fail("observe-only startup cannot rename") };
  await handleClaudeHook({ ...f.input, hook_event_name: "SessionStart", source: "startup", session_title: "Features" }, f.deps);
  const binding = (await f.store.listBindings())[0];
  assert.equal((await f.store.read(binding.session))?.canonicalTitle, "Features");
});
