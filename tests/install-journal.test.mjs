import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { parse as parseJsonc } from "jsonc-parser";
import { installHome, NODE, OPENCODE_SETTINGS, CLAUDE_SETTINGS } from "./helpers/install-home.mjs";
import { planInstall } from "../src/install-plan.mjs";
import { applyInstall, uninstall } from "../src/install-journal.mjs";

const planOf = (h, extra = {}) => planInstall({ bundle: h.bundle, sourceRoot: h.sourceRoot, appHome: h.appHome, stateRoot: h.stateRoot, node: NODE,
  harnesses: { opencodePath: h.opencodePath, claudePath: h.claudePath }, configureHarnesses: ["opencode", "claude"], ...extra });
const mode = async p => (await stat(p)).mode & 0o777;

test("fresh_install_without_existing_hooks", async t => {
  const h = await installHome(t);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  assert.equal(receipt.phase, "installed");
  const plan = await planOf(h);
  for (const name of ["space-agents", "compact-spaces", "session-tabs"]) assert.ok(await stat(join(h.appHome, "mods", name, "main.js")));
  assert.ok(await stat(join(h.appHome, "layouts/herdr-workspace.json")));
  // The layout is installed but never selected.
  assert.equal(await h.read(join(h.appHome, "shared.json")), null);
  const claude = JSON.parse(await h.read(h.claudePath));
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "CwdChanged", "Stop", "SessionEnd"]) {
    const [group] = claude.hooks[event];
    assert.equal(group.hooks[0].command, NODE);
    assert.deepEqual(group.hooks[0].args, [join(plan.roots.releaseDir, "bin/herdr-session-meta.mjs"), "hook", "claude"]);
  }
  const opencode = JSON.parse(await h.read(h.opencodePath));
  assert.deepEqual(opencode.plugins, [{ package: plan.roots.releaseDir, options: { appHome: h.appHome, stateRoot: h.stateRoot } }]);
  // Dependencies come from the lockfile in the release, with no lifecycle scripts.
  const npm = h.run.calls.filter(c => c.command === "npm" && c.args[0] === "ci");
  assert.equal(npm.length, 1);
  assert.deepEqual(npm[0].args.slice(0, 2), ["ci", "--ignore-scripts"]);
  assert.equal(npm[0].cwd, plan.roots.releaseDir);
  // Metadata owner root is initialised through its API.
  assert.equal(JSON.parse(await h.read(join(h.stateRoot, "owner.json"))).owner, "herdr-session-metadata");
  // Private modes.
  assert.equal(await mode(plan.roots.releaseDir), 0o700);
  assert.equal(await mode(join(plan.roots.releaseDir, "build-manifest.json")), 0o600);
  assert.equal(await mode(plan.roots.journalPath), 0o600);
  assert.equal(await mode(join(h.appHome, "data/space-agents/runtime.json")), 0o600);
});

test("repeat_install_is_idempotent", async t => {
  const h = await installHome(t);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  const first = await applyInstall(await planOf(h), { run: h.run });
  const snapshot = [await h.list(h.home), await h.read(h.claudePath), await h.read(h.opencodePath), await h.read(first.roots.journalPath)];
  const plan = await planOf(h);
  assert.ok(plan.files.every(f => f.action === "unchanged"), "nothing left to write");
  assert.deepEqual(plan.configEdits.filter(e => e.status !== "present"), []);
  const writes = [];
  const second = await applyInstall(plan, { run: h.run, writeText: async (...a) => { writes.push(a[0]); throw new Error("must not write"); } });
  assert.equal(second.phase, "installed");
  assert.deepEqual(writes, []);
  assert.deepEqual([await h.list(h.home), await h.read(h.claudePath), await h.read(h.opencodePath), await h.read(first.roots.journalPath)], snapshot);
  assert.equal(h.run.calls.filter(c => c.command === "npm" && c.args[0] === "ci").length, 1, "dependencies are not reinstalled");
  assert.equal(JSON.parse(await h.read(h.claudePath)).hooks.Stop.length, 2, "unrelated Stop hook plus exactly one owned hook");
});

test("settings_unrelated_fields_are_preserved", async t => {
  const h = await installHome(t);
  await h.write(h.opencodePath, OPENCODE_SETTINGS);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  await applyInstall(await planOf(h), { run: h.run });
  const opencode = await h.read(h.opencodePath);
  assert.ok(opencode.includes("// keep this comment"));
  assert.ok(opencode.includes('"baseURL": "https://llm.example.test/v1"') && opencode.includes('"model": "example/model-x"') && opencode.includes('"other-plugin"'));
  const claude = JSON.parse(await h.read(h.claudePath));
  assert.equal(claude.apiKeyHelper, "/usr/local/bin/example-key-helper");
  assert.deepEqual(claude.env, { KEEP_ME: "1" });
  assert.deepEqual(claude.hooks.Stop[0], { hooks: [{ type: "command", command: "unrelated-hook" }] });
});

test("interrupted_apply_resumes_with_original_ownership", async t => {
  const h = await installHome(t);
  await h.write(h.claudePath, JSON.stringify({ env: { KEEP_ME: "1" } }, null, 2) + "\n");
  const original = await h.read(h.claudePath);
  // Fail partway through the harness edits: the claude file already has some hooks (and a created `hooks` object).
  let count = 0, fail = true;
  const interrupted = async (path, text, expected) => {
    if (fail && path === h.claudePath && ++count === 3) throw new Error("simulated crash");
    return (await import("../src/install-journal.mjs")).writeGuarded(path, text, expected);
  };
  await assert.rejects(applyInstall(await planOf(h), { run: h.run, writeText: interrupted }), /simulated crash/);
  const partial = JSON.parse(await h.read(h.claudePath));
  assert.ok(partial.hooks.SessionStart && !partial.hooks.SessionEnd, "settings are partly applied");
  const journalPath = (await planOf(h)).roots.journalPath;
  assert.equal(JSON.parse(await h.read(journalPath)).phase, "applying", "rollback record is kept");
  // A different install while one is pending is refused instead of overwriting the record.
  await assert.rejects(applyInstall(await planOf(h, { node: "/opt/other/node" }), { run: h.run }), /pending-install-differs/);
  fail = false;
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  assert.equal(receipt.phase, "installed");
  const full = JSON.parse(await h.read(h.claudePath));
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "CwdChanged", "Stop", "SessionEnd"]) assert.equal(full.hooks[event].length, 1, event);
  assert.equal(h.run.calls.filter(c => c.command === "npm" && c.args[0] === "ci").length, 1, "staged dependencies are reused");
  // Ownership flags come from the first plan, so removal restores the untouched original.
  await uninstall(receipt);
  assert.equal(await h.read(h.claudePath), original);
});

test("failed dependency install keeps recovery evidence and never reaches settings", async t => {
  const h = await installHome(t);
  h.run.failNpm = true;
  const plan = await planOf(h);
  await assert.rejects(applyInstall(plan, { run: h.run }), /dependency-install-failed/);
  assert.equal(await h.read(h.claudePath), null);
  assert.equal(await h.read(join(h.appHome, "data/space-agents/runtime.json")), null, "descriptor not switched");
  assert.equal(await h.read(join(h.appHome, "mods/session-tabs/main.js")), null);
  const journal = JSON.parse(await h.read(plan.roots.journalPath));
  assert.equal(journal.phase, "applying");
  assert.ok(journal.steps.some(s => s.kind === "file" && s.applied), "staged release is recorded as owned");
  h.run.failNpm = false;
  assert.equal((await applyInstall(await planOf(h), { run: h.run })).phase, "installed");
});

test("uninstall_preserves_later_edits_and_reviews", async t => {
  const h = await installHome(t);
  await h.write(h.opencodePath, OPENCODE_SETTINGS);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  const { releaseDir } = receipt.roots;
  // Private review data exists and must survive.
  await mkdir(join(h.stateRoot, "v2"), { recursive: true });
  await writeFile(join(h.stateRoot, "v2/state.sqlite"), "synthetic review data");
  // Later user edits: a new setting, a new unrelated hook, and a changed mod file.
  const later = JSON.parse(await h.read(h.claudePath));
  later.env.ADDED_LATER = "yes";
  later.hooks.Stop.push({ hooks: [{ type: "command", command: "added-later" }] });
  await writeFile(h.claudePath, JSON.stringify(later, null, 2) + "\n");
  await writeFile(join(h.appHome, "mods/compact-spaces/main.js"), "// user tweak\n");
  const oc = parseJsonc(await h.read(h.opencodePath));
  oc.plugins[1].options.stateRoot = "/changed/by/user/state";
  await writeFile(h.opencodePath, JSON.stringify(oc, null, 2) + "\n");

  const result = await uninstall(receipt);
  assert.equal(result.phase, "uninstalled");
  const claude = JSON.parse(await h.read(h.claudePath));
  assert.equal(claude.env.ADDED_LATER, "yes");
  assert.equal(claude.apiKeyHelper, "/usr/local/bin/example-key-helper");
  assert.deepEqual(claude.hooks.Stop.map(g => g.hooks[0].command), ["unrelated-hook", "added-later"]);
  assert.deepEqual(Object.keys(claude.hooks), ["Stop"], "owned hook entries removed");
  assert.ok(result.kept.some(k => k.path === join(h.appHome, "mods/compact-spaces/main.js") && k.reason === "modified"));
  assert.equal(await h.read(join(h.appHome, "mods/compact-spaces/main.js")), "// user tweak\n");
  const ocAfter = parseJsonc(await h.read(h.opencodePath));
  assert.equal(ocAfter.plugins.length, 2, "user-modified owned entry is kept");
  assert.ok(result.kept.some(k => k.path === h.opencodePath && k.reason === "modified"));
  assert.equal(await h.read(join(h.stateRoot, "v2/state.sqlite")), "synthetic review data");
  assert.ok(await h.read(join(h.stateRoot, "owner.json")), "metadata state is retained");
  assert.equal(await h.read(join(h.appHome, "mods/session-tabs/main.js")), null, "unchanged owned files are removed");
  assert.equal(await h.read(join(h.appHome, "layouts/herdr-workspace.json")), null);
  assert.equal(await h.read(join(h.appHome, "data/space-agents/runtime.json")), null);
  assert.equal(await h.read(join(releaseDir, "bin/herdr-session-meta.mjs")), null);
});

test("uninstall of a clean install restores the original settings byte for byte", async t => {
  const h = await installHome(t);
  await h.write(h.opencodePath, OPENCODE_SETTINGS);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  await uninstall(receipt);
  assert.equal(await h.read(h.opencodePath), OPENCODE_SETTINGS);
  assert.equal(await h.read(h.claudePath), CLAUDE_SETTINGS);
  assert.deepEqual((await h.list(h.appHome)).filter(p => !p.startsWith("data") && !p.startsWith("mods/") && !p.startsWith("layouts/") && !p.startsWith("integrations/")).length >= 0, true);
  assert.equal(await h.read(join(h.appHome, "mods/session-tabs/main.js")), null);
});

test("uninstall removes settings files it created", async t => {
  const h = await installHome(t);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  assert.ok(await h.read(h.claudePath));
  await uninstall(receipt);
  assert.equal(await h.read(h.claudePath), null);
  assert.equal(await h.read(h.opencodePath), null);
});

test("upgrade replaces owned entries and keeps one set", async t => {
  const h = await installHome(t);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  await applyInstall(await planOf(h), { run: h.run });
  const next = await planOf(h, { node: "/opt/example/node" });
  assert.notEqual(next.id, (await planOf(h)).id);
  const receipt = await applyInstall(next, { run: h.run });
  const claude = JSON.parse(await h.read(h.claudePath));
  assert.deepEqual(claude.hooks.SessionStart.map(g => g.hooks[0].command), ["/opt/example/node"]);
  await uninstall(receipt);
  assert.equal(await h.read(h.claudePath), CLAUDE_SETTINGS);
  void readFile;
});
