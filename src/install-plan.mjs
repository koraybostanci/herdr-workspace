import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateBundle } from "./bundle.mjs";
import { ABSENT, OWNER, symlinkedBelow, applyEntryToText, configKey, deepEqual, getAt, hashOf, journalPathFor, parseDoc, readJournal } from "./install-common.mjs";

const HELPER = "integrations/session-metadata";
const HELPER_OWNER = "herdr-session-metadata";
const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "CwdChanged", "Stop", "SessionEnd"];
const sortedBy = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// A state root we do not own (non-empty and without our owner marker) must be refused before anything is written.
async function stateRootProblem(root) {
  let info;
  try { info = await lstat(root); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (info.isSymbolicLink() || !info.isDirectory()) return "foreign-state-root";
  const names = await readdir(root);
  if (names.length === 0) return null;
  try {
    const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
    return owner?.owner === HELPER_OWNER && owner.schema === 1 ? null : "foreign-state-root";
  } catch { return "foreign-state-root"; }
}

async function inspect(path) {
  let info;
  try { info = await lstat(path); } catch (e) { if (e.code === "ENOENT") return { hash: ABSENT }; throw e; }
  if (!info.isFile()) return { foreign: true };
  return { hash: hashOf(await readFile(path)) };
}

function desiredEntries(name, { releaseDir, node, appHome, stateRoot }) {
  if (name === "opencode") {
    return [{ at: ["plugins"], value: { package: releaseDir, options: { appHome, stateRoot } } }];
  }
  const hook = { hooks: [{ type: "command", command: node, args: [join(releaseDir, "bin/herdr-session-meta.mjs"), "hook", "claude"], timeout: 10, onFailure: "continue" }] };
  return CLAUDE_EVENTS.map(event => ({ at: ["hooks", event], value: hook }));
}

// Pure planning: reads the destination, never writes. `sourceRoot` is kept as a non-enumerable property so it is never printed.
export async function planInstall({ bundle, sourceRoot, appHome, stateRoot, node, harnesses = {}, configureHarnesses = [], adopt = false }) {
  const blockers = [], warnings = [];
  for (const issue of (await validateBundle(bundle, sourceRoot)).issues) blockers.push({ rule: "invalid-bundle", detail: issue.rule, path: issue.path ?? issue.from ?? issue.a });
  const selected = [...new Set(configureHarnesses)].sort();
  for (const name of selected) if (!["opencode", "claude"].includes(name)) blockers.push({ rule: "unknown-harness", name });

  const releaseFiles = {};
  for (const [path, hash] of Object.entries(bundle.files)) if (path.startsWith(HELPER + "/")) releaseFiles[path.slice(HELPER.length + 1)] = hash;
  const entries = Object.entries(releaseFiles).sort(sortedBy);
  const buildHash = hashOf(JSON.stringify(entries));
  const releaseId = [0, 8, 12, 16, 20].map((start, i) => buildHash.slice(start, [8, 12, 16, 20, 32][i])).join("-");
  const releaseDir = join(appHome, HELPER, "releases", releaseId);
  const roots = { appHome, stateRoot, releaseDir, dataDir: join(appHome, "data/herdr-workspace"), journalPath: journalPathFor(appHome) };
  const id = createHash("sha256").update(JSON.stringify({ buildHash, node, appHome, stateRoot, harnesses: selected.map(n => [n, harnesses[n === "opencode" ? "opencodePath" : "claudePath"]]) })).digest("hex").slice(0, 32);

  let previous = null;
  try { previous = await readJournal(roots.journalPath); } catch { blockers.push({ rule: "foreign-journal", path: roots.journalPath }); }
  if (previous?.phase === "uninstalling") blockers.push({ rule: "pending-uninstall", path: roots.journalPath });
  const owned = previous && ["applying", "installed"].includes(previous.phase) ? previous : null;
  // Hashes we may overwrite: what we wrote, plus (while resuming an interrupted apply) what the file held before that write.
  const ownedFile = new Map((owned?.steps ?? []).filter(s => s.kind === "file").map(s => [s.dest, new Set([s.hash, owned.phase === "applying" ? s.beforeHash : null].filter(h => h && h !== ABSENT))]));
  const ownedConfig = new Map((owned?.steps ?? []).filter(s => s.kind === "config").map(s => [configKey(s.path, s.at), s]));

  const manifestText = JSON.stringify({ owner: HELPER_OWNER, schema: 1, protocol: 2, files: Object.fromEntries(entries), buildHash }, null, 2) + "\n";
  const descriptorText = JSON.stringify({ schema: 1, owner: HELPER_OWNER, node, helperPath: join(releaseDir, "bin/herdr-session-meta.mjs"), stateRoot, buildHash }, null, 2) + "\n";
  const wanted = [
    ...entries.map(([rel, hash]) => ({ group: "release", src: `${HELPER}/${rel}`, dest: join(releaseDir, rel), hash, mode: 0o600 })),
    { group: "release", src: null, dest: join(releaseDir, "build-manifest.json"), hash: hashOf(manifestText), text: manifestText, mode: 0o600 },
    ...Object.entries(bundle.files).filter(([path]) => /^(mods|layouts)\//.test(path)).sort(sortedBy)
      .map(([path, hash]) => ({ group: "host", src: path, dest: join(appHome, path), hash, mode: 0o644 })),
    { group: "descriptor", src: null, dest: join(appHome, "data/space-agents/runtime.json"), hash: hashOf(descriptorText), text: descriptorText, mode: 0o600 },
  ];
  const files = [];
  const reportedLinks = new Set();
  const linkBlocker = async dest => {
    const link = await symlinkedBelow(appHome, dest);
    if (link && !reportedLinks.has(link)) { reportedLinks.add(link); blockers.push({ rule: "symlinked-path", path: link }); }
    return Boolean(link);
  };
  const state = await stateRootProblem(stateRoot);
  if (state) blockers.push({ rule: state, path: stateRoot });
  for (const file of wanted) {
    if (await linkBlocker(file.dest)) { files.push({ ...file, action: "blocked", beforeHash: null }); continue; }
    const current = await inspect(file.dest);
    let action;
    if (current.foreign) { blockers.push({ rule: "foreign-file", path: file.dest }); action = "blocked"; }
    else if (current.hash === ABSENT) action = "create";
    else if (current.hash === file.hash) action = "unchanged";
    else if (ownedFile.get(file.dest)?.has(current.hash)) action = "update";
    else if (adopt) action = "adopt";
    else { blockers.push({ rule: "foreign-file", path: file.dest }); action = "blocked"; }
    files.push({ ...file, action, beforeHash: current.hash ?? null });
  }

  const retired = new Set(["data/session-plans/runtime.json", ...["client.js", "protocol.js", "plan-controller.js", "plan-model.js"].map(name => "mods/session-tabs/" + name)].map(path => join(appHome, path)));
  for (const step of owned?.steps ?? []) {
    if (step.kind !== "file" || !(retired.has(step.dest) || step.dest.startsWith(join(appHome, "mods/plan") + "/"))) continue;
    if (await linkBlocker(step.dest)) continue;
    const current = await inspect(step.dest);
    if (current.hash !== ABSENT && current.hash !== step.hash) {
      warnings.push({ rule: "modified-retired-file", path: step.dest });
      files.push({ group: "retired", dest: step.dest, action: "preserve" });
      continue;
    }
    files.push({ group: "retired", dest: step.dest, action: "remove", beforeHash: step.hash, backup: step.backup });
  }

  const unselected = new Set();
  for (const step of ownedConfig.values()) {
    const selectedPath = harnesses[step.harness === "opencode" ? "opencodePath" : "claudePath"];
    if (selected.includes(step.harness) && selectedPath === step.path || unselected.has(step.harness)) continue;
    if (!step.value?.options?.planNode && !step.value?.hooks?.some(hook => hook.args?.includes("--plans"))) continue;
    blockers.push({ rule: "plan-removal-needs-harness-upgrade", path: step.path, harness: step.harness });
    unselected.add(step.harness);
  }

  const configEdits = [], configFiles = {};
  for (const name of selected) {
    const path = harnesses[name === "opencode" ? "opencodePath" : "claudePath"];
    if (!path) { blockers.push({ rule: "missing-harness-path", name }); continue; }
    const current = await inspect(path);
    if (current.foreign) { blockers.push({ rule: "foreign-file", path }); continue; }
    let text = current.hash === ABSENT ? null : (await readFile(path)).toString("utf8");
    configFiles[path] = { existed: text !== null, beforeHash: current.hash };
    try {
      parseDoc(text);
      for (const entry of desiredEntries(name, { releaseDir, node, appHome, stateRoot })) {
        const list = getAt(parseDoc(text), entry.at);
        if (list !== undefined && !Array.isArray(list)) throw new Error("invalid-config");
        const step = ownedConfig.get(configKey(path, entry.at));
        const old = [step?.previous, step?.value].find(c => c !== undefined && list?.some(e => deepEqual(e, c)));
        const edit = { harness: name, path, at: entry.at, value: entry.value };
        if (list?.some(e => deepEqual(e, entry.value))) edit.status = "present";
        else {
          edit.status = old !== undefined && list?.some(e => deepEqual(e, old)) ? "replace" : "add";
          if (edit.status === "replace") edit.previous = old;
          edit.createdArray = list === undefined;
          edit.createdParent = entry.at.length > 1 && getAt(parseDoc(text), entry.at.slice(0, -1)) === undefined;
          text = applyEntryToText(text, edit);
        }
        configEdits.push(edit);
      }
      const prefix = join(appHome, HELPER, "releases") + "/";
      const remains = name === "opencode"
        ? getAt(parseDoc(text), ["plugins"])?.some(entry => typeof entry?.package === "string" && entry.package.startsWith(prefix) && entry.options?.planNode)
        : Object.values(parseDoc(text).hooks ?? {}).some(groups => Array.isArray(groups) && groups.some(group => group?.hooks?.some(hook =>
          Array.isArray(hook.args) && typeof hook.args[0] === "string" && hook.args[0].startsWith(prefix) && hook.args.includes("--plans"))));
      if (remains) blockers.push({ rule: "modified-plan-harness-entry", path, harness: name });
    } catch (e) {
      if (e.message !== "invalid-config") throw e;
      blockers.push({ rule: "invalid-config", path });
    }
  }

  const required = bundle.runtimeDependencies;
  let staged = true;
  for (const dep of required) if ((await inspect(join(releaseDir, "node_modules", dep, "package.json"))).hash === ABSENT) staged = false;

  const plan = { schema: 1, owner: OWNER, id, buildHash, roots, files, configEdits, configFiles, dependencies: { required, status: staged ? "staged" : "missing" }, blockers, warnings };
  Object.defineProperty(plan, "sourceRoot", { value: sourceRoot, enumerable: false });
  return plan;
}
