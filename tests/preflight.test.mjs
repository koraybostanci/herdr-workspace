import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { loadBundle } from "../src/bundle.mjs";
import { preflight } from "../src/preflight.mjs";
import { repoRoot } from "./helpers/bundle-export.mjs";
import { hostFixture, fakeRun } from "./helpers/host-fixture.mjs";

const good = { node: { path: "/usr/local/bin/node", version: "v26.13.0" }, git: { code: 0, stdout: "git version 2.50" }, gh: { code: 0, stdout: "gh version 2.103" },
  "herdr-app": { code: 0, stdout: "herdr-app 0.1.9\n" } };

test("compatible host passes", async t => {
  const bundle = await loadBundle(repoRoot);
  const appHome = await hostFixture(t, bundle);
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good) });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("missing_required_host_fails_preflight", async t => {
  const bundle = await loadBundle(repoRoot);
  const appHome = await hostFixture(t, bundle, { omitMods: ["menu"], omitAssets: [bundle.host.assets[0]] });
  const before = await readdir(appHome, { recursive: true });
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.rule === "missing-host-mod" && e.name === "menu"));
  assert.ok(result.errors.some(e => e.rule === "missing-host-asset"));
  assert.deepEqual(await readdir(appHome, { recursive: true }), before, "preflight must not write");
});

test("old node fails but metadata no longer requires SQLite", async t => {
  const bundle = await loadBundle(repoRoot);
  const appHome = await hostFixture(t, bundle);
  const old = await preflight({ bundle, appHome, node: { path: "/n", version: "v22.1.0" }, run: fakeRun(good) });
  assert.ok(old.errors.some(e => e.rule === "node-version"));
  const noSqlite = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, node: { code: 1, stderr: "no sqlite" } }) });
  assert.deepEqual(noSqlite.errors, []);
});

test("missing_optional_gh_warns_only", async t => {
  const bundle = await loadBundle(repoRoot);
  const appHome = await hostFixture(t, bundle);
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, gh: null, git: null }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(w => w.rule === "optional-tool" && w.tool === "gh" && /pull request/i.test(w.message)));
  assert.ok(result.warnings.some(w => w.tool === "git"));
});

test("no_github_auth_does_not_block_ui", async t => {
  const bundle = await loadBundle(repoRoot);
  const appHome = await hostFixture(t, bundle);
  const run = fakeRun({ ...good, gh: { "auth status": { code: 1, stderr: "not logged in" }, code: 0, stdout: "gh version 2.103" } });
  const result = await preflight({ bundle, appHome, node: good.node, run });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.tool === "gh"));
  assert.ok(!run.calls.some(c => c.includes("login") || c.includes("token")), "preflight must never authenticate");
});

test("other host version warns as unverified", async t => {
  const bundle = await loadBundle(repoRoot);
  const appHome = await hostFixture(t, bundle);
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, "herdr-app": { code: 0, stdout: "herdr-app 0.2.0\n" } }) });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.rule === "host-version"));
});
