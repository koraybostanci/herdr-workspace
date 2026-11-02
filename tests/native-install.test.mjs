import test from "node:test";
import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { defaultRun } from "../src/cli.mjs";
import { buildFileHashes, loadBundle } from "../src/bundle.mjs";
import { exportBundleTo } from "../scripts/test-clean-install.mjs";
import { runNativeInstall, publicNativeReport } from "../scripts/test-native-install.mjs";
import { repoRoot } from "./helpers/bundle-export.mjs";
import { testTmpRoot } from "./helpers/tmp-root.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const failures = result => result.checks.filter(c => !c.ok);
const put = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };

async function fixture(t, { failNative, version = "herdr-app 0.1.12\n", versionCode = 0 } = {}) {
  const root = await mkdtemp(join(testTmpRoot(), "native-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), hostHome = join(root, "public-host"), tmpRoot = join(root, "scratch");
  await exportBundleTo(repoRoot, sourceRoot);
  const bundle = await loadBundle(sourceRoot);
  // This controlled source fixture is independent of concurrent release-manifest edits.
  bundle.files = await buildFileHashes(sourceRoot, bundle.include);
  await put(join(sourceRoot, "bundle.json"), JSON.stringify(bundle));
  for (const mod of bundle.host.mods) for (const file of mod.files) await put(join(hostHome, "mods", mod.name, file), file.endsWith(".js") ? "// public built-in source\n" : "{}\n");
  for (const asset of bundle.host.assets) await put(join(hostHome, asset), "public asset\n");
  await put(join(hostHome, "settings.json"), "personal settings must not be copied");
  const herdrBin = join(root, "native-binary");
  await writeFile(herdrBin, "not executed: controlled runner boundary\n", { mode: 0o755 });
  const calls = [], nativeSources = [];
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, ...options });
    if (command === herdrBin) {
      if (args.join(" ") === "--version") return { code: versionCode, stdout: version, stderr: "" };
      assert.equal(args.length, 2);
      assert.equal(args[0], "check", "the native binary must never launch or control an app");
      const main = await readFile(join(args[1], "main.js"), "utf8");
      const copied = await readFile(join(args[1], "installed-source.js")).catch(() => null);
      nativeSources.push({ folder: args[1], main, copied });
      return { code: basename(args[1]) === failNative ? 1 : 0, stdout: "native output is deliberately not published", stderr: "" };
    }
    if (basename(command) === "npm") {
      if (args[0] === "--version") return { code: 0, stdout: "11.0.0\n", stderr: "" };
      assert.deepEqual(args, ["ci", "--ignore-scripts"]);
      // Real installer/config/state logic; only registry access is replaced.
      await cp(join(repoRoot, "node_modules/jsonc-parser"), join(options.cwd, "node_modules/jsonc-parser"), { recursive: true });
      await put(join(options.cwd, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "{}\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (["git", "gh"].includes(command)) throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    assert.equal(command, process.execPath);
    return defaultRun(command, args, options);
  };
  return { root, sourceRoot, hostHome, herdrBin, tmpRoot, run, calls, nativeSources, bundle, platform: "darwin" };
}

test("native smoke exercises real install lifecycle, installed sources and a synthetic managed upgrade", async t => {
  const f = await fixture(t);
  const sourceBefore = await readFile(join(f.sourceRoot, "bundle.json"));
  const result = await runNativeInstall({ ...f, keep: true });
  assert.deepEqual(failures(result), []);
  for (const name of ["dependencies install with scripts disabled", "plan writes nothing", "fresh install leaves harness settings untouched",
    "explicit harness opt-in preserves unrelated settings", "repeat install is idempotent", "synthetic managed helper upgrade to current",
    "doctor", "installed payload and legal files", "native compact-spaces", "native workspace-header", "native session-tabs", "native space-agents",
    "native tree, resizable, InputState, popovers and populated rows", "uninstall restores settings and retains private history", "public host sources are unchanged"]) {
    assert.ok(result.checks.some(c => c.name === name && c.ok), name);
  }
  assert.deepEqual(result.runtime, { herdrVersion: "0.1.12", nodeVersion: process.version, platform: "darwin", arch: process.arch });
  assert.ok(result.modifiedPaths.length > 0);
  assert.ok(result.modifiedPaths.every(path => path.startsWith(result.fixtureHome + "/")));
  assert.deepEqual(await readFile(join(f.sourceRoot, "bundle.json")), sourceBefore);
  const native = f.calls.filter(c => c.command === f.herdrBin && c.args[0] === "check");
  assert.equal(native.length, 5);
  for (const c of native) assert.ok(c.args[1].startsWith(result.fixtureHome + "/"));
  const wrapper = f.nativeSources.find(c => basename(c.folder) === "native-runtime-smoke");
  const installed = f.nativeSources.find(c => basename(c.folder) === "space-agents");
  assert.equal(sha(wrapper.copied), sha(installed.main));
  assert.equal(await lstat(result.fixtureHome).then(s => s.isDirectory()), true);
  assert.equal(await readFile(join(result.fixtureHome, ".config/herdr-app/frame/welcome/herdr.png"), "utf8"), "public asset\n");
  for (const tool of ["hc", "git", "gh"]) {
    const unavailable = await defaultRun(join(result.fixtureHome, "fixture-bin", tool), ["--version"], { env: { HOME: result.fixtureHome }, cwd: result.fixtureHome });
    assert.equal(unavailable.code, 1, `${tool} cannot discover a core or credentials`);
  }
  assert.equal(result.syntheticUpgrade.oldRelease === result.syntheticUpgrade.currentRelease, false);
  for (const path of [result.syntheticUpgrade.oldRelease, result.syntheticUpgrade.currentRelease]) assert.ok(path.startsWith(result.fixtureHome + "/"));
  const original = JSON.parse(await readFile(join(result.fixtureHome, ".claude/settings.json"), "utf8"));
  assert.equal(original.env.KEEP_NATIVE_SMOKE, "yes");
  assert.equal(await readFile(join(result.fixtureHome, ".local/state/herdr-agent-metadata/history/native-smoke-marker.json"), "utf8"), '{"synthetic":"private history retained"}\n');
});

test("every child gets a credential-free fixture environment and only safe native commands", async t => {
  const f = await fixture(t);
  const inherited = { GH_TOKEN: "synthetic-token", AWS_PROFILE: "synthetic-profile", OPENCODE_CONFIG: "/synthetic/private/config", NODE_OPTIONS: "--trace-warnings", NPM_CONFIG_USERCONFIG: "/synthetic/private/npmrc", HERDR_APP_HOME: f.hostHome, HC_SESSION: "real-session-must-not-propagate" };
  const before = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const result = await runNativeInstall(f);
  assert.deepEqual(failures(result), []);
  for (const c of f.calls) {
    assert.equal(c.env.HOME, result.fixtureHome);
    assert.ok(c.cwd.startsWith(result.fixtureHome + "/"));
    for (const key of Object.keys(inherited).filter(k => k !== "HERDR_APP_HOME")) assert.equal(c.env[key], undefined, key);
    for (const key of ["HERDR_APP_HOME", "HERDR_METADATA_STATE_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR", "npm_config_cache", "npm_config_userconfig"]) assert.ok(c.env[key].startsWith(result.fixtureHome + "/"), key);
    assert.deepEqual(c.env.PATH.split(":"), [join(result.fixtureHome, "fixture-bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    if (c.command === f.herdrBin) assert.ok(c.args.length === 1 && c.args[0] === "--version" || c.args.length === 2 && c.args[0] === "check");
    assert.ok(!c.args.includes("login") && !c.args.includes("auth"));
  }
  assert.equal(await lstat(result.fixtureHome).catch(e => e.code), "ENOENT", "default cleanup removes only its owned fixture");
  assert.equal(await lstat(f.hostHome).then(s => s.isDirectory()), true);
  assert.equal(await lstat(f.sourceRoot).then(s => s.isDirectory()), true);
});

test("a failed real-check boundary makes the smoke fail but still uninstalls", async t => {
  const f = await fixture(t, { failNative: "space-agents" });
  const result = await runNativeInstall(f);
  assert.deepEqual(failures(result).map(c => c.name), ["native space-agents"]);
  assert.ok(result.checks.some(c => c.name === "uninstall restores settings and retains private history" && c.ok));
});

test("a nonzero version command cannot be accepted just because stdout contains a version", async t => {
  const f = await fixture(t, { versionCode: 1 });
  const result = await runNativeInstall(f);
  assert.ok(failures(result).some(c => c.name === "supported native runtime"));
  assert.equal(f.calls.filter(c => c.args[0] === "ci" || c.args[0] === "check").length, 0);
});

test("unsupported platforms stop before invoking the supplied binary", async t => {
  const f = await fixture(t);
  const result = await runNativeInstall({ ...f, platform: "linux" });
  assert.ok(failures(result).some(c => c.name === "supported native runtime"));
  assert.equal(f.calls.length, 0);
});

test("symlinked built-in sources are refused instead of following them into private data", async t => {
  const f = await fixture(t);
  const target = join(f.root, "not-public.txt");
  await writeFile(target, "do not read or copy this");
  await symlink(target, join(f.hostHome, "mods", f.bundle.host.mods[0].name, "linked.js"));
  const result = await runNativeInstall(f);
  assert.ok(failures(result).some(c => c.name === "copy declared public built-ins and assets"));
  assert.equal(f.calls.filter(c => c.args[0] === "check").length, 0);
});

test("public CLI report excludes fixture paths, commands and raw child output", () => {
  const result = publicNativeReport({ fixtureHome: "/synthetic/private/home", modifiedPaths: ["/synthetic/private/file"],
    commands: [{ stdout: "synthetic credential output" }], runtime: { herdrVersion: "0.1.12", nodeVersion: "v26.0.0", platform: "darwin", arch: "arm64", home: "/synthetic/private/home" },
    checks: [{ name: "doctor", ok: false, detail: "/synthetic/private/home contains synthetic credential output" }] });
  assert.deepEqual(result, { runtime: { herdrVersion: "0.1.12", nodeVersion: "v26.0.0", platform: "darwin", arch: "arm64" }, checks: [{ name: "doctor", ok: false }] });
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("temporary roots inside the supplied live host are refused without creating anything there", async t => {
  const f = await fixture(t), tmpRoot = join(f.hostHome, "must-not-create");
  const result = await runNativeInstall({ ...f, tmpRoot });
  assert.ok(failures(result).some(c => c.name === "isolated temporary root"));
  assert.equal(await lstat(tmpRoot).catch(e => e.code), "ENOENT");
  assert.equal(f.calls.length, 0);
});

test("default executable discovery resolves the original PATH, not the hermetic fixture PATH", async t => {
  const f = await fixture(t), path = process.env.PATH, originalBin = join(f.root, "original-bin");
  await mkdir(originalBin);
  await symlink(f.herdrBin, join(originalBin, "herdr-app"));
  process.env.PATH = originalBin;
  t.after(() => { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; });
  const { herdrBin: _omit, ...options } = f;
  const result = await runNativeInstall(options);
  assert.deepEqual(failures(result), []);
  assert.equal(f.calls[0].command, f.herdrBin);
});

test("the pinned checker safety policy rejects unknown newer native runtimes", async t => {
  const f = await fixture(t, { version: "herdr-app 0.2.0\n" });
  const result = await runNativeInstall(f);
  assert.ok(failures(result).some(c => c.name === "supported native runtime"));
  assert.equal(f.calls.filter(c => c.args[0] === "ci" || c.args[0] === "check").length, 0);
});

test("actual CLI JSON failure output does not expose input paths or exception bodies", async t => {
  const f = await fixture(t);
  const result = await defaultRun(process.execPath, [join(repoRoot, "scripts/test-native-install.mjs"), "--json", "--source-root", f.sourceRoot,
    "--host-home", f.hostHome, "--herdr-bin", join(f.root, "missing-native-executable"), "--tmp-root", f.tmpRoot], {
    env: { HOME: f.root, PATH: "/usr/bin:/bin" }, cwd: f.root,
  });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ["checks", "runtime"]);
  assert.deepEqual(report.checks, [{ name: "supported native runtime", ok: false }]);
  assert.ok(!JSON.stringify(result).includes(f.root));
});
