import assert from "node:assert/strict";
import test from "node:test";
import { readSessionView, projectSessionCard, readLiveSessionBindings } from "../mods/space-agents/session-metadata.js";
import { bindingKey } from "../integrations/session-metadata/src/contracts.mjs";
import { metadataFixture } from "./helpers/session-metadata-fixtures.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";
import { refreshView, reconcileClaudeTitles } from "../integrations/session-metadata/src/collector.mjs";

function fixture() {
  const f = metadataFixture();
  f.record.bindings = [{ key: bindingKey(f.binding), generation: f.binding.generation }];
  const terminal = { address: f.binding.terminal, state: "live", created_ms: 100, labels: { "herdr.meta-binding": JSON.stringify({ key: bindingKey(f.binding), generation: f.binding.generation }) } };
  return { ...f, terminal, view: { schema: 1, owner: "herdr-session-metadata", updatedAt: Date.now(), entries: [{ binding: f.binding, record: f.record }] } };
}
test("canonical session titles and observed nested repo paths override stale tab and launch labels", () => {
  const f = fixture();
  const record = { ...f.record, canonicalTitle: "PROJ-101 #6104 Features", contexts: { [f.record.activeRepo]: { ...f.context, subdir: "packages/api", cwd: "/parent/repo-a/packages/api" } } };
  const card = projectSessionCard({ title: "Stale tab", directory: "parent", cwd: "/parent" }, record);
  assert.equal(card.title, "PROJ-101 #6104 Features");
  assert.equal(card.directory, "repo-a/packages/api");
  assert.equal(card.sessionPr.url, "https://github.com/team/repo-a/pull/6104");
  assert.equal(f.record.canonicalTitle, "Features");
});
test("only matching live labels, creation identity and generation can supply metadata", () => {
  const f = fixture();
  assert.equal(readSessionView(f.view, [f.terminal]).size, 1);
  for (const extra of [{ created_ms: 101 }, { state: "ended" }, { labels: {} }, { address: "another-terminal" }]) {
    assert.equal(readSessionView(f.view, [{ ...f.terminal, ...extra }]).size, 0);
  }
  assert.equal(readSessionView({ ...f.view, owner: "foreign" }, [f.terminal]).size, 0);
  assert.equal(readSessionView({ ...f.view, entries: [{ binding: {}, record: null }] }, [f.terminal]).size, 0);
  assert.equal(readSessionView({ ...f.view, entries: [null, 42, {}] }, [f.terminal]).size, 0);
});
test("a shell wrapper sharing its foreground process group with an agent keeps its live binding", () => {
  const f = fixture();
  Object.assign(f.terminal, { pid: 10, foreground: { pid: 10, name: "bash", argv: ["/bin/bash", "-c", "opencode; cleanup"] } });
  assert.equal(readLiveSessionBindings(f.view, [f.terminal]).size, 1);
});
test("closed PRs do not reappear as active badges from historical canonical titles", () => {
  const f = fixture(), url = f.context.activePrUrl;
  const record = { ...f.record, canonicalTitle: "PROJ-101 #6104 Features", contexts: { [f.record.activeRepo]: { ...f.context, activePrUrl: null, prs: { [url]: { ...f.context.prs[url], state: "MERGED" } } } } };
  const card = projectSessionCard({ title: "Old", directory: "parent" }, record);
  assert.equal(card.sessionPr, null);
  assert.equal(card.title, "PROJ-101 #6104 Features");
});
test("manual titles remain canonical and subdirectory traversal is never displayed", () => {
  const f = fixture();
  const record = { ...f.record, manualOverride: true, canonicalTitle: "My name", contexts: { [f.record.activeRepo]: { ...f.context, subdir: "../other" } } };
  const card = projectSessionCard({ directory: "parent" }, record);
  assert.equal(card.title, "My name");
  assert.equal(card.directory, "repo-a");
});

test("bound sessions without repository context keep the terminal-folder fallback", () => {
  const f = fixture();
  const card = projectSessionCard({ title: "Reported session", directory: "github", cwd: "/parent/github" },
    { ...f.record, canonicalTitle: "Canonical session", activeRepo: null, contexts: {} });
  assert.equal(card.title, "Canonical session");
  assert.equal(card.directory, "github");
  assert.equal(card.cwd, "/parent/github");
  assert.equal(card.sessionPr, null);
});

test("PR-only context falls back to the terminal folder when its PR closes", () => {
  const f = fixture(), url = f.context.activePrUrl;
  for (const [state, directory] of [["OPEN", "repo-a"], ["CLOSED", "github"]]) {
    const context = { ...f.context, repo: null, gitRoot: null, cwd: null, prs: { [url]: { ...f.context.prs[url], state } } };
    const card = projectSessionCard({ directory: "github" }, { ...f.record, contexts: { [f.record.activeRepo]: context } });
    assert.equal(card.directory, directory);
    assert.equal(card.sessionPr?.number ?? null, state === "OPEN" ? 6104 : null);
  }
});

test("collector drops offline peers without retaining an old active badge", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const view = await refreshView({ ...f, clock: () => 1000, run: async (_h, command) => {
    assert.equal(command, "ssh"); return { code: 1, stdout: "", stderr: "offline" };
  } }, [{ id: "devbox", host: "devbox", transport: "ssh", target: "devbox" }]);
  assert.equal(view.entries.length, 0);
  assert.equal(view.errors.length, 1);
});

test("a /rename in Claude (which fires no hook) reaches the stored title on the next refresh", async t => {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const key = { ...f.key, harness: "claude", authority: "claude", id: "11111111-1111-4111-8111-111111111111" };
  const binding = { ...f.binding, session: key, lookupDir: "/parent" };
  assert.equal(await f.store.bind(binding, null), true);
  const record = { ...f.record, session: key, canonicalTitle: "first prompt text", bindings: [{ key: bindingKey(binding), generation: binding.generation }] };
  assert.equal(await f.store.write(record, null), true);
  const sdk = { getSessionInfo: async (id, options) => { assert.equal(options.dir, "/parent"); return { sessionId: id, customTitle: "here is a question", summary: "x" }; } };
  await reconcileClaudeTitles({ ...f, sdk });
  const updated = await f.store.read(key);
  assert.equal(updated.canonicalTitle, "here is a question");
  assert.equal(updated.revision, 1);
  await reconcileClaudeTitles({ ...f, sdk });
  assert.equal((await f.store.read(key)).revision, 1);
});
