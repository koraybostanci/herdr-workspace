import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { installHome, NODE, CLAUDE_SETTINGS } from "./helpers/install-home.mjs";
import { exportBundle } from "./helpers/bundle-export.mjs";
import { buildFileHashes, loadBundle } from "../src/bundle.mjs";
import { planInstall } from "../src/install-plan.mjs";
import { applyInstall, uninstall, writeGuarded } from "../src/install-journal.mjs";
import { runCli } from "../src/cli.mjs";

const planOf = (h, extra = {}) => planInstall({ bundle: h.bundle, sourceRoot: h.sourceRoot, appHome: h.appHome, stateRoot: h.stateRoot, node: NODE,
  harnesses: { opencodePath: h.opencodePath, claudePath: h.claudePath }, configureHarnesses: ["claude"], ...extra });

// A second bundle version: two mod files change, so the plan id changes while the helper release stays the same.
async function v2Source(t) {
  const root = await exportBundle(t);
  for (const f of ["mods/compact-spaces/main.js", "mods/session-tabs/main.js"]) await writeFile(join(root, f), (await readFile(join(root, f), "utf8")) + "\n// v2\n");
  const bundle = JSON.parse(await readFile(join(root, "bundle.json"), "utf8"));
  bundle.files = await buildFileHashes(root, bundle.include);
  await writeFile(join(root, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n");
  return { root, bundle: await loadBundle(root) };
}

test("uninstall tolerates URLs in later user settings and never gets stuck", async t => {
  const h = await installHome(t);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  const later = JSON.parse(await h.read(h.claudePath));
  later.env = { BASE: "https://example.test/v1" };
  await writeFile(h.claudePath, JSON.stringify(later, null, 2) + "\n");
  const result = await uninstall(receipt);
  assert.equal(result.phase, "uninstalled");
  assert.equal(JSON.parse(await h.read(h.claudePath)).env.BASE, "https://example.test/v1");
  assert.equal(await h.read(join(h.appHome, "mods/session-tabs/main.js")), null);
});

test("uninstall keeps a created settings file that gained a user comment", async t => {
  const h = await installHome(t);
  const receipt = await applyInstall(await planOf(h), { run: h.run });
  await writeFile(h.claudePath, "// my notes\n" + await h.read(h.claudePath));
  await uninstall(receipt);
  assert.ok((await h.read(h.claudePath)).includes("// my notes"));
});

test("a user edit made before an upgrade survives upgrade and uninstall", async t => {
  const h = await installHome(t);
  await h.write(h.claudePath, CLAUDE_SETTINGS);
  await applyInstall(await planOf(h), { run: h.run });
  const later = JSON.parse(await h.read(h.claudePath));
  later.env.ADDED_LATER = "yes";
  await writeFile(h.claudePath, JSON.stringify(later, null, 2) + "\n");
  const receipt = await applyInstall(await planOf(h, { node: "/opt/example/node" }), { run: h.run });
  await uninstall(receipt);
  const after = JSON.parse(await h.read(h.claudePath));
  assert.equal(after.env.ADDED_LATER, "yes");
  assert.equal(after.apiKeyHelper, "/usr/local/bin/example-key-helper");
});

test("an interrupted upgrade resumes instead of reporting its own files as foreign", async t => {
  const h = await installHome(t);
  await applyInstall(await planOf(h, { configureHarnesses: [] }), { run: h.run });
  const v2 = await v2Source(t);
  const plan2 = () => planOf(h, { bundle: v2.bundle, sourceRoot: v2.root, configureHarnesses: [] });
  const crash = async (path, ...rest) => { if (path.endsWith("mods/session-tabs/main.js")) throw new Error("simulated crash"); return writeGuarded(path, ...rest); };
  await assert.rejects(applyInstall(await plan2(), { run: h.run, writeText: crash }), /simulated crash/);
  const resumed = await plan2();
  assert.deepEqual(resumed.blockers, []);
  assert.equal((await applyInstall(resumed, { run: h.run })).phase, "installed");
  assert.ok((await h.read(join(h.appHome, "mods/session-tabs/main.js"))).endsWith("// v2\n"));
});

test("a foreign state root is refused before any write", async t => {
  const h = await installHome(t);
  await h.write(join(h.stateRoot, "someone-elses.txt"), "x");
  const before = await h.list(h.home);
  const plan = await planOf(h);
  assert.ok(plan.blockers.some(b => b.rule === "foreign-state-root"), JSON.stringify(plan.blockers));
  await assert.rejects(applyInstall(plan, { run: h.run }), /install-blocked/);
  assert.deepEqual(await h.list(h.home), before);
});

test("a missing npm is refused by the CLI before any write", async t => {
  const h = await installHome(t);
  h.run.noNpm = true;
  const before = await h.list(h.home), err = [];
  const code = await runCli(["install", "--app-home", h.appHome, "--state-root", h.stateRoot], { run: h.run, node: NODE, env: { HOME: h.home }, stdout: () => {}, stderr: s => err.push(s), sourceRoot: h.sourceRoot });
  assert.equal(code, 1);
  assert.match(err.join(""), /npm/);
  assert.deepEqual(await h.list(h.home), before);
});

test("a symlinked destination folder is refused and never written through", async t => {
  const h = await installHome(t);
  const elsewhere = join(h.home, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await mkdir(join(h.appHome, "mods"), { recursive: true });
  await symlink(elsewhere, join(h.appHome, "mods/session-tabs"));
  const plan = await planOf(h);
  assert.ok(plan.blockers.some(b => b.rule === "symlinked-path"), JSON.stringify(plan.blockers));
  await assert.rejects(applyInstall(plan, { run: h.run }), /install-blocked/);
  assert.deepEqual(await readdir(elsewhere), []);
});

test("uninstall keeps an adopted file when its backup is gone", async t => {
  const h = await installHome(t);
  const mine = join(h.appHome, "layouts/herdr-workspace.json");
  await h.write(mine, "{\"id\":\"root\",\"mine\":true}\n");
  const receipt = await applyInstall(await planOf(h, { adopt: true, configureHarnesses: [] }), { run: h.run });
  await rm(join(h.appHome, "data/herdr-workspace/backups"), { recursive: true, force: true });
  const result = await uninstall(receipt);
  assert.ok(result.kept.some(k => k.path === mine && k.reason === "backup-missing"));
  assert.ok(await h.read(mine));
});

test("doctor fails when an installed file is gone or changed", async t => {
  const h = await installHome(t);
  await applyInstall(await planOf(h, { configureHarnesses: [] }), { run: h.run });
  const doctor = async () => {
    const out = [];
    const code = await runCli(["doctor", "--app-home", h.appHome, "--state-root", h.stateRoot], { run: h.run, node: NODE, env: { HOME: h.home }, stdout: s => out.push(s), stderr: () => {}, sourceRoot: h.sourceRoot });
    return { code, out: out.join("") };
  };
  assert.equal((await doctor()).code, 0);
  await rm(join(h.appHome, "mods/session-tabs/main.js"));
  const missing = await doctor();
  assert.equal(missing.code, 1);
  assert.match(missing.out, /FAIL.*mods\/session-tabs\/main\.js/);
});

test("doctor fails when an owned settings entry was removed", async t => {
  const h = await installHome(t);
  await applyInstall(await planOf(h), { run: h.run });
  await writeFile(h.claudePath, "{}\n");
  const out = [];
  const code = await runCli(["doctor", "--app-home", h.appHome, "--state-root", h.stateRoot], { run: h.run, node: NODE, env: { HOME: h.home }, stdout: s => out.push(s), stderr: () => {}, sourceRoot: h.sourceRoot });
  assert.equal(code, 1);
  assert.match(out.join(""), /FAIL.*settings/);
});
