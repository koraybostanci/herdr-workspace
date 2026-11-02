#!/usr/bin/env node
// Native checker safety evidence, pinned to the tested desktop release:
// https://github.com/herdrdev/herdr-app/blob/4aa3460749947e7771aa39a8a2cec58d46649926/src/main.rs#L83-L87
// `check` returns before the core connection at line 129. Never invoke the bare app or control commands.
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultRun } from "../src/cli.mjs";
import { loadBundle, validateBundle } from "../src/bundle.mjs";
import { exportBundleTo } from "./test-clean-install.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODS = ["compact-spaces", "workspace-header", "session-tabs", "space-agents"];
const HELPER = "integrations/session-metadata";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = path => lstat(path).then(() => true, () => false);
const inside = (root, path) => path.startsWith(root + "/");
const put = async (path, bytes) => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes); };
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const OPENCODE = '{\n  // synthetic unrelated configuration; preserve this comment\n  "provider": {"example": {"options": {"baseURL": "https://api.example.test/v1"}}},\n  "plugins": ["unrelated-synthetic-plugin"]\n}\n';
const CLAUDE = '{"env":{"KEEP_NATIVE_SMOKE":"yes"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"synthetic-unrelated-hook"}]}]}}\n';
const HISTORY_MARKER = '{"synthetic":"private history retained"}\n';

async function snapshot(root) {
  const entries = new Map();
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), info = await lstat(path);
      if (info.isSymbolicLink()) entries.set(relative(root, path), "link:" + await readlink(path));
      else if (info.isDirectory()) { entries.set(relative(root, path) + "/", "directory"); await walk(path); }
      else if (info.isFile()) entries.set(relative(root, path), sha(await readFile(path)));
      else throw new Error("Unexpected non-regular fixture file");
    }
  }
  await walk(root);
  return entries;
}
const same = (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

async function executable(path) {
  const actual = await realpath(path);
  requireThat((await lstat(actual)).isFile(), "Native executable must be a regular file");
  await access(actual, constants.X_OK);
  return actual;
}
async function findHerdr(bin, originalPath) {
  if (bin) return executable(resolve(bin));
  for (const directory of originalPath.split(delimiter).filter(Boolean)) {
    try { return await executable(resolve(directory, "herdr-app")); } catch {}
  }
  throw new Error("Herdr desktop executable unavailable; supply --herdr-bin");
}
async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}
function publicRelative(path) {
  requireThat(typeof path === "string" && !isAbsolute(path) && /^[A-Za-z0-9_.+/-]+$/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith(".")), "Unsafe public host path");
  return path;
}
const PRIVATE_NAMES = new Set(["settings.json", "shared.json", "runtime.json", "data", "state", "logs", "credentials", "node_modules"]);
const publicFile = name => name === "mod.json" || ["LICENSE", "NOTICE", "README.md"].includes(name) || /\.(?:[cm]?js|ts|svg|png|webp|jpe?g|gif|woff2?|ttf|otf)$/.test(name);

async function copyPublicHost(hostHome, appHome, bundle, copied) {
  // Traverse only declared public mod folders/assets. Never inspect the host's settings, shared data or state.
  async function infoAt(path) {
    const rel = publicRelative(path);
    let current = hostHome, info;
    for (const part of rel.split("/")) {
      requireThat(!PRIVATE_NAMES.has(part), "Private host resources are not allowed");
      current = join(current, part); info = await lstat(current);
      requireThat(!info.isSymbolicLink(), "Symlinked public host resources are not allowed");
    }
    return info;
  }
  async function copyFile(path) {
    requireThat((await infoAt(path)).isFile(), "Public host resource must be a regular file");
    const from = join(hostHome, path), bytes = await readFile(from);
    copied.set(from, sha(bytes));
    await put(join(appHome, path), bytes);
  }
  async function walk(path) {
    const info = await infoAt(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(hostHome, path))).sort()) {
        if (name.startsWith(".") || PRIVATE_NAMES.has(name)) continue;
        const child = `${path}/${name}`, entry = await infoAt(child);
        if (entry.isDirectory()) await walk(child);
        else if (publicFile(name)) await copyFile(child);
      }
    } else if (publicFile(path.split("/").pop())) await copyFile(path);
  }
  for (const mod of bundle.host.mods) {
    requireThat(/^[A-Za-z0-9_-]+$/.test(mod.name) && !bundle.mods.some(owned => owned.name === mod.name), "Unsafe built-in mod declaration");
    await walk(`mods/${mod.name}`);
  }
  for (const asset of bundle.host.assets) {
    requireThat(/^(?:icons|mods|frame)\//.test(asset) && /\.(?:svg|png|webp|jpe?g|gif|woff2?|ttf|otf)$/.test(asset), "Unsupported public asset declaration");
    await copyFile(asset);
  }
}

// This temporary entry imports copies of installed source, not Node mocks or product test-only branches.
const CHECKER_ENTRY = `import SpaceAgents from "./installed-source.js";
import { renderSessionHistory } from "./history-ui.js";
import { HistoryController } from "./history-controller.js";
import { theme, appHome, setShared } from "herdr";
export default class NativeRuntimeSmoke extends SpaceAgents {
  init(_props, cx) {
    super.init({ tree: true }, cx);
    if (!this.tree || !this.historySearch) throw Error("Tree mode was not initialized");
    setShared("space-agents.history.open", true);
    this.viewMenuOpen = true; this.historyOptions.menuOpen = true;
    this.smokeHistory = new HistoryController(); this.smokeHistory.init(cx);
    this.smokeHistory.space = { id: "native-smoke-space", host: "local", folder: appHome() + "/synthetic-project" };
    this.smokeHistory.mode = "recent"; this.smokeHistory.page = { complete: true, total: 1, hasMore: false };
    this.smokeHistory.confirmDeleteKey = "native-smoke-history";
  }
  render(cx) {
    const t = theme(), folder = appHome() + "/synthetic-project";
    const card = { address: "native-smoke-terminal", title: "Synthetic active agent", status: "working", directory: "synthetic-project",
      cwd: folder, branch: "synthetic-branch", program: { key: "claude", name: "Synthetic agent", icon: "icons/claude.svg", tint: true } };
    const row = { key: "native-smoke-history", title: "Synthetic saved history", directory: folder, updatedAt: Date.now(), saved: "available", bindings: [],
      session: { host: "local", authority: "native-smoke", harness: "claude", id: "native-smoke-saved" } };
    // The real tree render constructs the native vertical resizable panels, global InputState and view popovers.
    return super.render(cx).child(this.card(card, false, t))
      .child(renderSessionHistory({ rows: [row], groups: [{ key: "native-smoke-group", label: "Synthetic history", rows: [row] }],
        controller: this.smokeHistory, compact: false, theme: t, knownPrograms: [], folded: false, heading: false, controls: false }));
  }
  close() { this.smokeHistory?.close(); super.close(); }
}
`;

export async function runNativeInstall({ sourceRoot = SOURCE_ROOT, hostHome = join(homedir(), ".config/herdr-app"), herdrBin,
  tmpRoot = process.env.HERDR_WORKSPACE_TEST_TMPDIR || process.env.TMPDIR || tmpdir(), run, keep = false, platform = process.platform } = {}) {
  const originalPath = process.env.PATH ?? "";
  const protectedRoots = await Promise.all([sourceRoot, hostHome].map(path => canonicalDestination(resolve(path))));
  const temporaryRoot = await canonicalDestination(resolve(tmpRoot));
  if (protectedRoots.some(root => temporaryRoot === root || inside(root, temporaryRoot))) return {
    checks: [{ name: "isolated temporary root", ok: false, detail: "Temporary root must be outside the source checkout and live host home" }],
    runtime: { herdrVersion: null, nodeVersion: process.version, platform, arch: process.arch }, fixtureHome: null, modifiedPaths: [],
  };
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const fixtureHome = await realpath(await mkdtemp(join(tmpRoot, "native-install-")));
  const exportRoot = join(fixtureHome, "export"), priorRoot = join(fixtureHome, "synthetic-prior-export");
  const appHome = join(fixtureHome, ".config/herdr-app"), stateRoot = join(fixtureHome, ".local/state/herdr-agent-metadata");
  const bin = join(fixtureHome, "fixture-bin"), configHome = join(fixtureHome, ".config"), claudeHome = join(fixtureHome, ".claude");
  const opencodePath = join(configHome, "opencode/cli.json"), claudePath = join(claudeHome, "settings.json");
  const checks = [], copied = new Map(), syntheticUpgrade = {};
  const runtime = { herdrVersion: null, nodeVersion: process.version, platform, arch: process.arch };
  let binary, bundle, cli, parseDoc, installed = false, modifiedPaths = [];
  const env = {
    HOME: fixtureHome, HERDR_APP_HOME: appHome, HERDR_METADATA_STATE_DIR: stateRoot,
    XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(fixtureHome, ".local/state"), XDG_CACHE_HOME: join(fixtureHome, ".cache"), XDG_DATA_HOME: join(fixtureHome, ".local/share"),
    CLAUDE_CONFIG_DIR: claudeHome, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C.UTF-8", TMPDIR: join(fixtureHome, "tmp"),
    npm_config_cache: join(fixtureHome, "npm-cache"), npm_config_userconfig: join(fixtureHome, "npm-user.config"), npm_config_globalconfig: join(fixtureHome, "npm-global.config"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false",
  };
  const step = async (name, action) => {
    try { await action(); checks.push({ name, ok: true }); return true; }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : "Operation failed" }); return false; }
  };
  const execute = async (command, args = [], options = {}) => {
    const cwd = options.cwd ?? appHome;
    requireThat(inside(fixtureHome, cwd), "Command working directory escaped the fixture");
    if (command === "herdr-app") command = binary;
    if (command === binary) requireThat(args.length === 1 && args[0] === "--version"
      || args.length === 2 && args[0] === "check" && inside(appHome, args[1]), "Unsafe native command refused");
    // Do not merge options.env: child processes may never regain the caller's credentials/profile variables.
    const result = await (run ?? defaultRun)(command, args, { ...options, cwd, env: { ...env }, timeout: 60000 });
    if (result instanceof Error) throw result;
    return result;
  };
  const invoke = async (command, source = exportRoot, configure = false) => {
    const code = await cli.runCli([command, ...(configure ? ["--configure-harnesses", "opencode,claude"] : [])], {
      run: execute, node: process.execPath, env, platform, sourceRoot: source, stdout: () => {}, stderr: () => {},
    });
    requireThat(code === 0, `${command} failed; inspect this operation in a retained synthetic fixture`);
  };
  const descriptor = () => readFile(join(appHome, "data/space-agents/runtime.json"), "utf8").then(JSON.parse);
  const managedSnapshot = async () => {
    const values = [];
    for (const path of [appHome, stateRoot]) values.push(await snapshot(path));
    values.push(await readFile(opencodePath, "utf8"), await readFile(claudePath, "utf8"));
    return values;
  };
  const repeat = async source => {
    const before = await managedSnapshot();
    await invoke("install", source, true);
    const after = await managedSnapshot();
    requireThat(before.every((value, i) => value instanceof Map ? same(value, after[i]) : value === after[i]), "Repeat install changed managed files, state or settings");
  };
  const unrelatedSettings = async () => {
    const text = await readFile(opencodePath, "utf8"), oc = parseDoc(text), cl = parseDoc(await readFile(claudePath, "utf8"));
    requireThat(text.includes("// synthetic unrelated configuration; preserve this comment") && oc.provider.example.options.baseURL === "https://api.example.test/v1"
      && oc.plugins.filter(value => value === "unrelated-synthetic-plugin").length === 1 && oc.plugins.filter(value => typeof value?.package === "string").length === 1
      && cl.env.KEEP_NATIVE_SMOKE === "yes" && cl.hooks.Stop.some(group => group.hooks.some(hook => hook.command === "synthetic-unrelated-hook")), "Unrelated settings or singular integration was not preserved");
  };
  try {
    if (!await step("supported native runtime", async () => {
      requireThat(platform === "darwin" && (run || process.platform === "darwin"), "Real native smoke requires macOS");
      binary = await findHerdr(herdrBin, originalPath);
      await mkdir(appHome, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(env.TMPDIR);
      await symlink(await realpath(process.execPath), join(bin, "node"));
      await symlink(await executable(join(dirname(process.execPath), "npm")), join(bin, "npm"));
      await symlink(binary, join(bin, "herdr-app"));
      for (const tool of ["hc", "git", "gh"]) await writeFile(join(bin, tool), `#!${process.execPath}\nprocess.exitCode = 1;\n`, { mode: 0o755 });
      await put(env.npm_config_userconfig, ""); await put(env.npm_config_globalconfig, "");
      const version = await execute(binary, ["--version"]);
      const found = version?.code === 0 && typeof version.stdout === "string" ? /^(?:herdr-app\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version.stdout.trim()) : null;
      requireThat(found, "Herdr --version failed or was malformed; supply a usable --herdr-bin");
      runtime.herdrVersion = found.slice(1).join(".");
      requireThat(runtime.herdrVersion === "0.1.12", "Native smoke requires Herdr 0.1.12; checker-before-core behavior is pinned to this release");
    })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
    if (!await step("exported bundle validates", async () => {
      await exportBundleTo(sourceRoot, exportRoot);
      bundle = await loadBundle(exportRoot);
      requireThat((await validateBundle(bundle, exportRoot)).ok, "Exported bundle validation failed; refresh its declared file hashes and closure");
      requireThat(MODS.every(name => bundle.mods.some(mod => mod.name === name)), "All four workspace mods are required");
    })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
    if (!await step("copy declared public built-ins and assets", async () => {
      await copyPublicHost(await realpath(hostHome), appHome, bundle, copied);
      await put(opencodePath, OPENCODE); await put(claudePath, CLAUDE);
    })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
    if (!await step("dependencies install with scripts disabled", async () => {
      requireThat((await execute("npm", ["ci", "--ignore-scripts"], { cwd: exportRoot })).code === 0, "Root dependency installation failed");
      requireThat(await exists(join(exportRoot, "node_modules/jsonc-parser/package.json")), "Root dependency is missing");
      cli = await import(pathToFileURL(join(exportRoot, "src/cli.mjs")).href);
      ({ parseDoc } = await import(pathToFileURL(join(exportRoot, "src/install-common.mjs")).href));
      await exportBundleTo(exportRoot, priorRoot);
      const prior = await loadBundle(priorRoot), entry = `${HELPER}/bin/herdr-session-meta.mjs`;
      await writeFile(join(priorRoot, entry), (await readFile(join(priorRoot, entry), "utf8")) + "\n// Synthetic prior managed payload for native upgrade smoke; not a historical release.\n");
      prior.files[entry] = sha(await readFile(join(priorRoot, entry)));
      await writeFile(join(priorRoot, "bundle.json"), JSON.stringify(prior, null, 2) + "\n");
    })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
    if (!await step("plan writes nothing", async () => {
      const before = await snapshot(fixtureHome);
      await invoke("plan", priorRoot, true);
      requireThat(same(before, await snapshot(fixtureHome)), "Planning wrote to the fixture");
    })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
    try {
      if (!await step("fresh install leaves harness settings untouched", async () => {
        await invoke("install", priorRoot); installed = true;
        requireThat(await readFile(opencodePath, "utf8") === OPENCODE && await readFile(claudePath, "utf8") === CLAUDE, "Installation without opt-in changed settings");
        syntheticUpgrade.oldRelease = dirname(dirname((await descriptor()).helperPath));
        await put(join(stateRoot, "history/native-smoke-marker.json"), HISTORY_MARKER);
      })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
      if (!await step("explicit harness opt-in preserves unrelated settings", async () => { await invoke("install", priorRoot, true); await unrelatedSettings(); })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
      await step("repeat install is idempotent", () => repeat(priorRoot));
      if (!await step("synthetic managed helper upgrade to current", async () => {
        await invoke("install", exportRoot, true);
        syntheticUpgrade.currentRelease = dirname(dirname((await descriptor()).helperPath));
        requireThat(syntheticUpgrade.oldRelease !== syntheticUpgrade.currentRelease, "Synthetic upgrade did not change the managed helper release");
        requireThat(inside(appHome, syntheticUpgrade.currentRelease), "Managed release escaped the fixture");
        await unrelatedSettings(); await repeat(exportRoot);
      })) return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
      await step("doctor", () => invoke("doctor"));
      const payloadOk = await step("installed payload and legal files", async () => {
        for (const [path, hash] of Object.entries(bundle.files).filter(([path]) => /^(mods|layouts)\//.test(path))) requireThat(sha(await readFile(join(appHome, path))) === hash, "Installed payload differs from the current export");
        for (const name of MODS) for (const file of ["LICENSE", "NOTICE"]) if (await exists(join(exportRoot, "mods", name, file))) requireThat(await exists(join(appHome, "mods", name, file)), "Installed mod legal file is missing");
      });
      if (payloadOk) {
        for (const name of MODS) await step(`native ${name}`, async () => {
          requireThat((await execute(binary, ["check", join(appHome, "mods", name)])).code === 0, "Native checker rejected the installed mod");
        });
        await step("native tree, resizable, InputState, popovers and populated rows", async () => {
          const checker = join(appHome, "mods/native-runtime-smoke");
          await cp(join(appHome, "mods/space-agents"), checker, { recursive: true, dereference: false });
          await rename(join(checker, "main.js"), join(checker, "installed-source.js"));
          await writeFile(join(checker, "main.js"), CHECKER_ENTRY);
          try { requireThat((await execute(binary, ["check", checker])).code === 0, "Native checker rejected the populated tree/runtime fixture"); }
          finally { await rm(checker, { recursive: true, force: true }); }
        });
      }
    } finally {
      if (installed) await step("uninstall restores settings and retains private history", async () => {
        await invoke("uninstall");
        requireThat(await readFile(opencodePath, "utf8") === OPENCODE && await readFile(claudePath, "utf8") === CLAUDE, "Uninstall did not restore the synthetic original settings");
        requireThat(await readFile(join(stateRoot, "history/native-smoke-marker.json"), "utf8") === HISTORY_MARKER, "Uninstall removed the private history marker");
        for (const name of MODS) requireThat(!await exists(join(appHome, "mods", name, "main.js")), "Uninstall left an installed workspace mod");
        requireThat(!await exists(join(appHome, "data/space-agents/runtime.json")), "Uninstall left the managed runtime descriptor");
      });
    }
    await step("public host sources are unchanged", async () => {
      requireThat(copied.size > 0, "No public host resources were copied");
      for (const [path, hash] of copied) requireThat(sha(await readFile(path)) === hash, "A source host public resource changed during smoke");
    });
    modifiedPaths = [...(await snapshot(fixtureHome)).keys()].filter(path => !path.endsWith("/")).map(path => join(fixtureHome, path));
    return { checks, runtime, fixtureHome, exportRoot, modifiedPaths, syntheticUpgrade };
  } finally {
    if (!keep) await rm(fixtureHome, { recursive: true, force: true });
  }
}

// CLI output is a projection, never a serialization of internal paths, exceptions or child stdout/stderr.
export function publicNativeReport(result) {
  const { herdrVersion, nodeVersion, platform, arch } = result.runtime;
  return { runtime: { herdrVersion, nodeVersion, platform, arch }, checks: result.checks.map(({ name, ok }) => ({ name, ok })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, args = process.argv.slice(2);
    let json = false;
    while (args.length) {
      const flag = args.shift();
      if (flag === "--keep") options.keep = true;
      else if (flag === "--json") json = true;
      else {
        const key = { "--source-root": "sourceRoot", "--host-home": "hostHome", "--herdr-bin": "herdrBin", "--tmp-root": "tmpRoot" }[flag];
        requireThat(key && args[0] && !args[0].startsWith("--"), "Invalid native smoke options");
        options[key] = resolve(args.shift());
      }
    }
    const report = publicNativeReport(await runNativeInstall(options));
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`runtime: Herdr ${report.runtime.herdrVersion ?? "unavailable"}, Node ${report.runtime.nodeVersion}, ${report.runtime.platform}/${report.runtime.arch}`);
      for (const check of report.checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}`);
    }
    process.exitCode = report.checks.length && report.checks.every(check => check.ok) ? 0 : 1;
  } catch {
    console.error("Native smoke setup failed. Check the supplied options, public host resources and writable temporary root.");
    process.exitCode = 1;
  }
}
