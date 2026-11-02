import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadBundle } from "../src/bundle.mjs";
import { preflight } from "../src/preflight.mjs";
import { runCli } from "../src/cli.mjs";
import { planInstall } from "../src/install-plan.mjs";
import { applyInstall } from "../src/install-journal.mjs";
import { installHome, NODE, CLAUDE_SETTINGS } from "./helpers/install-home.mjs";
import { repoRoot } from "./helpers/bundle-export.mjs";
import { hostFixture, fakeRun } from "./helpers/host-fixture.mjs";

const good = { node: { path: "/usr/local/bin/node", version: "v26.13.0" }, git: { code: 0, stdout: "git version 2.50" }, gh: { code: 0, stdout: "gh version 2.103" },
  "herdr-app": { code: 0, stdout: "herdr-app 0.1.12\n" } };

// Exercise the approved compatibility policy independently of release packaging.
async function compatibilityBundle() {
  const bundle = await loadBundle(repoRoot);
  return { ...bundle, requires: { ...bundle.requires, herdr: ">=0.1.12", platforms: ["darwin"] }, host: { ...bundle.host, version: "0.1.12" } };
}

test("compatible host passes", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good), platform: "darwin" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some(w => w.rule === "host-version"));
});

test("missing_required_host_fails_preflight", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle, { omitMods: ["menu"], omitAssets: [bundle.host.assets[0]] });
  const before = await readdir(appHome, { recursive: true });
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good), platform: "darwin" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.rule === "missing-host-mod" && e.name === "menu"));
  assert.ok(result.errors.some(e => e.rule === "missing-host-asset"));
  assert.deepEqual(await readdir(appHome, { recursive: true }), before, "preflight must not write");
});

test("old node fails but metadata no longer requires SQLite", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const old = await preflight({ bundle, appHome, node: { path: "/n", version: "v22.1.0" }, run: fakeRun(good), platform: "darwin" });
  assert.ok(old.errors.some(e => e.rule === "node-version"));
  const noSqlite = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, node: { code: 1, stderr: "no sqlite" } }), platform: "darwin" });
  assert.deepEqual(noSqlite.errors, []);
});

test("missing_optional_gh_warns_only", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, gh: null, git: null }), platform: "darwin" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(w => w.rule === "optional-tool" && w.tool === "gh" && /pull request/i.test(w.message)));
  assert.ok(result.warnings.some(w => w.tool === "git"));
});

test("no_github_auth_does_not_block_ui", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const run = fakeRun({ ...good, gh: { "auth status": { code: 1, stderr: "not logged in" }, code: 0, stdout: "gh version 2.103" } });
  const result = await preflight({ bundle, appHome, node: good.node, run, platform: "darwin" });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.tool === "gh"));
  assert.ok(!run.calls.some(c => c.includes("login") || c.includes("token")), "preflight must never authenticate");
});

test("failing optional tool commands warn even if they print a version", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const run = fakeRun({ ...good, git: { code: 1, stdout: "git version 2.50" }, gh: { code: 1, stdout: "gh version 2.103" } });
  const result = await preflight({ bundle, appHome, node: good.node, run, platform: "darwin" });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.rule === "optional-tool" && w.tool === "git"));
  assert.ok(result.warnings.some(w => w.rule === "optional-tool" && w.tool === "gh"));
});

for (const failure of ["git", "gh", "gh auth status"]) {
  test(`an execution error from optional ${failure} only warns`, async t => {
    const bundle = await compatibilityBundle();
    const appHome = await hostFixture(t, bundle);
    const base = fakeRun(good);
    const run = (command, args) => {
      if ((failure === "gh auth status" ? [command, ...args].join(" ") : command) === failure) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return base(command, args);
    };
    const result = await preflight({ bundle, appHome, node: good.node, run, platform: "darwin" });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some(w => w.rule === "optional-tool" && w.tool === failure.split(" ")[0]));
  });
}

for (const version of ["0.1.9", "0.1.11", "0.0.99"]) {
  test(`older host ${version} blocks`, async t => {
    const bundle = await compatibilityBundle();
    const appHome = await hostFixture(t, bundle);
    const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, "herdr-app": { code: 0, stdout: `herdr-app ${version}\n` } }), platform: "darwin" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.rule === "host-version" && /0\.1\.12/.test(e.message) && /upgrade|install/i.test(e.message)));
  });
}

for (const version of ["0.1.13", "0.2.0", "1.0.0", "9007199254740993.0.0"]) {
  test(`newer host ${version} warns without claiming compatibility`, async t => {
    const bundle = await compatibilityBundle();
    const appHome = await hostFixture(t, bundle);
    const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, "herdr-app": { code: 0, stdout: `herdr-app ${version}\n` } }), platform: "darwin" });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some(w => w.rule === "host-version" && /unverified/.test(w.message) && /0\.1\.12/.test(w.message)));
  });
}

for (const [name, host] of [
  ["missing", null],
  ["failed with version output", { code: 1, stdout: "herdr-app 0.1.12\n" }],
  ["empty", { code: 0, stdout: "" }],
  ["non-version", { code: 0, stdout: "unknown" }],
  ["partial", { code: 0, stdout: "herdr-app 0.1" }],
  ["extra component", { code: 0, stdout: "herdr-app 0.1.12.3" }],
  ["leading zero", { code: 0, stdout: "herdr-app 0.01.12" }],
  ["prerelease", { code: 0, stdout: "herdr-app 0.1.12-beta.1" }],
  ["unrelated version", { code: 0, stdout: "error from dependency 1.0.0" }],
]) {
  test(`${name} host version blocks with recovery guidance`, async t => {
    const bundle = await compatibilityBundle();
    const appHome = await hostFixture(t, bundle);
    const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun({ ...good, "herdr-app": host }), platform: "darwin" });
    assert.equal(result.ok, false);
    const error = result.errors.find(e => e.rule === "host-version");
    assert.ok(error);
    assert.match(error.message, /install/i);
    assert.match(error.message, /launch/i);
    assert.match(error.message, /PATH/);
    assert.match(error.message, /herdr-app --version/);
  });
}

test("a host command that cannot execute blocks without throwing", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const base = fakeRun(good);
  const run = (command, args) => {
    if (command === "herdr-app") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return base(command, args);
  };
  const result = await preflight({ bundle, appHome, node: good.node, run, platform: "darwin" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.rule === "host-version" && /PATH/.test(e.message)));
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} blocks even with a tested host version`, async t => {
    const bundle = await compatibilityBundle();
    const appHome = await hostFixture(t, bundle);
    const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good), platform });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.rule === "platform" && /macOS/.test(e.message)));
  });
}

test("platform defaults to the current operating system", async t => {
  const bundle = await compatibilityBundle();
  const appHome = await hostFixture(t, bundle);
  const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good) });
  assert.equal(result.ok, process.platform === "darwin");
  assert.equal(result.errors.some(e => e.rule === "platform"), process.platform !== "darwin");
});

for (const policy of [undefined, "0.1.12", "^0.1.12", ">=0.1", ">=0.01.12", ">=0.1.12 || >=1.0.0"]) {
  test(`unknown host minimum policy ${policy} fails clearly`, async t => {
    const bundle = await compatibilityBundle();
    bundle.requires.herdr = policy;
    const appHome = await hostFixture(t, bundle);
    const result = await preflight({ bundle, appHome, node: good.node, run: fakeRun(good), platform: "darwin" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.rule === "host-policy" && /requires\.herdr/.test(e.message)));
  });
}

for (const [name, platform, host] of [
  ["old host", "darwin", { code: 0, stdout: "herdr-app 0.1.9" }],
  ["missing host", "darwin", null],
  ["failed host", "darwin", { code: 1, stdout: "herdr-app 0.1.12" }],
  ["unsupported platform", "linux", good["herdr-app"]],
]) {
  test(`CLI refuses ${name} before writing or installing dependencies`, async t => {
    const h = await installHome(t, { tools: { "herdr-app": host } });
    await h.write(h.claudePath, CLAUDE_SETTINGS);
    const before = await h.list(h.home), err = [];
    const code = await runCli(["install", "--app-home", h.appHome, "--state-root", h.stateRoot, "--configure-harnesses", "claude"], {
      run: h.run, node: NODE, platform, env: { HOME: h.home }, stdout: () => {}, stderr: s => err.push(s), sourceRoot: h.sourceRoot,
    });
    assert.equal(code, 1);
    assert.match(err.join(""), /preflight failed; nothing was written/);
    assert.match(err.join(""), name === "unsupported platform" ? /Unsupported platform linux/ : name === "old host" ? /too old/ : /Could not verify the Herdr version/);
    assert.deepEqual(await h.list(h.home), before);
    assert.equal(await h.read(h.claudePath), CLAUDE_SETTINGS);
    assert.ok(!h.run.calls.some(c => c.command === "npm" && c.args[0] === "ci"));
    assert.ok(!h.run.calls.some(c => c.command === "herdr-app" && c.args[0] !== "--version"));
  });
}

test("CLI uninstall still removes a prior install without a host on an unsupported platform", async t => {
  const h = await installHome(t);
  const plan = await planInstall({ bundle: h.bundle, sourceRoot: h.sourceRoot, appHome: h.appHome, stateRoot: h.stateRoot, node: NODE });
  await applyInstall(plan, { run: h.run });
  const missing = fakeRun({ git: null, gh: null, "herdr-app": null });
  const err = [];
  const code = await runCli(["uninstall", "--app-home", h.appHome, "--state-root", h.stateRoot], {
    run: missing, node: NODE, platform: "linux", env: { HOME: h.home }, stdout: () => {}, stderr: s => err.push(s), sourceRoot: h.sourceRoot,
  });
  assert.equal(code, 0, err.join(""));
  assert.equal(await h.read(join(h.appHome, "mods/session-tabs/main.js")), null);
});
