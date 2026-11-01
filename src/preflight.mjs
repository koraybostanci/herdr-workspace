import { access } from "node:fs/promises";
import { join } from "node:path";

const OPTIONAL_TOOLS = {
  git: "Git context (branch and repository on agent cards) is unavailable.",
  gh: "Verified pull request links are unavailable; install gh and sign in to enable them. The UI installs and runs without it.",
};

function major(version) { return Number(/^v?(\d+)/.exec(version ?? "")?.[1] ?? 0); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function tryRun(run, command, args) {
  try { return await run(command, args); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}

// Read-only checks. Never authenticates, installs or writes.
export async function preflight({ bundle, appHome, node, run }) {
  const errors = [], warnings = [];
  const need = Number(/(\d+)/.exec(bundle.requires.node)?.[1] ?? 0);

  if (major(node?.version) < need) errors.push({ rule: "node-version", message: `Node ${bundle.requires.node} is required; found ${node?.version ?? "unknown"}.` });
  else if (bundle.requires.nodeBuiltins.length) {
    const probe = await tryRun(run, node.path, ["-e", bundle.requires.nodeBuiltins.map(m => `require(${JSON.stringify(m)})`).join(";")]);
    if (!probe || probe.code !== 0) errors.push({ rule: "node-sqlite", message: `This Node cannot load ${bundle.requires.nodeBuiltins.join(", ")}.` });
  }

  for (const mod of bundle.host.mods) {
    for (const file of mod.files) {
      if (!(await exists(join(appHome, "mods", mod.name, file)))) { errors.push({ rule: "missing-host-mod", name: mod.name, message: `Herdr built-in mod "${mod.name}" is missing (${file}).` }); break; }
    }
  }
  for (const asset of bundle.host.assets) {
    if (!(await exists(join(appHome, asset)))) errors.push({ rule: "missing-host-asset", asset, message: `Herdr asset ${asset} is missing.` });
  }

  const host = await tryRun(run, "herdr-app", ["--version"]);
  const found = /(\d+\.\d+\.\d+)/.exec(host?.stdout ?? "")?.[1];
  if (!found) warnings.push({ rule: "host-version", message: "Could not read the Herdr version; only Herdr 0.1.9 on macOS is verified." });
  else if (found !== bundle.host.version) warnings.push({ rule: "host-version", message: `Herdr ${found} is unverified; ${bundle.host.version} is the tested version.` });
  if (process.platform !== "darwin") warnings.push({ rule: "platform", message: "Only macOS is verified." });

  for (const [tool, message] of Object.entries(OPTIONAL_TOOLS)) {
    const result = await tryRun(run, tool, ["--version"]);
    if (!result || result.code !== 0) { warnings.push({ rule: "optional-tool", tool, message }); continue; }
    if (tool === "gh") {
      const auth = await tryRun(run, "gh", ["auth", "status"]);
      if (!auth || auth.code !== 0) warnings.push({ rule: "optional-tool", tool, message: `gh is not signed in. ${message}` });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
