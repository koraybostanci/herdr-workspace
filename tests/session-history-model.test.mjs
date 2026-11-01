import test from "node:test";
import assert from "node:assert/strict";
import { historyGroups, historyProgram, acceptHistoryPage } from "../mods/space-agents/history-model.js";
import { createHistoryView } from "../integrations/session-metadata/src/history-view.mjs";
import { historySpace as space, historyEntry as entry, historyRegistry as registry } from "./helpers/session-history-fixtures.mjs";

const request = extra => ({ space, view: "recent", query: "", offset: 0, limit: 50, requestId: "request1", ...extra });
test("recent view uses native last-updated order with deterministic identity ties", () => {
  const groups = historyGroups([entry("ses_b"), entry("ses_c", { updatedAt: 2000 }), entry("ses_a")], { mode: "invalid", now: 10000 });
  assert.deepEqual(groups.flatMap(g => g.rows.map(r => r.session.id)), ["ses_c", "ses_a", "ses_b"]);
});
test("date headings use local calendar days rather than elapsed 24-hour intervals", () => {
  const now = new Date(2026, 10, 1, 12).getTime();
  const groups = historyGroups([entry("ses_today", { updatedAt: new Date(2026, 10, 1, 1).getTime() }),
    entry("ses_yesterday", { updatedAt: new Date(2026, 9, 31, 23).getTime() }), entry("ses_old")], { mode: "recent", now });
  assert.deepEqual(groups.map(g => g.label), ["Today", "Yesterday", "Older"]);
});
test("folder groups retain full directory and host identity and order by latest member", () => {
  const groups = historyGroups([entry("ses_a", { directory: "/one/api" }), entry("ses_b", { directory: "/two/api", updatedAt: 3000 }),
    entry("ses_c", { session: { host: "remote", authority: "local", harness: "opencode-v2", id: "ses_c" }, directory: "/one/api", updatedAt: 2000 })], { mode: "folder" });
  assert.deepEqual(groups.map(g => g.rows[0].session.id), ["ses_b", "ses_c", "ses_a"]);
  assert.equal(new Set(groups.map(g => g.key)).size, 3);
  assert.deepEqual(historyGroups([entry("ses_a", { directory: "/z" }), entry("ses_z", { directory: "/a" })], { mode: "folder" }).map(g => g.label), ["/a", "/z"]);
});
test("harness view keeps matching icons and path search applies within the selected Space", () => {
  const claude = { host: "local", authority: "claude", harness: "claude", id: "claude_saved" };
  const rows = [entry(), entry("claude_saved", { session: claude, directory: "/repo" })];
  assert.deepEqual(historyGroups(rows, { mode: "harness" }).map(g => g.label), ["Claude Code", "OpenCode"]);
  assert.equal(historyProgram(claude, []).icon, "icons/claude.svg");
  const custom = { key: "opencode", name: "OpenCode", icon: "custom/full-color.png", tint: false };
  assert.deepEqual(historyProgram(rows[0].session, [custom]), custom);
  const page = createHistoryView(registry([...rows, entry("elsewhere", { directory: "/other" })]), request({ query: "REPO" }));
  assert.equal(page.total, 2); assert.equal(page.history.length, 2);
});
test("large catalogs return bounded pages without lying about the scoped count", () => {
  const input = registry(Array.from({ length: 10000 }, (_, i) => entry(`ses_${i}`, { title: "🦀".repeat(2000), updatedAt: i })));
  const page = createHistoryView(input, request());
  assert.equal(page.total, 10000); assert.equal(page.history.length, 50); assert.equal(page.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
  assert.equal([...page.history[0].title].length, 512);
  const next = createHistoryView(input, request({ offset: page.nextOffset }));
  assert.ok(!page.history.some(a => next.history.some(b => a.key === b.key)));
});
test("late and foreign history responses never replace another Space or query", () => {
  const wanted = request(), response = createHistoryView(registry([entry()]), wanted);
  assert.equal(acceptHistoryPage(response, wanted), true);
  for (const changed of [request({ space: { ...space, id: "two" } }), request({ query: "different" }), request({ requestId: "new" })]) {
    assert.equal(acceptHistoryPage(response, changed), false);
  }
  assert.equal(acceptHistoryPage({ ...response, owner: "foreign" }, wanted), false);
});
