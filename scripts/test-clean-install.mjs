#!/usr/bin/env node
// Clean-export installation proof. Installs an exported copy of the bundle into a fresh HOME against a synthetic
// Herdr app home, using a hermetic PATH. It never reads the developer's configuration, state or credentials.
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultRun } from "../src/cli.mjs";
import { assetRefsOf, expandInclude, importsOf, loadBundle } from "../src/bundle.mjs";

const SOURCE_CHECKOUT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const SKIP = new Set(["node_modules"]);
const exists = async path => lstat(path).then(() => true, () => false);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

// Copies only what the repository intends to ship: bundle.json, installer files and every file bundle.json declares.
export async function exportBundleTo(sourceRoot, dest) {
  const bundle = await loadBundle(sourceRoot);
  const installer = await expandInclude(sourceRoot, bundle.installer ?? []);
  for (const path of ["bundle.json", ...installer, ...Object.keys(bundle.files)]) {
    await mkdir(dirname(join(dest, path)), { recursive: true });
    await cp(join(sourceRoot, path), join(dest, path));
  }
  return dest;
}

async function snapshot(root) {
  const out = new Map();
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name), info = await lstat(path);
      if (info.isSymbolicLink()) out.set(relative(root, path), "link:" + await readlink(path));
      else if (info.isDirectory()) { out.set(relative(root, path) + "/", "dir"); await walk(path); }
      else out.set(relative(root, path), sha(await readFile(path)));
    }
  }
  await walk(root);
  return out;
}
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();

async function findNpm() {
  const next = join(dirname(process.execPath), "npm");
  return (await exists(next)) ? realpath(next) : null;
}

async function textFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name), info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && info.size < 4 * 1024 * 1024) files.push(path);
    }
  }
  await walk(root);
  return files;
}

async function writeHost(appHome, bundle) {
  const put = async (path, text) => { await mkdir(dirname(join(appHome, path)), { recursive: true }); await writeFile(join(appHome, path), text); };
  for (const mod of bundle.host.mods) for (const file of mod.files) await put(`mods/${mod.name}/${file}`, "{}\n");
  for (const asset of bundle.host.assets) await put(asset, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
}

export async function runCleanInstall({ exportRoot, tmpRoot = join(process.env.HERDR_WORKSPACE_TEST_TMPDIR || join(tmpdir(), "herdr-workspace-tests")), opencode, claude } = {}) {
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const fixtureHome = await realpath(await mkdtemp(join(tmpRoot, "clean-")));
  const appHome = join(fixtureHome, ".config/herdr-app"), stateRoot = join(fixtureHome, ".local/state/herdr-agent-metadata");
  const opencodePath = join(fixtureHome, ".config/opencode/cli.json"), claudePath = join(fixtureHome, ".claude/settings.json");
  const bin = join(fixtureHome, "fixture-bin");
  const checks = [], commands = [], warnings = [], out = [], err = [];
  const check = async (name, action) => {
    try { const detail = await action(); checks.push({ name, ok: detail === undefined || detail === true || (detail && detail.ok !== false), ...(typeof detail === "string" ? { detail } : {}) }); }
    catch (e) { checks.push({ name, ok: false, detail: String(e.message).slice(0, 300) }); }
  };
  const fail = detail => { throw new Error(detail); };

  // Hermetic environment: nothing inherited from the developer's shell (no tokens, harness or session variables).
  const npmBin = await findNpm();
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, "node"));
  if (npmBin) await symlink(npmBin, join(bin, "npm"));
  const stub = (name, body) => writeFile(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  await stub("herdr-app", "console.log('herdr-app 0.1.9')");
  await stub("opencode", `const args=process.argv.slice(2);
    if(args[0]==="service"&&args[1]==="status") console.log("http://127.0.0.1:4096");
    else if(args[0]==="api"&&args[1]==="get"&&args[2]==="/api/session") console.log(JSON.stringify({data:[
      {id:"ses_installed_one",title:"Installed history fixture",location:{directory:process.env.HOME+"/project"},time:{created:1,updated:2}},
      {id:"ses_installed_two",title:"Other Space fixture",location:{directory:process.env.HOME+"/other-project"},time:{created:1,updated:3}}
    ],cursor:{next:null}}));
    else if(args[0]==="--version") console.log("2.2.5");
    else process.exitCode=1;`);
  const cleanEnv = {
    HOME: fixtureHome, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C.UTF-8", TMPDIR: join(fixtureHome, "tmp"),
    npm_config_cache: join(tmpRoot, "npm-cache"), npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false", npm_config_prefer_offline: "true",
  };
  await mkdir(cleanEnv.TMPDIR, { recursive: true });
  const run = async (command, args = [], options = {}) => {
    const env = { ...cleanEnv, ...options.env };
    commands.push({ command, args, cwd: options.cwd, env: { HOME: env.HOME } });
    return defaultRun(command, args, { ...options, env });
  };

  const bundle = await loadBundle(exportRoot);
  await writeHost(appHome, bundle);
  const settings = {};
  for (const [path, text] of [[opencodePath, opencode], [claudePath, claude]]) {
    if (text === undefined) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    settings[path] = text;
  }

  let cli;
  const cliArgs = extra => [...extra];
  const cliRun = async argv => {
    out.length = 0; err.length = 0;
    const code = await cli.runCli(argv, { run, node: process.execPath, env: { HOME: fixtureHome }, sourceRoot: exportRoot, stdout: s => out.push(s), stderr: s => err.push(s) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  let before, installed = false;

  await check("export has no git metadata or dependency symlinks", async () => {
    const bad = [];
    async function walk(dir) {
      for (const name of await readdir(dir)) {
        const path = join(dir, name), info = await lstat(path);
        if (name === ".git" || name === "node_modules" || info.isSymbolicLink()) bad.push(relative(exportRoot, path));
        else if (info.isDirectory()) await walk(path);
      }
    }
    await walk(exportRoot);
    if (bad.length) fail(`unexpected entries: ${bad.join(", ")}`);
  });

  await check("dependencies install from the lockfile", async () => {
    if (!npmBin) fail("npm not found next to node");
    const result = await run("npm", ["ci"], { cwd: exportRoot });
    if (result.code !== 0) fail(`npm ci failed: ${String(result.stderr).slice(-200)}`);
    if (!(await exists(join(exportRoot, "node_modules/jsonc-parser/package.json")))) fail("jsonc-parser not installed");
    cli = await import(pathToFileURL(join(exportRoot, "src/cli.mjs")).href);
  });

  await check("plan writes nothing", async () => {
    before = await snapshot(fixtureHome);
    const settingsBefore = new Map(Object.keys(settings).map(p => [p, null]));
    const result = await cliRun(cliArgs(["plan", "--configure-harnesses", "opencode,claude"]));
    if (result.code !== 0) fail(`plan exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`);
    const diff = changed(before, await snapshot(fixtureHome));
    if (diff.length) fail(`plan changed ${diff.join(", ")}`);
    for (const line of result.stdout.split("\n")) if (line.startsWith("warn ")) warnings.push(line.slice(5));
    void settingsBefore;
  });

  await check("install", async () => {
    const result = await cliRun(cliArgs(["install", "--configure-harnesses", "opencode,claude"]));
    if (result.code !== 0) fail(`install exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
    installed = true;
  });

  await check("repeat install changes nothing", async () => {
    if (!installed) fail("not installed");
    const first = await snapshot(fixtureHome);
    const result = await cliRun(cliArgs(["install", "--configure-harnesses", "opencode,claude"]));
    if (result.code !== 0) fail(`repeat install exited ${result.code}`);
    const diff = changed(first, await snapshot(fixtureHome));
    if (diff.length) fail(`repeat install changed ${diff.join(", ")}`);
  });

  const journalPath = join(appHome, "data/herdr-workspace/install-journal.json");
  await check("bundled imports and assets resolve from the install", async () => {
    if (!installed) fail("not installed");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const releaseDir = journal.roots.releaseDir, problems = [];
    const where = path => (path.startsWith("integrations/session-metadata/") ? join(releaseDir, path.slice("integrations/session-metadata/".length)) : join(appHome, path));
    for (const [path, hash] of Object.entries(bundle.files)) {
      let bytes;
      try { bytes = await readFile(where(path)); } catch { problems.push(`missing ${path}`); continue; }
      if (sha(bytes) !== hash) problems.push(`changed ${path}`);
      if (!/^(mods\/.+\.js|integrations\/session-metadata\/(?:src|bin|claude|opencode)\/.+\.(?:mjs|js))$/.test(path)) continue;
      const text = bytes.toString("utf8");
      for (const spec of importsOf(text)) {
        if (spec.startsWith("node:") || ["herdr", "gpui-kit", "gpui-base"].includes(spec) || (bundle.harnessModules ?? []).includes(spec)) continue;
        if (spec.startsWith(".")) { if (!(await exists(join(dirname(where(path)), spec)))) problems.push(`${path} -> ${spec}`); }
        else if (!(await exists(join(releaseDir, "node_modules", spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0], "package.json")))) problems.push(`${path} needs ${spec}`);
      }
      for (const ref of assetRefsOf(text)) if (!ref.includes("*") && !(await exists(join(appHome, ref)))) problems.push(`${path} asset ${ref}`);
    }
    const descriptor = JSON.parse(await readFile(join(appHome, "data/space-agents/runtime.json"), "utf8"));
    if (!descriptor.helperPath.startsWith(releaseDir + "/")) problems.push("descriptor outside release");
    if (problems.length) fail(problems.slice(0, 6).join("; "));
  });

  await check("doctor", async () => {
    if (!installed) fail("not installed");
    const result = await cliRun(["doctor"]);
    if (result.code !== 0) fail(`doctor exited ${result.code}: ${result.stdout.split("\n").filter(l => l.startsWith("FAIL")).join("; ")}`);
  });

  await check("installed helper reads metadata without Plan storage", async () => {
    if (!installed) fail("not installed");
    const descriptor = JSON.parse(await readFile(join(appHome, "data/space-agents/runtime.json"), "utf8"));
    const result = await run(descriptor.node, [descriptor.helperPath, "snapshot", "--app-home", appHome, "--state-root", stateRoot], { cwd: appHome });
    const value = JSON.parse(result.stdout);
    if (result.code !== 0 || value.owner !== "herdr-session-metadata" || !Array.isArray(value.entries)) fail("metadata snapshot unavailable");
    for (const path of ["mods/plan/main.js", "data/session-plans/runtime.json"]) if (await exists(join(appHome, path))) fail(`${path} was installed`);
    if (await exists(join(stateRoot, "v2"))) fail("Plan storage was created");
    // Existing review data from an older installation must still survive uninstall.
    await mkdir(join(stateRoot, "v2"));
    await writeFile(join(stateRoot, "v2/state.sqlite"), "synthetic legacy reviews");
  });

  await check("installed helper serves Space-filtered history", async () => {
    if (!installed) fail("not installed");
    const descriptor = JSON.parse(await readFile(join(appHome, "data/space-agents/runtime.json"), "utf8"));
    for (const [id, folder, title] of [["first", "project", "Installed history fixture"], ["second", "other-project", "Other Space fixture"]]) {
      const request = { space: { host: "local", coreSession: "default", id, machine: null, folder: join(fixtureHome, folder) },
        view: "recent", query: "", offset: 0, limit: 50, requestId: id };
      const result = await run(descriptor.node, [descriptor.helperPath, "history-view", "--request", JSON.stringify(request), "--json", "--app-home", appHome, "--state-root", stateRoot], { cwd: appHome });
      const value = JSON.parse(result.stdout);
      if (result.code !== 0 || value.owner !== "herdr-session-metadata" || value.history?.length !== 1 || value.history[0].title !== title || value.total !== 1) fail("history was unavailable or leaked another Space");
    }
  });

  await check("no references to the source checkout", async () => {
    const needles = [SOURCE_CHECKOUT, exportRoot];
    const hits = [];
    for (const path of await textFiles(fixtureHome)) {
      if (path.includes("/fixture-bin/")) continue;
      const text = (await readFile(path)).toString("utf8");
      if (needles.some(n => text.includes(n))) hits.push(relative(fixtureHome, path));
    }
    for (const c of commands) if (JSON.stringify([c.args, c.cwd]).includes(SOURCE_CHECKOUT)) hits.push(`command ${c.command}`);
    if (hits.length) fail(`references found in: ${hits.slice(0, 5).join(", ")}`);
  });

  const afterInstall = installed ? await snapshot(fixtureHome) : new Map();
  const modifiedPaths = [...afterInstall.keys()].filter(k => !k.endsWith("/") && !before?.has(k)).map(k => join(fixtureHome, k)).filter(p => !p.includes("/fixture-bin/"));

  await check("uninstall", async () => {
    if (!installed) fail("not installed");
    const result = await cliRun(["uninstall"]);
    if (result.code !== 0) fail(`uninstall exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`);
    for (const path of ["mods/session-tabs/main.js", "mods/space-agents/main.js", "layouts/herdr-workspace.json", "data/space-agents/runtime.json"]) {
      if (await exists(join(appHome, path))) fail(`${path} was not removed`);
    }
  });

  await check("uninstall keeps settings and review data", async () => {
    if (!installed) fail("not installed");
    if (!(await exists(join(stateRoot, "v2/state.sqlite")))) fail("review data was removed");
    for (const [path, text] of Object.entries(settings)) if ((await readFile(path, "utf8")) !== text) fail(`${relative(fixtureHome, path)} differs from the original`);
    for (const path of [opencodePath, claudePath]) if (!(path in settings) && await exists(path)) fail(`created settings file ${relative(fixtureHome, path)} was not removed`);
  });

  await check("uninstall retains private session history", async () => {
    if (!installed) fail("not installed");
    const catalog = JSON.parse(await readFile(join(stateRoot, "history/registry.json"), "utf8"));
    if (catalog.owner !== "herdr-session-metadata" || catalog.sessions.length !== 2) fail("private catalog was removed or changed");
  });

  const npmIgnoresScripts = /^ignore-scripts\s*=\s*true\s*$/m.test(await readFile(join(exportRoot, ".npmrc"), "utf8").catch(() => ""));
  const result = { checks, warnings, commands, modifiedPaths, fixtureHome, exportRoot, npmIgnoresScripts,
    liveHomeTouched: fixtureHome === homedir() || commands.some(c => c.env.HOME !== fixtureHome) };
  if (!process.env.HERDR_WORKSPACE_KEEP) await rm(fixtureHome, { recursive: true, force: true });
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tmpRoot = join(process.env.HERDR_WORKSPACE_TEST_TMPDIR || join(tmpdir(), "herdr-workspace-tests"));
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const exportRoot = await mkdtemp(join(tmpRoot, "export-"));
  try {
    await exportBundleTo(SOURCE_CHECKOUT, exportRoot);
    const result = await runCleanInstall({ exportRoot, tmpRoot });
    for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` - ${c.detail ?? ""}`}`);
    for (const w of new Set(result.warnings)) console.log(`warn ${w}`);
    console.log(result.checks.every(c => c.ok) ? "clean install: all checks passed" : "clean install: FAILED");
    process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
  } finally { await rm(exportRoot, { recursive: true, force: true }); }
}
