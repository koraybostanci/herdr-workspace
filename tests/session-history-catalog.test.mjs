import test from "node:test";
import assert from "node:assert/strict";
import { stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverClaudeSessions, discoverOpenCodeSessions, refreshSessionCatalog, lookupNativeSession } from "../integrations/session-metadata/src/history-catalog.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";

const source = harness => ({ id: JSON.stringify(["local", harness === "claude" ? "claude" : "local", harness]), host: "local", authority: harness === "claude" ? "claude" : "local", harness });
const info = (id, extra = {}) => ({ id, title: "Saved conversation", location: { directory: "/repo" }, time: { created: 10, updated: 20 }, ...extra });
const claude = (id, extra = {}) => ({ sessionId: id, summary: "Saved Claude conversation", lastModified: 20, cwd: "/repo", ...extra });

test("Claude discovery requests all root metadata without reading messages or retaining raw prompts", async () => {
  const page = await discoverClaudeSessions({ source: source("claude"), limit: 2, offset: 0, sdk: {
    listSessions: async options => {
      assert.deepEqual(options, { limit: 2, offset: 0, includeProgrammatic: true });
      return [claude("one", { customTitle: "My title", firstPrompt: "private prompt" }), claude("two")];
    }, getSessionMessages: () => assert.fail("transcripts must not be requested") } });
  assert.equal(page.next, 2); assert.equal(page.complete, false);
  assert.equal(page.entries[0].title, "My title");
  assert.equal(page.entries[0].updatedAt, 20);
  assert.ok(!JSON.stringify(page).includes("private prompt"));
});

test("OpenCode discovery preserves identity and archive metadata is not an inactivity signal", async () => {
  const page = await discoverOpenCodeSessions({ source: source("opencode-v2"), limit: 100, run: async (_host, command, args) => {
    assert.equal(command, "opencode");
    if (args[0] === "service") return { code: 0, stdout: "http://127.0.0.1:4096\n", stderr: "" };
    assert.deepEqual(args, ["api", "get", "/api/session", "--param", "parentID=null", "--param", "limit=100"]);
    return { code: 0, stdout: JSON.stringify({ data: [info("ses_one", { time: { updated: 25, archived: 30 } }), info("ses_child", { parentID: "ses_one" })], cursor: { next: null } }), stderr: "" };
  } });
  assert.deepEqual(page.entries.map(e => e.session.id), ["ses_one"]);
  assert.equal(page.entries[0].updatedAt, 25); assert.equal(page.entries[0].saved, "available");
  assert.equal(page.complete, true);
});

test("a stopped OpenCode service never triggers an API request or server start", async () => {
  const page = await discoverOpenCodeSessions({ source: source("opencode-v2"), run: async (_host, _command, args) => {
    assert.deepEqual(args, ["service", "status"]);
    return { code: 1, stdout: "", stderr: "not running" };
  } });
  assert.equal(page.source.state, "unavailable"); assert.equal(page.complete, false);
});

test("OpenCode typed not-found is distinguished from transport failure", async () => {
  const result = await lookupNativeSession({ run: async (_host, _command, args) => args[0] === "service"
    ? { code: 0, stdout: "http://127.0.0.1:4096" }
    : { code: 1, stdout: '{"_tag":"SessionNotFoundError","sessionID":"ses_fixture_missing"}', stderr: "HTTP 404 Not Found" } }, source("opencode-v2"), "ses_fixture_missing");
  assert.equal(result.state, "missing");
});

test("catalog traverses pages, caches discovery, and keeps native timestamps", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  let calls = 0, now = 1000;
  const runtime = { ...f, env: {}, peers: [], historySources: [source("claude")], clock: () => now,
    sdk: { listSessions: async ({ offset }) => { calls++; return offset ? [] : Array.from({ length: 100 }, (_, i) => claude(`session_${i}`)); } },
    run: () => assert.fail("no terminal or OpenCode calls for an empty binding inventory") };
  const first = await refreshSessionCatalog(runtime);
  assert.equal(first.sessions.length, 100); assert.equal(calls, 2);
  now = 2000;
  const second = await refreshSessionCatalog(runtime);
  assert.equal(calls, 2); assert.equal(second.sessions[0].updatedAt, 20);
  assert.equal((await stat(join(f.root, "history/registry.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "history"))).mode & 0o777, 0o700);
});

test("partial inventories and failed exact lookups retain cached saved sessions", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  let failed = false;
  const runtime = { ...f, env: {}, peers: [], historySources: [source("claude")], clock: () => failed ? 100000 : 1000,
    sdk: { listSessions: async () => { if (failed) throw Error("credentials hidden"); return [claude("one")]; }, getSessionInfo: async () => { throw Error("offline"); } },
    run: () => assert.fail("no processes needed") };
  await refreshSessionCatalog(runtime); failed = true;
  const next = await refreshSessionCatalog(runtime);
  assert.equal(next.sessions.length, 1); assert.equal(next.sources[0].complete, false);
  assert.ok(!JSON.stringify(next).includes("credentials hidden"));
  runtime.sdk.listSessions = async () => [];
  assert.equal((await refreshSessionCatalog(runtime, { force: true })).sessions.length, 1);
  runtime.sdk.getSessionInfo = async () => undefined;
  assert.equal((await refreshSessionCatalog(runtime, { force: true })).sessions.length, 0);
});

test("repeated OpenCode cursors stop discovery without claiming completeness", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  let calls = 0;
  const result = await refreshSessionCatalog({ ...f, env: {}, peers: [], historySources: [source("opencode-v2")], clock: () => 1000,
    run: async (_host, _command, args) => args[0] === "service" ? { code: 0, stdout: "http://127.0.0.1:4096" }
      : (++calls, { code: 0, stdout: JSON.stringify({ data: [info("ses_one")], cursor: { next: "again" } }) }) });
  assert.equal(calls, 2); assert.equal(result.sessions.length, 1);
  assert.equal(result.sources[0].complete, false);
});

test("owned history storage rejects foreign schemas instead of replacing them", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.listBindings(); await mkdir(join(f.root, "history"));
  await writeFile(join(f.root, "history/registry.json"), JSON.stringify({ schema: 1, owner: "foreign" }));
  await assert.rejects(f.store.readHistory(), /history|registry|owner/i);
});

test("foreign history-source configuration is rejected before contacting a server", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  await f.store.listBindings();
  await writeFile(join(f.root, "history-sources.json"), JSON.stringify({ owner: "foreign", sources: [] }));
  await assert.rejects(refreshSessionCatalog({ ...f, env: {}, clock: () => 1000, run: () => assert.fail("foreign source") }), /source|owner/i);
  await writeFile(join(f.root, "history-sources.json"), "invalid json");
  await assert.rejects(refreshSessionCatalog({ ...f, env: {}, clock: () => 1000, run: () => assert.fail("invalid source") }), /source|config/i);
});

test("a failed later page keeps earlier records and reports partial discovery", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const result = await refreshSessionCatalog({ ...f, env: {}, peers: [], historySources: [source("claude")], clock: () => 1000,
    sdk: { listSessions: async ({ offset }) => { if (offset) throw Error("page unavailable"); return Array.from({ length: 100 }, (_, i) => claude(`session_${i}`)); } } });
  assert.equal(result.sessions.length, 100);
  assert.equal(result.sources[0].state, "partial");
});

test("configured peer histories retain verified Space associations and report outages", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const peer = { id: "box", host: "remote", target: "box", transport: "ssh" };
  const remoteSource = { ...source("claude"), host: "remote", id: JSON.stringify(["remote", "claude", "claude"]), state: "ready", complete: true };
  let offline = false;
  const runtime = { ...f, env: {}, historySources: [], peers: [peer], clock: () => offline ? 100000 : 1000,
    run: async (_host, _command, args) => {
      if (offline) return { code: 1, stdout: "", stderr: "offline" };
      if (args.some(arg => arg.includes("presence-snapshot"))) return { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", presence: [] }) };
      return { code: 0, stdout: JSON.stringify({ schema: 1, owner: "herdr-session-metadata", sources: [remoteSource], next: null, entries: [{
        session: { host: "remote", authority: "claude", harness: "claude", id: "remote_session" }, sourceId: remoteSource.id,
        title: "Remote saved session", directory: "/repo", updatedAt: 20, saved: "available", bindings: [],
        associations: [{ host: "remote", coreSession: "default", id: "one", associatedAt: 10 }] }] }) };
    } };
  const first = await refreshSessionCatalog(runtime);
  assert.equal(first.sessions[0].associations[0].id, "box/one");
  offline = true;
  const next = await refreshSessionCatalog(runtime);
  assert.equal(next.sessions.length, 1);
  assert.equal(next.sources.find(s => s.host === "remote").state, "unavailable");
});
