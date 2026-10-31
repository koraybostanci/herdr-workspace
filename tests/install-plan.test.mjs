import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { installHome, NODE, OPENCODE_SETTINGS, CLAUDE_SETTINGS } from "./helpers/install-home.mjs";
import { planInstall } from "../src/install-plan.mjs";
import { applyInstall } from "../src/install-journal.mjs";
import { runCli } from "../src/cli.mjs";

const planOf = (h, extra = {}) => planInstall({ bundle: h.bundle, sourceRoot: h.sourceRoot, appHome: h.appHome, stateRoot: h.stateRoot, node: NODE,
  harnesses: { opencodePath: h.opencodePath, claudePath: h.claudePath }, configureHarnesses: [], ...extra });

test("default_plan_has_no_writes", async t => {
  const h = await installHome(t);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  const before = [await h.list(h.home), await h.read(h.claudePath)];
  const plan = await planOf(h, { configureHarnesses: ["claude"] });
  assert.equal(plan.schema, 1);
  assert.equal(plan.owner, "herdr-workspace");
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.files.length > 50);
  assert.deepEqual([await h.list(h.home), await h.read(h.claudePath)], before);
  const out = [], err = [];
  const code = await runCli(["plan", "--app-home", h.appHome, "--state-root", h.stateRoot], { run: h.run, node: NODE, env: { HOME: h.home }, stdout: s => out.push(s), stderr: s => err.push(s), sourceRoot: h.sourceRoot });
  assert.equal(code, 0, err.join(""));
  assert.deepEqual(await h.list(h.home), before[0]);
  const bare = await runCli(["--app-home", h.appHome, "--state-root", h.stateRoot], { run: h.run, node: NODE, env: { HOME: h.home }, stdout: () => {}, stderr: () => {}, sourceRoot: h.sourceRoot });
  assert.equal(bare, 0, "no command means plan");
  assert.deepEqual(await h.list(h.home), before[0]);
  assert.ok(out.join("").includes("layout.switch"), "prints the native layout-selection command");
});

test("generated paths come from the destination, never the source machine", async t => {
  const h = await installHome(t);
  const plan = await planOf(h);
  for (const f of plan.files) assert.ok(f.dest.startsWith(h.appHome + "/"), f.dest);
  assert.match(plan.roots.releaseDir, /\/integrations\/session-metadata\/releases\/[a-f0-9-]{36}$/);
  const descriptor = plan.files.find(f => f.dest.endsWith("data/session-plans/runtime.json"));
  const value = JSON.parse(descriptor.text);
  assert.deepEqual(Object.keys(value).sort(), ["buildHash", "helperPath", "node", "owner", "schema", "stateRoot"]);
  assert.equal(value.owner, "herdr-session-metadata");
  assert.equal(value.node, NODE);
  assert.equal(value.helperPath, join(plan.roots.releaseDir, "bin/herdr-plan.mjs"));
  assert.equal(value.stateRoot, h.stateRoot);
  assert.ok(!JSON.stringify(plan).includes(h.sourceRoot), "no source-machine path in the plan");
});

test("harness_setup_requires_opt_in", async t => {
  const h = await installHome(t);
  await h.write(h.opencodePath, OPENCODE_SETTINGS);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  assert.deepEqual((await planOf(h)).configEdits, []);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  assert.equal(receipt.phase, "installed");
  assert.equal(await h.read(h.opencodePath), OPENCODE_SETTINGS);
  assert.equal(await h.read(h.claudePath), CLAUDE_SETTINGS);
  const opted = await planOf(h, { configureHarnesses: ["opencode"] });
  assert.deepEqual([...new Set(opted.configEdits.map(e => e.path))], [h.opencodePath], "only the requested harness");
});

test("foreign_collision_has_no_writes", async t => {
  for (const [path, text, rule] of [
    ["mods/plan/main.js", "// someone else's plan mod\n", "foreign-file"],
    ["layouts/herdr-workspace.json", "{\"id\":\"root\",\"mine\":true}\n", "foreign-file"],
    ["data/session-plans/runtime.json", "{\"owner\":\"other\"}\n", "foreign-file"],
  ]) {
    const h = await installHome(t);
    await h.write(join(h.appHome, path), text);
    const before = await h.list(h.home);
    const plan = await planOf(h);
    assert.ok(plan.blockers.some(b => b.rule === rule && b.path.endsWith(path)), JSON.stringify(plan.blockers));
    await assert.rejects(applyInstall(plan, { run: h.run }), /install-blocked/);
    assert.deepEqual(await h.list(h.home), before, "refused before any write");
    assert.equal(await h.read(join(h.appHome, path)), text);
    assert.equal(h.run.calls.filter(c => c.command === "npm" && c.args[0] === "ci").length, 0);
  }
});

test("foreign collision can be adopted only with explicit opt-in, keeping a backup", async t => {
  const h = await installHome(t);
  const mine = join(h.appHome, "mods/plan/main.js");
  await h.write(mine, "// development copy\n");
  assert.ok((await planOf(h)).blockers.length);
  const plan = await planOf(h, { adopt: true });
  assert.deepEqual(plan.blockers, []);
  const receipt = await applyInstall(plan, { run: h.run });
  assert.equal(receipt.phase, "installed");
  assert.notEqual(await h.read(mine), "// development copy\n");
  const step = receipt.steps.find(s => s.dest === mine);
  assert.equal(await h.read(step.backup.path), "// development copy\n");
});

test("invalid harness settings block before any write", async t => {
  const h = await installHome(t);
  await h.write(h.claudePath, "{ not json");
  const plan = await planOf(h, { configureHarnesses: ["claude"] });
  assert.ok(plan.blockers.some(b => b.rule === "invalid-config"));
  await assert.rejects(applyInstall(plan, { run: h.run }), /install-blocked/);
  assert.equal(await h.read(h.claudePath), "{ not json");
});
