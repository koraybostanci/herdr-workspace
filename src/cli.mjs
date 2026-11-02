import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "./bundle.mjs";
import { planInstall } from "./install-plan.mjs";
import { applyInstall, readJournal, uninstall } from "./install-journal.mjs";
import { deepEqual, getAt, hashOf, journalPathFor, parseDoc, readBytes } from "./install-common.mjs";
import { preflight } from "./preflight.mjs";

const USAGE = `usage: herdr-workspace [plan|install|doctor|uninstall] [options]
  --app-home <dir>              Herdr app home (default ~/.config/herdr-app)
  --state-root <dir>            private metadata state (default ~/.local/state/herdr-agent-metadata)
  --configure-harnesses <list>  opt in to harness setup: opencode,claude
  --opencode-path <file>        OpenCode CLI config (default ~/.config/opencode/cli.json)
  --claude-path <file>          Claude settings (default ~/.claude/settings.json)
  --adopt                       adopt differing files and recognized harness entries, with backups
plan is the default and writes nothing. install must be named explicitly.`;

export const defaultRun = (command, args = [], options = {}) => new Promise(resolvePromise => {
  const child = execFile(command, args, { cwd: options.cwd, timeout: options.timeout ?? 300000, maxBuffer: 16 * 1024 * 1024, env: options.env ?? process.env },
    (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return resolvePromise(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", enoent: true }));
      resolvePromise({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.input);
});
// The preflight runner contract is "throws ENOENT when a tool is missing".
const strictRun = run => async (...args) => { const result = await run(...args); if (result instanceof Error) throw result; return result; };

function parse(argv) {
  const options = { command: "plan", configure: [] };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) options.command = rest.shift();
  const value = name => { const v = rest.shift(); if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`); return v; };
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--app-home") options.appHome = value(flag);
    else if (flag === "--state-root") options.stateRoot = value(flag);
    else if (flag === "--opencode-path") options.opencodePath = value(flag);
    else if (flag === "--claude-path") options.claudePath = value(flag);
    else if (flag === "--configure-harnesses") options.configure = value(flag).split(",").filter(Boolean);
    else if (flag === "--adopt") options.adopt = true;
    else if (flag === "--help" || flag === "-h") options.command = "help";
    else throw new Error(`unknown option ${flag}`);
  }
  if (!["plan", "install", "doctor", "uninstall", "help"].includes(options.command)) throw new Error(`unknown command ${options.command}`);
  return options;
}

const rel = (path, home) => (home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path);

export async function runCli(argv, { run = defaultRun, node = process.execPath, env = process.env, platform = process.platform, stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s),
  sourceRoot = resolve(fileURLToPath(new URL("../", import.meta.url))) } = {}) {
  const say = line => stdout(line + "\n");
  let o;
  try { o = parse(argv); } catch (e) { stderr(`${e.message}\n${USAGE}\n`); return 2; }
  if (o.command === "help") { say(USAGE); return 0; }
  const home = env.HOME ?? homedir();
  const paths = {
    appHome: o.appHome ?? env.HERDR_APP_HOME ?? join(home, ".config/herdr-app"),
    stateRoot: o.stateRoot ?? env.HERDR_METADATA_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "herdr-agent-metadata"),
    opencodePath: o.opencodePath ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode/cli.json"),
    claudePath: o.claudePath ?? join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "settings.json"),
  };
  for (const [name, path] of Object.entries(paths)) if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) { stderr(`${name} must be an absolute path\n`); return 2; }

  try {
    const bundle = await loadBundle(sourceRoot);
    const check = strictRun(run);
    const pre = await preflight({ bundle, appHome: paths.appHome, node: { path: node, version: process.version }, run: check, platform });
    const harnesses = { opencodePath: paths.opencodePath, claudePath: paths.claudePath };

    if (o.command === "uninstall") {
      const journal = await readJournal(journalPathFor(paths.appHome));
      if (!journal) { stderr("nothing to uninstall: no herdr-workspace install record\n"); return 1; }
      const result = await uninstall(journal);
      say(`uninstalled: ${result.removed.length} item(s) removed`);
      for (const k of result.kept) say(`kept (${k.reason}): ${rel(k.path, home)}`);
      say(`kept private metadata and any legacy review data under ${rel(paths.stateRoot, home)}`);
      return 0;
    }

    if (o.command === "doctor") {
      const journal = await readJournal(journalPathFor(paths.appHome));
      let ok = pre.ok;
      const line = (good, text) => { say(`${good ? "ok  " : "FAIL"} ${text}`); if (!good) ok = false; };
      for (const e of pre.errors) line(false, e.message);
      for (const w of pre.warnings) say(`warn ${w.message}`);
      line(journal?.phase === "installed", journal ? `install record: ${journal.phase}` : "no install record");
      if (journal?.phase === "installed") {
        const descriptor = JSON.parse((await readBytes(join(paths.appHome, "data/space-agents/runtime.json")))?.toString("utf8") ?? "null");
        line(descriptor?.owner === "herdr-session-metadata" && descriptor.helperPath?.startsWith(join(journal.roots.releaseDir, "bin") + "/"), "runtime descriptor points at the installed release");
        const bad = [];
        for (const step of journal.steps.filter(x => x.kind === "file")) {
          const bytes = await readBytes(step.dest);
          if (bytes === null) bad.push(`${rel(step.dest, paths.appHome)} is missing`);
          else if (hashOf(bytes) !== step.hash) bad.push(`${rel(step.dest, paths.appHome)} was changed`);
        }
        for (const step of journal.steps.filter(x => x.kind === "config")) {
          const bytes = await readBytes(step.path);
          let present = false;
          try { present = bytes !== null && getAt(parseDoc(bytes.toString("utf8")), step.at)?.some(e => deepEqual(e, step.value)) === true; } catch { /* unparsable counts as missing */ }
          if (!present) bad.push(`${step.harness} settings entry ${step.at.join(".")} is missing`);
        }
        const deps = journal.steps.find(x => x.kind === "deps");
        for (const dep of bundle.runtimeDependencies) if (deps && !(await readBytes(join(journal.roots.releaseDir, "node_modules", dep, "package.json")))) bad.push(`dependency ${dep} is missing`);
        for (const detail of bad.slice(0, 8)) line(false, detail);
        line(bad.length === 0, "installed files, settings entries and dependencies are intact");
        const helper = await check(descriptor.node, [join(journal.roots.releaseDir, "bin/herdr-session-meta.mjs"), "doctor", "--json", "--app-home", paths.appHome, "--state-root", paths.stateRoot], { cwd: paths.appHome });
        line(helper.code === 0, "installed helper runs");
        const parsed = (() => { try { return JSON.parse(helper.stdout); } catch { return null; } })();
        if (parsed) say(`info activation mode: ${parsed.mode}`);
      }
      return ok ? 0 : 1;
    }

    if (o.command === "install") {
      const npm = await check("npm", ["--version"]).catch(() => null);
      if (!npm || npm.code !== 0) pre.errors.push({ rule: "npm", message: "npm was not found next to this Node; it is needed to install the helper's pinned dependencies." }), pre.ok = false;
    }
    if (!pre.ok) { for (const e of pre.errors) stderr(`${e.message}\n`); stderr("preflight failed; nothing was written\n"); return 1; }
    const plan = await planInstall({ bundle, sourceRoot, ...paths, node, harnesses, configureHarnesses: o.configure, adopt: o.adopt });
    for (const w of pre.warnings) say(`warn ${w.message}`);
    for (const w of plan.warnings) say(`warn ${w.rule}: ${rel(w.path, home)}${w.harness ? ` (re-run with --configure-harnesses ${w.harness} to update it)` : ""}`);
    for (const b of plan.blockers) {
      const hint = b.rule === "harness-adoption-required" ? ` (review it, then re-run with --adopt --configure-harnesses ${b.harness})`
        : b.rule === "ambiguous-harness-entry" ? ` (review the existing ${b.harness} integration; --adopt cannot overwrite it)`
        : b.harness ? ` (include --configure-harnesses ${b.harness})` : "";
      stderr(`blocked: ${b.rule}${b.path ? " " + rel(b.path, home) : ""}${hint}\n`);
    }

    if (o.command === "plan") {
      const counts = {};
      for (const f of plan.files) counts[f.action] = (counts[f.action] ?? 0) + 1;
      say(`plan ${plan.id.slice(0, 12)}: ${plan.files.length} files (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`);
      say(`dependencies: ${plan.dependencies.status} (npm ci --ignore-scripts in the release folder)`);
      if (o.configure.length) for (const e of plan.configEdits) say(`config ${e.status}: ${rel(e.path, home)} ${e.at.join(".")}`);
      else say("harness settings: not changed (add --configure-harnesses opencode,claude to opt in)");
      say("no changes were made. Run `herdr-workspace install` to apply.");
      say(`after installing, select the layout yourself: herdr-app do layout.switch '{"name":"herdr-workspace"}'`);
      return plan.blockers.length ? 1 : 0;
    }
    if (plan.blockers.length) { stderr("install refused; nothing was written\n"); return 1; }
    const receipt = await applyInstall(plan, { run: check });
    say(`installed ${receipt.steps.length} step(s); phase ${receipt.phase}`);
    say(`select the layout when ready: herdr-app do layout.switch '{"name":"herdr-workspace"}'`);
    if (!o.configure.length) say("harness settings were not changed; re-run with --configure-harnesses to opt in");
    return 0;
  } catch (e) {
    stderr(`error: ${e.message}\n`);
    return 1;
  }
}
