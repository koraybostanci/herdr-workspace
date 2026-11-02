import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { installHome, NODE, OPENCODE_SETTINGS, CLAUDE_SETTINGS } from "./helpers/install-home.mjs";
import { planInstall } from "../src/install-plan.mjs";
import { applyInstall, uninstall } from "../src/install-journal.mjs";
import { parseDoc } from "../src/install-common.mjs";
import { runCli } from "../src/cli.mjs";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "CwdChanged", "Stop", "SessionEnd"];
const planOf = (h, extra = {}) => planInstall({ bundle: h.bundle, sourceRoot: h.sourceRoot, appHome: h.appHome, stateRoot: h.stateRoot, node: NODE,
  harnesses: { opencodePath: h.opencodePath, claudePath: h.claudePath }, configureHarnesses: ["opencode", "claude"], ...extra });

async function unmanaged(t, { current = false } = {}) {
  const h = await installHome(t);
  const initial = await planOf(h);
  const release = current ? initial.roots.releaseDir : join(h.appHome, "integrations/session-metadata/releases/00000000-0000-0000-0000-000000000001");
  const plugin = { package: release, options: { appHome: h.appHome, stateRoot: h.stateRoot, ...(current ? {} : { metadataVersion: 2 }) } };
  const hook = { hooks: [{ type: "command", command: NODE, args: [join(release, "bin/herdr-session-meta.mjs"), "hook", "claude"], timeout: 10, onFailure: "continue" }] };
  const opencode = parseDoc(OPENCODE_SETTINGS);
  opencode.plugins.push(plugin);
  const claude = parseDoc(CLAUDE_SETTINGS);
  for (const event of EVENTS) (claude.hooks[event] ??= []).push(structuredClone(hook));
  const originals = {
    opencode: "// keep the existing providers and plugin\n" + JSON.stringify(opencode, null, 2) + "\n",
    claude: "// keep unrelated hooks and settings\n" + JSON.stringify(claude, null, 2) + "\n",
  };
  await h.write(h.opencodePath, originals.opencode);
  await h.write(h.claudePath, originals.claude);
  return { ...h, plugin, hook, originals };
}

async function assertIntegrations(h, plan, node = NODE) {
  const opencode = parseDoc(await h.read(h.opencodePath));
  assert.deepEqual(opencode.plugins, ["other-plugin", { package: plan.roots.releaseDir, options: { appHome: h.appHome, stateRoot: h.stateRoot } }]);
  assert.deepEqual(opencode.provider, parseDoc(OPENCODE_SETTINGS).provider);
  assert.equal(opencode.model, "example/model-x");
  const claude = parseDoc(await h.read(h.claudePath));
  assert.equal(claude.apiKeyHelper, "/usr/local/bin/example-key-helper");
  assert.deepEqual(claude.env, { KEEP_ME: "1" });
  for (const event of EVENTS) {
    const expected = { hooks: [{ type: "command", command: node, args: [join(plan.roots.releaseDir, "bin/herdr-session-meta.mjs"), "hook", "claude"], timeout: 10, onFailure: "continue" }] };
    assert.deepEqual(claude.hooks[event], event === "Stop" ? [...parseDoc(CLAUDE_SETTINGS).hooks.Stop, expected] : [expected]);
  }
}

test("unmanaged integrations require explicit adoption instead of adding duplicates", async t => {
  const h = await unmanaged(t), before = await h.list(h.home);
  const plan = await planOf(h);
  assert.deepEqual([...new Set(plan.blockers.filter(b => b.rule === "harness-adoption-required").map(b => b.harness))].sort(), ["claude", "opencode"]);
  await assert.rejects(applyInstall(plan, { run: h.run }), /install-blocked/);
  assert.deepEqual(await h.list(h.home), before);
  assert.equal(await h.read(h.opencodePath), h.originals.opencode);
  assert.equal(await h.read(h.claudePath), h.originals.claude);
});

test("explicit adoption replaces existing integrations and journals their original values", async t => {
  const h = await unmanaged(t), plan = await planOf(h, { adopt: true });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.configEdits.filter(edit => edit.status === "adopt").length, 7);
  const receipt = await applyInstall(plan, { run: h.run });
  await assertIntegrations(h, plan);
  assert.equal(receipt.steps.filter(step => step.kind === "config").length, 7);
  for (const step of receipt.steps.filter(step => step.kind === "config")) assert.deepEqual(step.previous, step.harness === "opencode" ? h.plugin : h.hook);
  assert.equal(await h.read(receipt.configFiles[h.opencodePath].backup), h.originals.opencode);
  assert.equal(await h.read(receipt.configFiles[h.claudePath].backup), h.originals.claude);
  assert.ok((await h.read(h.opencodePath)).startsWith("// keep the existing providers and plugin"));
  assert.ok((await h.read(h.claudePath)).startsWith("// keep unrelated hooks and settings"));
});

test("adopted integrations stay singular on repeat installation and subsequent upgrades", async t => {
  const h = await unmanaged(t), first = await planOf(h, { adopt: true });
  await applyInstall(first, { run: h.run });
  const repeat = await planOf(h);
  assert.deepEqual(repeat.blockers, []);
  assert.ok(repeat.configEdits.every(edit => edit.status === "present"));
  const upgrade = await planOf(h, { node: "/opt/example/node" });
  assert.deepEqual(upgrade.blockers, []);
  await applyInstall(upgrade, { run: h.run });
  await assertIntegrations(h, upgrade, "/opt/example/node");
});

test("adoption records already-identical unmanaged entries for future upgrades", async t => {
  const h = await unmanaged(t, { current: true }), plan = await planOf(h, { adopt: true });
  const receipt = await applyInstall(plan, { run: h.run });
  assert.equal(receipt.steps.filter(step => step.kind === "config").length, 7);
  const upgrade = await planOf(h, { node: "/opt/example/node" });
  assert.deepEqual(upgrade.blockers, []);
  await applyInstall(upgrade, { run: h.run });
  await assertIntegrations(h, upgrade, "/opt/example/node");
});

test("uninstall restores the exact pre-adoption harness files", async t => {
  const h = await unmanaged(t);
  const receipt = await applyInstall(await planOf(h, { adopt: true }), { run: h.run });
  await uninstall(receipt);
  assert.equal(await h.read(h.opencodePath), h.originals.opencode);
  assert.equal(await h.read(h.claudePath), h.originals.claude);
});

test("adoption remains limited to explicitly selected harness files", async t => {
  const h = await unmanaged(t);
  await h.write(h.claudePath, "unselected invalid settings");
  const plan = await planOf(h, { adopt: true, configureHarnesses: ["opencode"] });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.configEdits.length, 1);
  await applyInstall(plan, { run: h.run });
  assert.equal(parseDoc(await h.read(h.opencodePath)).plugins.length, 2);
  assert.equal(await h.read(h.claudePath), "unselected invalid settings");
});

test("adopting files without harness opt-in does not inspect malformed harness settings", async t => {
  const h = await unmanaged(t);
  await h.write(h.opencodePath, "invalid unselected OpenCode settings");
  await h.write(h.claudePath, "invalid unselected Claude settings");
  const plan = await planOf(h, { adopt: true, configureHarnesses: [] });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.configEdits, []);
});

test("ambiguous and customized unmanaged entries are refused without writes", async t => {
  const cases = [
    ["duplicate plugins", "opencode", doc => doc.plugins.push(structuredClone(doc.plugins[1]))],
    ["custom plugin options", "opencode", doc => { doc.plugins[1].options.server = "https://example.test"; }],
    ["different state root", "opencode", doc => { doc.plugins[1].options.stateRoot += "-other"; }],
    ["unversioned plugin", "opencode", doc => { doc.plugins[1].package = doc.plugins[1].package.split("/releases/")[0]; }],
    ["traversing release path", "opencode", doc => { doc.plugins[1].package += "/../elsewhere"; }],
    ["duplicate hooks", "claude", doc => doc.hooks.SessionStart.push(structuredClone(doc.hooks.SessionStart[0]))],
    ["mixed hook group", "claude", doc => doc.hooks.SessionStart[0].hooks.push({ type: "command", command: "keep-this" })],
    ["custom hook timeout", "claude", doc => { doc.hooks.SessionStart[0].hooks[0].timeout = 20; }],
    ["custom hook matcher", "claude", doc => { doc.hooks.SessionStart[0].matcher = "Bash"; }],
    ["extra hook arguments", "claude", doc => doc.hooks.SessionStart[0].hooks[0].args.push("--custom")],
    ["unexpected hook event", "claude", doc => { doc.hooks.PreToolUse = [structuredClone(doc.hooks.SessionStart[0])]; }],
  ];
  for (const [name, harness, change] of cases) await t.test(name, async t => {
    const h = await unmanaged(t), path = harness === "opencode" ? h.opencodePath : h.claudePath;
    const doc = parseDoc(await h.read(path)); change(doc);
    const text = JSON.stringify(doc); await h.write(path, text);
    const before = await h.list(h.home);
    const plan = await planOf(h, { adopt: true, configureHarnesses: [harness] });
    assert.ok(plan.blockers.some(b => b.rule === "ambiguous-harness-entry" && b.harness === harness), JSON.stringify(plan.blockers));
    await assert.rejects(applyInstall(plan, { run: h.run }), /install-blocked/);
    assert.equal(await h.read(path), text);
    assert.deepEqual(await h.list(h.home), before);
  });
});

test("a metadata entry changed after planning is not duplicated or overwritten", async t => {
  const h = await unmanaged(t), plan = await planOf(h, { adopt: true });
  const doc = parseDoc(await h.read(h.opencodePath));
  doc.plugins[1].options.custom = true;
  const later = JSON.stringify(doc); await h.write(h.opencodePath, later);
  await assert.rejects(applyInstall(plan, { run: h.run }), /config-changed-concurrently/);
  assert.equal(await h.read(h.opencodePath), later);
});

test("an integration array removed after planning is not silently recreated", async t => {
  const h = await unmanaged(t), plan = await planOf(h, { adopt: true });
  const doc = parseDoc(await h.read(h.opencodePath)); delete doc.plugins;
  const later = JSON.stringify(doc); await h.write(h.opencodePath, later);
  await assert.rejects(applyInstall(plan, { run: h.run }), /config-changed-concurrently/);
  assert.equal(await h.read(h.opencodePath), later);
});

test("CLI explains required adoption and previews replacement without writes", async t => {
  const h = await unmanaged(t), before = await h.list(h.home), out = [], err = [];
  const argv = ["plan", "--app-home", h.appHome, "--state-root", h.stateRoot, "--opencode-path", h.opencodePath, "--claude-path", h.claudePath, "--configure-harnesses", "opencode,claude"];
  const options = { run: h.run, node: NODE, platform: "darwin", env: { HOME: h.home }, stdout: s => out.push(s), stderr: s => err.push(s), sourceRoot: h.sourceRoot };
  assert.equal(await runCli(argv, options), 1);
  assert.match(err.join(""), /--adopt/);
  out.length = 0; err.length = 0;
  assert.equal(await runCli([...argv, "--adopt"], options), 0, err.join(""));
  assert.equal((out.join("").match(/config adopt:/g) ?? []).length, 7);
  assert.deepEqual(await h.list(h.home), before);
  assert.equal(await h.read(h.opencodePath), h.originals.opencode);
  assert.equal(await h.read(h.claudePath), h.originals.claude);
});

test("documented CLI migration installs, verifies and repeats without duplicate integrations", async t => {
  const h = await unmanaged(t), out = [], err = [];
  const paths = ["--app-home", h.appHome, "--state-root", h.stateRoot, "--opencode-path", h.opencodePath, "--claude-path", h.claudePath];
  const options = { run: h.run, node: NODE, platform: "darwin", env: { HOME: h.home }, stdout: s => out.push(s), stderr: s => err.push(s), sourceRoot: h.sourceRoot };
  assert.equal(await runCli(["install", ...paths, "--adopt", "--configure-harnesses", "opencode,claude"], options), 0, err.join(""));
  const plan = await planOf(h);
  await assertIntegrations(h, plan);
  assert.equal(await runCli(["doctor", ...paths], options), 0, out.join(""));
  const before = await h.list(h.home);
  assert.equal(await runCli(["install", ...paths, "--configure-harnesses", "opencode,claude"], options), 0, err.join(""));
  assert.deepEqual(await h.list(h.home), before);
  await assertIntegrations(h, plan);
});
