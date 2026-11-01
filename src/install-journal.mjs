import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ABSENT, OWNER, isEmptyDoc, applyEntryToText, configKey, hashOf, readBytes, readJournal, removeEntryFromText } from "./install-common.mjs";

export { readJournal } from "./install-common.mjs";

// Compare-before-write: refuses when the destination changed since `expectedHash` was read.
export async function writeGuarded(path, data, expectedHash, { mode = 0o600 } = {}) {
  const current = await readBytes(path);
  if (hashOf(current) !== expectedHash) throw new Error("config-changed-concurrently");
  if (current !== null && !(await lstat(path)).isFile()) throw new Error("foreign-config-path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fileMode = current === null ? mode : (await stat(path)).mode & 0o777;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { flag: "wx", mode: fileMode });
    if (hashOf(await readBytes(path)) !== expectedHash) throw new Error("config-changed-concurrently");
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

async function saveJournal(journal) {
  const path = journal.roots.journalPath;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(journal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

async function backupOf(plan, bytes, counter) {
  const dir = join(plan.roots.dataDir, "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${Date.now()}-${counter}.bak`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, hash: hashOf(bytes) };
}

function isNoop(plan) {
  return plan.files.every(f => f.action === "unchanged") && plan.configEdits.every(e => e.status === "present") && plan.dependencies.status === "staged";
}

// Records every intended change, plus the original ownership data, before anything is written.
async function createJournal(plan, previous) {
  const carry = previous?.phase === "installed" ? previous : null;
  const prevFile = new Map((carry?.steps ?? []).filter(s => s.kind === "file").map(s => [s.dest, s]));
  const prevConfig = new Map((carry?.steps ?? []).filter(s => s.kind === "config").map(s => [configKey(s.path, s.at), s]));
  const journal = { schema: 1, owner: OWNER, id: plan.id, buildHash: plan.buildHash, phase: "applying", pending: null, roots: plan.roots, steps: [], configFiles: {} };
  let counter = 0;
  const fileStep = async file => {
    const old = prevFile.get(file.dest);
    if (file.action === "preserve") return null;
    if (file.action === "remove") return { kind: "retire-file", dest: file.dest, beforeHash: file.beforeHash, backup: file.backup ?? null, applied: false };
    if (file.action === "unchanged") return old ? { ...old, applied: true } : null;
    const step = { kind: "file", dest: file.dest, hash: file.hash, beforeHash: file.beforeHash, mode: file.mode, backup: old?.backup ?? null, applied: false };
    if (file.action === "adopt") step.backup = await backupOf(plan, await readFile(file.dest), counter++);
    return step;
  };
  const add = step => { if (step) journal.steps.push(step); };
  for (const file of plan.files.filter(f => f.group === "release")) add(await fileStep(file));
  const prevDeps = (carry?.steps ?? []).find(s => s.kind === "deps");
  add({ kind: "deps", dir: plan.roots.releaseDir, applied: plan.dependencies.status === "staged" && Boolean(prevDeps?.applied) });
  add({ kind: "state-init", applied: false });
  for (const file of plan.files.filter(f => f.group !== "release")) add(await fileStep(file));

  const planned = new Set();
  for (const edit of plan.configEdits) {
    const key = configKey(edit.path, edit.at);
    planned.add(key);
    const old = prevConfig.get(key);
    if (edit.status === "present") { if (old) add({ ...old, applied: true }); continue; }
    add({ kind: "config", harness: edit.harness, path: edit.path, at: edit.at, value: edit.value, previous: edit.previous,
      createdArray: old?.createdArray ?? edit.createdArray, createdParent: old?.createdParent ?? edit.createdParent, applied: false });
  }
  for (const [key, step] of prevConfig) if (!planned.has(key)) add({ ...step, applied: true });
  const planDests = new Set(plan.files.map(f => f.dest));
  for (const [dest, step] of prevFile) if (!planDests.has(dest)) add({ ...step, applied: true });

  for (const step of journal.steps.filter(s => s.kind === "config")) {
    if (journal.configFiles[step.path]) continue;
    const old = carry?.configFiles?.[step.path];
    if (old) { journal.configFiles[step.path] = old; continue; }
    const bytes = await readBytes(step.path);
    journal.configFiles[step.path] = bytes === null ? { existed: false, afterHash: ABSENT }
      : { existed: true, beforeHash: hashOf(bytes), afterHash: hashOf(bytes), backup: (await backupOf(plan, bytes, counter++)).path };
  }
  return journal;
}

async function applyFile(plan, step, writeText) {
  const file = plan.files.find(f => f.dest === step.dest);
  if (!file) throw new Error("install-plan-drift");
  const current = hashOf(await readBytes(step.dest));
  if (current === step.hash) return;
  if (current !== step.beforeHash) throw new Error("config-changed-concurrently");
  let data = file.text;
  if (file.src) {
    data = await readFile(join(plan.sourceRoot, file.src));
    if (hashOf(data) !== file.hash) throw new Error("source-changed");
  }
  await writeText(step.dest, data, current, { mode: step.mode });
}

async function stageState(plan) {
  const { createStore } = await import(pathToFileURL(join(plan.roots.releaseDir, "src/store.mjs")).href);
  await createStore({ root: plan.roots.stateRoot, viewFile: join(plan.roots.appHome, "data/space-agents/session-view.json") }).listBindings();
}

export async function applyInstall(plan, { run, writeText = writeGuarded } = {}) {
  if (plan.blockers?.length) throw new Error(`install-blocked: ${[...new Set(plan.blockers.map(b => b.rule))].join(", ")}`);
  const previous = await readJournal(plan.roots.journalPath);
  if (previous?.phase === "uninstalling") throw new Error("pending-uninstall");
  if (previous?.phase === "applying" && previous.id !== plan.id) throw new Error("pending-install-differs");
  if (previous?.phase === "installed" && previous.id === plan.id && isNoop(plan)) return previous;

  const journal = previous?.phase === "applying" ? previous : await createJournal(plan, previous);
  await saveJournal(journal);
  const progress = async (step, description, action) => {
    journal.pending = description;
    await saveJournal(journal);
    await action();
    step.applied = true;
    journal.pending = null;
    await saveJournal(journal);
  };

  for (const step of journal.steps) {
    if (step.applied) continue;
    if (step.kind === "file") await progress(step, step.dest, () => applyFile(plan, step, writeText));
    else if (step.kind === "retire-file") {
      await progress(step, step.dest, async () => {
        const current = hashOf(await readBytes(step.dest));
        if (current === ABSENT || step.backup && current === step.backup.hash) return;
        if (current !== step.beforeHash) throw new Error("config-changed-concurrently");
        if (step.backup) {
          const bytes = await readBytes(step.backup.path);
          if (!bytes || hashOf(bytes) !== step.backup.hash) throw new Error("retired-backup-missing");
          await writeText(step.dest, bytes, current);
        } else await unlink(step.dest);
      });
    }
    else if (step.kind === "deps") {
      await progress(step, "dependencies", async () => {
        const result = await run("npm", ["ci", "--ignore-scripts"], { cwd: step.dir });
        if (result.code !== 0) throw new Error("dependency-install-failed");
        for (const dep of plan.dependencies.required) {
          if (!(await readBytes(join(step.dir, "node_modules", dep, "package.json")))) throw new Error("dependency-install-failed");
        }
      });
    } else if (step.kind === "state-init") await progress(step, "state-init", () => stageState(plan));
    else if (step.kind === "config") {
      await progress(step, step.path, async () => {
        const bytes = await readBytes(step.path);
        const text = bytes === null ? null : bytes.toString("utf8");
        const next = applyEntryToText(text, step);
        if (next !== text) await writeText(step.path, next, hashOf(bytes), { mode: 0o600 });
        // Whole-file restore on uninstall is only valid while the file is exactly what we last wrote.
        const info = journal.configFiles[step.path];
        info.afterHash = info.afterHash !== null && hashOf(bytes) === info.afterHash ? hashOf(next) : null;
      });
    }
  }
  journal.phase = "installed";
  await saveJournal(journal);
  return journal;
}

async function prune(dir, appHome) {
  const keep = new Set([appHome, ...["mods", "layouts", "integrations", "data"].map(d => join(appHome, d))]);
  while (dir.startsWith(appHome + sep) && !keep.has(dir)) {
    try { await rmdir(dir); } catch { return; }
    dir = dirname(dir);
  }
}

// Removes only what is still exactly as installed. Modified files, later edits and private state stay.
export async function uninstall(receipt, { writeText = writeGuarded } = {}) {
  const journal = await readJournal(receipt.roots.journalPath);
  if (!journal) throw new Error("install-journal-unavailable");
  if (journal.phase === "uninstalled") return { phase: "uninstalled", kept: journal.kept ?? [], removed: [] };
  journal.phase = "uninstalling";
  await saveJournal(journal);
  const kept = [], removed = [], { appHome, releaseDir } = journal.roots;

  const byPath = new Map();
  for (const step of journal.steps.filter(s => s.kind === "config")) byPath.set(step.path, [...(byPath.get(step.path) ?? []), step]);
  for (const [path, steps] of byPath) {
    const bytes = await readBytes(path);
    if (bytes === null) continue;
    const info = journal.configFiles[path], current = hashOf(bytes);
    const backup = info?.existed ? await readBytes(info.backup) : null;
    if (info && current === info.afterHash && (!info.existed || backup && hashOf(backup) === info.beforeHash)) {
      if (info.existed) await writeText(path, backup, current);
      else await unlink(path);
      removed.push(path);
      continue;
    }
    let text = bytes.toString("utf8");
    for (const step of [...steps].reverse()) {
      const result = removeEntryFromText(text, step);
      text = result.text;
      if (result.outcome === "modified") kept.push({ path, reason: "modified" });
    }
    if (text === bytes.toString("utf8")) continue;
    if (info && !info.existed && isEmptyDoc(text)) await unlink(path);
    else await writeText(path, text, current);
    removed.push(path);
  }

  const fileSteps = journal.steps.filter(s => s.kind === "file" || s.kind === "retire-file" && !s.applied)
    .map(s => s.kind === "retire-file" ? { ...s, hash: s.beforeHash } : s).reverse();
  for (const step of fileSteps) {
    const bytes = await readBytes(step.dest);
    if (bytes === null) continue;
    const current = hashOf(bytes);
    if (step.kind === "retire-file" && current === step.backup?.hash) continue;
    if (current !== step.hash) { kept.push({ path: step.dest, reason: "modified" }); continue; }
    if (step.backup) {
      const backup = await readBytes(step.backup.path);
      if (!backup || hashOf(backup) !== step.backup.hash) { kept.push({ path: step.dest, reason: "backup-missing" }); continue; }
      await writeText(step.dest, backup, current);
    } else await unlink(step.dest);
    removed.push(step.dest);
  }
  if (journal.steps.some(s => s.kind === "deps") && releaseDir.startsWith(join(appHome, "integrations/session-metadata/releases") + sep)) {
    await rm(join(releaseDir, "node_modules"), { recursive: true, force: true });
  }
  for (const step of fileSteps) await prune(dirname(step.dest), appHome);

  journal.phase = "uninstalled";
  journal.kept = kept;
  await saveJournal(journal);
  void chmod;
  return { phase: "uninstalled", kept, removed };
}
