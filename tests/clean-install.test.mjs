import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportBundle, repoRoot } from "./helpers/bundle-export.mjs";
import { testTmpRoot } from "./helpers/tmp-root.mjs";
import { runCleanInstall } from "../scripts/test-clean-install.mjs";
import { OPENCODE_SETTINGS, CLAUDE_SETTINGS } from "./helpers/install-home.mjs";

const reasons = result => result.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail ?? ""}`);

async function run(t, options = {}) {
  const exportRoot = await exportBundle(t);
  return runCleanInstall({ exportRoot, tmpRoot: testTmpRoot(), ...options });
}

test("export_installs_without_developer_environment", async t => {
  const result = await run(t);
  assert.deepEqual(reasons(result), []);
  for (const name of ["export has no git metadata or dependency symlinks", "dependencies install from the lockfile", "plan writes nothing", "install", "repeat install changes nothing",
    "bundled imports and assets resolve from the install", "doctor", "uninstall"]) assert.ok(result.checks.some(c => c.name === name && c.ok), name);
  const source = repoRoot;
  assert.ok(!JSON.stringify(result).includes(source), "result never leaks the source checkout path");
  assert.ok(result.modifiedPaths.length > 0 && result.modifiedPaths.every(p => p.startsWith(result.fixtureHome)), "writes stay in the fixture home");
});

test("no_github_auth_does_not_block_ui", async t => {
  const result = await run(t); // the hermetic PATH has no gh, and no token variables are inherited
  assert.deepEqual(reasons(result), []);
  assert.ok(result.warnings.some(w => w.includes("gh")));
});

test("installed_helper_reads_metadata_without_plan_storage", async t => {
  const result = await run(t);
  assert.ok(result.checks.some(c => c.name === "installed helper reads metadata without Plan storage" && c.ok), JSON.stringify(reasons(result)));
});

test("dependency_install_has_no_live_side_effects", async t => {
  const result = await run(t);
  const npm = result.commands.filter(c => c.command === "npm" && c.args[0] === "ci");
  assert.ok(npm.length >= 2);
  for (const c of npm) {
    assert.ok(c.args.includes("--ignore-scripts") || c.args[0] === "ci" && result.npmIgnoresScripts, JSON.stringify(c));
    assert.ok(c.cwd.startsWith(result.fixtureHome) || c.cwd.startsWith(result.exportRoot), c.cwd);
    assert.equal(c.env.HOME, result.fixtureHome);
  }
  assert.equal(result.liveHomeTouched, false);
  assert.ok(result.checks.some(c => c.name === "no references to the source checkout" && c.ok));
});

test("uninstall_retains_unrelated_settings", async t => {
  const result = await run(t, { opencode: OPENCODE_SETTINGS, claude: CLAUDE_SETTINGS });
  assert.deepEqual(reasons(result), []);
  assert.ok(result.checks.some(c => c.name === "uninstall keeps settings and review data" && c.ok));
});

test("a broken export is detected", async t => {
  const exportRoot = await exportBundle(t, { omit: ["integrations/session-metadata/src/scope.mjs"] });
  const result = await runCleanInstall({ exportRoot, tmpRoot: testTmpRoot() });
  assert.ok(reasons(result).length > 0);
  void mkdir; void mkdtemp; void readFile; void writeFile; void join;
});
