import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { planInstall, applyInstall, activateInstall, rollbackInstall, activationGates } from "../integrations/session-metadata/src/setup.mjs";
import { isolatedFixture } from "./helpers/session-metadata-fixtures.mjs";

async function fixture(t) {
  const f = await isolatedFixture(); t.after(f.cleanup);
  const config = join(f.root, "config"); await mkdir(config);
  const opencodePath = join(config, "cli.json"), claudePath = join(config, "settings.json");
  const opencode = '{\n  // keep this comment\n  "theme": {"name": "mine"},\n  "plugins": ["existing"]\n}\n';
  const claude = '{\n  "permissions": {"allow": ["Read"]},\n  "hooks": {"Stop": [{"hooks": [{"type":"command","command":"keep-me"}]}]}\n}\n';
  await writeFile(opencodePath, opencode); await writeFile(claudePath, claude);
  const options = { home: "/home/example", appHome: "/home/example/.config/herdr-app", node: "/usr/bin/node", opencodePath, claudePath,
    stateRoot: join(f.root, "metadata"), syncWasEnabled: true };
  const plan = planInstall({ opencode, claude }, options);
  return { ...f, options, plan, opencode, claude, opencodePath, claudePath };
}
const capabilities = { opencode: true, claude: true, metadataSdk: true, noPlatformBinaries: true };
test("installation appends only owned entries and preserves unrelated JSONC text", async t => {
  const f = await fixture(t);
  assert.equal(f.plan.edits.length, 2);
  const opencode = f.plan.edits.find(e => e.path === f.opencodePath).afterText;
  assert.ok(opencode.includes('// keep this comment\n  "theme": {"name": "mine"}'));
  assert.ok(!opencode.includes("/Users/example"));
  const manifest = await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  assert.equal(manifest.phase, "observing");
  const installed = JSON.parse(await readFile(f.claudePath, "utf8"));
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "keep-me");
  assert.deepEqual(installed.permissions, { allow: ["Read"] });
  const next = planInstall({ opencode: await readFile(f.opencodePath, "utf8"), claude: await readFile(f.claudePath, "utf8") }, f.options);
  assert.equal(next.edits.length, 0);
});
test("compare-before-write refuses concurrent edits before changing either config", async t => {
  const f = await fixture(t);
  await writeFile(f.claudePath, f.claude + " ");
  await assert.rejects(applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities), /changed|concurrent/i);
  assert.equal(await readFile(f.opencodePath, "utf8"), f.opencode);
});
test("missing capability or native verification gates never disable the old sync", async t => {
  const f = await fixture(t);
  await assert.rejects(applyInstall(f.plan, {}, { ...capabilities, noPlatformBinaries: false }), /gate|capabilit/i);
  const manifest = await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  let disabled = false;
  await assert.rejects(activateInstall(manifest, { ...capabilities, opencodeRename: true, claudeRename: true, claudeLiveTitle: true,
    disableSync: async () => { disabled = true; } }), /gate|verification/i);
  assert.equal(disabled, false);
});
test("rollback removes only unchanged owned entries and keeps later user edits", async t => {
  const f = await fixture(t);
  const manifest = await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  const installed = JSON.parse(await readFile(f.claudePath, "utf8"));
  installed.newUserSetting = "keep";
  installed.hooks.Stop.push({ hooks: [{ type: "command", command: "added-later" }] });
  await writeFile(f.claudePath, JSON.stringify(installed));
  await rollbackInstall(manifest);
  const after = JSON.parse(await readFile(f.claudePath, "utf8"));
  assert.equal(after.newUserSetting, "keep");
  assert.deepEqual(after.hooks.Stop.map(x => x.hooks[0].command), ["keep-me", "added-later"]);
  assert.equal(after.hooks.SessionStart?.length ?? 0, 0);
});

test("activation requires successful sync disable before writing active state", async t => {
  const f = await fixture(t);
  const manifest = await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  const gates = Object.fromEntries(activationGates.map(k => [k, true]));
  await assert.rejects(activateInstall(manifest, { ...gates, disableSync: async () => false }), /disable/);
  assert.equal(JSON.parse(await readFile(join(f.options.stateRoot, "activation.json"), "utf8")).mode, "observe");
  let stopped = false;
  await activateInstall(manifest, { ...gates, disableSync: async () => {
    assert.equal(JSON.parse(await readFile(join(f.options.stateRoot, "activation.json"), "utf8")).mode, "observe"); stopped = true; return true;
  } });
  assert.equal(stopped, true);
  assert.equal(JSON.parse(await readFile(join(f.options.stateRoot, "activation.json"), "utf8")).mode, "active");
});

test("rollback leaves a manually edited owned hook intact", async t => {
  const f = await fixture(t);
  const manifest = await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  const installed = JSON.parse(await readFile(f.claudePath, "utf8"));
  installed.hooks.SessionStart[0].hooks[0].timeout = 20;
  await writeFile(f.claudePath, JSON.stringify(installed));
  await rollbackInstall(manifest);
  assert.equal(JSON.parse(await readFile(f.claudePath, "utf8")).hooks.SessionStart[0].hooks[0].timeout, 20);
});

test("a repeated install retains ownership so its returned manifest can roll back all entries", async t => {
  const f = await fixture(t);
  await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  const again = planInstall({ opencode: await readFile(f.opencodePath, "utf8"), claude: await readFile(f.claudePath, "utf8") }, f.options);
  const manifest = await applyInstall(again, {}, capabilities);
  await rollbackInstall(manifest);
  assert.deepEqual(JSON.parse(await readFile(f.claudePath, "utf8")).hooks.Stop.map(x => x.hooks[0].command), ["keep-me"]);
});

test("rollback removes empty config containers only when this install created them", async t => {
  const f = await fixture(t);
  const manifest = await applyInstall(f.plan, Object.fromEntries(f.plan.edits.map(e => [e.path, e.beforeHash])), capabilities);
  await rollbackInstall(manifest);
  assert.deepEqual(JSON.parse(await readFile(f.claudePath, "utf8")), JSON.parse(f.claude));
});

test("plugin entries with options are recognized without appending a duplicate runtime", async t => {
  const f = await fixture(t);
  const opencode = JSON.stringify({ plugins: [{ package: "/home/example/.config/herdr-app/integrations/session-metadata", options: { metadataVersion: 2, keep: "me" } }] });
  const plan = planInstall({ opencode, claude: f.claude }, f.options);
  assert.equal(plan.edits.find(e => e.path === f.opencodePath), undefined);
});
