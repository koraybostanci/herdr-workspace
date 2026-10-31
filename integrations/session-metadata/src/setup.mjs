import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { OWNER } from "./contracts.mjs";
import { createStore, atomicJson, readJson } from "./store.mjs";

export const hashText = text => createHash("sha256").update(text).digest("hex");
const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "CwdChanged", "Stop", "SessionEnd"];
const capabilityGates = ["opencode", "claude", "metadataSdk", "noPlatformBinaries"];
export const activationGates = [...capabilityGates, "opencodeRegistration", "opencodeRename", "claudeRegistration", "claudeRename", "claudeLiveTitle", "repoIsolation", "sessionSwitch", "nativeInteraction", "nativeCheck", "tests"];
function document(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration document");
  return value;
}
function change(text, path, value) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
}
function listAt(doc, path) { return path.reduce((v, k) => v?.[k], doc); }
export function planInstall(current, options) {
  const plugin = join(options.appHome ?? join(options.home, ".config/herdr-app"), "integrations/session-metadata");
  const hook = { hooks: [{ type: "command", command: options.node ?? "node", args: [join(plugin, "bin/herdr-session-meta.mjs"), "hook", "claude"], timeout: 10, onFailure: "continue" }] };
  const edits = [];
  for (const [name, path, additions] of [
    ["opencode", options.opencodePath, [{ at: ["plugins"], value: plugin }]],
    ["claude", options.claudePath, events.map(event => ({ at: ["hooks", event], value: hook }))],
  ]) {
    const before = current[name] ?? "{}\n";
    let text = before;
    const ownedEntries = [];
    for (const { at, value } of additions) {
      const doc = document(text), list = listAt(doc, at);
      if (list !== undefined && !Array.isArray(list)) throw new Error("Expected configuration array");
      if (list?.some(v => JSON.stringify(v) === JSON.stringify(value) || name === "opencode" && v?.package === value)) continue;
      text = change(text, list ? [...at, list.length] : at, list ? value : [value]);
      ownedEntries.push({ path, at, value, createdArray: list === undefined, createdHooks: name === "claude" && doc.hooks === undefined });
    }
    if (text !== before) edits.push({ path, beforeHash: hashText(before), afterText: text, ownedEntries });
  }
  return { edits, syncWasEnabled: options.syncWasEnabled, requiredGates: activationGates,
    stateRoot: options.stateRoot, viewFile: options.viewFile, activationRequirements: ["Native browser/keyboard and full/collapsed card verification", "Claude hooks apply to new/resumed sessions; do not restart existing agents", ...(options.activationRequirements ?? [])] };
}
async function textAt(path) { return readFile(path, "utf8").catch(e => { if (e.code === "ENOENT") return "{}\n"; throw e; }); }
async function replaceText(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, text, { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
async function save(manifest) { await atomicJson(manifest.manifestPath, manifest); return manifest; }
function requireGates(names, gates) {
  const missing = names.filter(name => gates[name] !== true);
  if (missing.length) throw new Error(`Verification gates missing: ${missing.join(", ")}`);
}
export async function applyInstall(plan, expectedHashes, gates) {
  requireGates(capabilityGates, gates);
  for (const edit of plan.edits) if (expectedHashes[edit.path] !== edit.beforeHash || hashText(await textAt(edit.path)) !== edit.beforeHash) throw new Error("Configuration changed concurrently");
  const store = createStore({ root: plan.stateRoot, viewFile: plan.viewFile });
  await store.listBindings();
  const pointer = await readJson(join(plan.stateRoot, "current-install.json"));
  const previous = pointer?.owner === OWNER && typeof pointer.manifestPath === "string"
    && pointer.manifestPath.startsWith(join(plan.stateRoot, "installs") + "/") ? await readJson(pointer.manifestPath) : null;
  // Never install active, even if a previous partial attempt left an activation marker.
  await atomicJson(join(plan.stateRoot, "activation.json"), { schema: 1, owner: OWNER, mode: "observe" });
  const id = randomUUID(), backupDir = join(plan.stateRoot, "installs", id);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const manifest = { schema: 1, owner: OWNER, id, phase: "observing", stateRoot: plan.stateRoot, viewFile: plan.viewFile,
    manifestPath: join(backupDir, "manifest.json"), ownedEntries: [...new Map([...(previous?.owner === OWNER && previous.phase !== "rolled-back" ? previous.ownedEntries : []), ...plan.edits.flatMap(e => e.ownedEntries)].map(e => [JSON.stringify(e), e])).values()], backups: [],
    syncWasEnabled: previous?.owner === OWNER && previous.phase !== "rolled-back" ? previous.syncWasEnabled : plan.syncWasEnabled, gates: Object.fromEntries(capabilityGates.map(k => [k, gates[k] === true])), activationRequirements: plan.activationRequirements,
    requiredGates: plan.requiredGates };
  for (let i = 0; i < plan.edits.length; i++) {
    const e = plan.edits[i], backupPath = join(backupDir, `${i}.json.backup`);
    await writeFile(backupPath, await textAt(e.path), { mode: 0o600, flag: "wx" });
    manifest.backups.push({ path: e.path, hash: e.beforeHash, backupPath });
  }
  await save(manifest);
  for (const e of plan.edits) {
    if (hashText(await textAt(e.path)) !== e.beforeHash) throw new Error("Configuration changed concurrently; observe-only manifest retained");
    await replaceText(e.path, e.afterText);
  }
  await atomicJson(join(plan.stateRoot, "current-install.json"), { owner: OWNER, manifestPath: manifest.manifestPath });
  return manifest;
}
export async function activateInstall(manifest, gates) {
  if (manifest.owner !== OWNER || !["observing", "verified", "sync-disabled"].includes(manifest.phase)) throw new Error("Invalid install phase");
  requireGates(manifest.requiredGates, gates);
  manifest.gates = Object.fromEntries(manifest.requiredGates.map(k => [k, true]));
  manifest.phase = "verified"; await save(manifest);
  try {
    if (manifest.syncWasEnabled && await gates.disableSync?.() !== true) throw new Error("Could not disable old sync");
    manifest.phase = "sync-disabled"; await save(manifest);
    await atomicJson(join(manifest.stateRoot, "activation.json"), { schema: 1, owner: OWNER, mode: "active", installId: manifest.id });
    manifest.phase = "active"; manifest.activationRequirements = [];
    return await save(manifest);
  } catch (e) {
    await atomicJson(join(manifest.stateRoot, "activation.json"), { schema: 1, owner: OWNER, mode: "observe" });
    if (manifest.syncWasEnabled) await gates.restoreSync?.();
    manifest.phase = "observing"; await save(manifest);
    throw e;
  }
}
export async function rollbackInstall(manifest, options = {}) {
  if (manifest.owner !== OWNER || manifest.schema !== 1) throw new Error("Foreign install manifest");
  const wasActive = ["active", "sync-disabled", "verified"].includes(manifest.phase);
  await atomicJson(join(manifest.stateRoot, "activation.json"), { schema: 1, owner: OWNER, mode: "observe" });
  const paths = [...new Set(manifest.ownedEntries.map(e => e.path))];
  for (const path of paths) {
    const before = await textAt(path);
    let text = before;
    for (const entry of manifest.ownedEntries.filter(e => e.path === path)) {
      const list = listAt(document(text), entry.at);
      const index = Array.isArray(list) ? list.findIndex(value => JSON.stringify(value) === JSON.stringify(entry.value)) : -1;
      if (index >= 0) text = change(text, [...entry.at, index], undefined);
    }
    for (const entry of manifest.ownedEntries.filter(e => e.path === path && e.createdArray)) {
      const list = listAt(document(text), entry.at);
      if (Array.isArray(list) && list.length === 0) text = change(text, entry.at, undefined);
    }
    if (manifest.ownedEntries.some(e => e.path === path && e.createdHooks)) {
      const hooks = document(text).hooks;
      if (hooks && Object.keys(hooks).length === 0) text = change(text, ["hooks"], undefined);
    }
    if (text !== before) {
      if (await textAt(path) !== before) throw new Error("Configuration changed during rollback");
      await replaceText(path, text);
    }
  }
  if (manifest.viewFile) {
    const view = await readJson(manifest.viewFile);
    if (view?.owner === OWNER) await unlink(manifest.viewFile);
  }
  if (wasActive && manifest.syncWasEnabled) {
    if (!options.restoreSync) throw new Error("Restore old sync before completing rollback");
    await options.restoreSync();
  }
  manifest.phase = "rolled-back"; await save(manifest);
}
