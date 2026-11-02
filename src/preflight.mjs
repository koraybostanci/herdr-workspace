import { access } from "node:fs/promises";
import { join } from "node:path";

const OPTIONAL_TOOLS = {
  git: "Git context (branch and repository on agent cards) is unavailable.",
  gh: "Verified pull request links are unavailable; install gh and sign in to enable them. The UI installs and runs without it.",
};

function major(version) { return Number(/^v?(\d+)/.exec(version ?? "")?.[1] ?? 0); }
function numericVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match ? match.slice(1).map(BigInt) : null;
}
function compareVersions(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function tryRun(run, command, args) {
  try { return await run(command, args); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}

// Read-only checks. Never authenticates, installs or writes.
export async function preflight({ bundle, appHome, node, run, platform = process.platform }) {
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

  const policy = typeof bundle.requires.herdr === "string" ? /^>=\s*(.+)$/.exec(bundle.requires.herdr)?.[1] : null;
  const minimum = numericVersion(policy);
  if (!minimum) errors.push({ rule: "host-policy", message: `Unsupported requires.herdr policy ${JSON.stringify(bundle.requires.herdr) ?? "(missing)"}; expected >=x.y.z. Install a bundle with a valid Herdr minimum version.` });

  const host = await tryRun(run, "herdr-app", ["--version"]).catch(() => null);
  const found = host?.code === 0 && typeof host.stdout === "string" ? host.stdout.trim().replace(/^herdr-app\s+/, "").replace(/^v/, "") : "";
  const version = numericVersion(found);
  if (!version) errors.push({ rule: "host-version", message: "Could not verify the Herdr version. Install and launch Herdr desktop, ensure herdr-app is on PATH, then check `herdr-app --version` and retry." });
  else if (minimum && compareVersions(version, minimum) < 0) errors.push({ rule: "host-version", message: `Herdr ${found} is too old; ${bundle.requires.herdr} is required. Upgrade Herdr desktop, launch it, then check \`herdr-app --version\` on PATH and retry.` });
  else if (found !== bundle.host.version) warnings.push({ rule: "host-version", message: `Herdr ${found} is unverified; ${bundle.host.version} is the tested version. Compatibility with this version has not been verified.` });
  if (!Array.isArray(bundle.requires.platforms) || !bundle.requires.platforms.includes(platform)) errors.push({ rule: "platform", message: `Unsupported platform ${platform}; this bundle requires macOS (darwin).` });

  for (const [tool, message] of Object.entries(OPTIONAL_TOOLS)) {
    const result = await tryRun(run, tool, ["--version"]).catch(() => null);
    if (!result || result.code !== 0) { warnings.push({ rule: "optional-tool", tool, message }); continue; }
    if (tool === "gh") {
      const auth = await tryRun(run, "gh", ["auth", "status"]).catch(() => null);
      if (!auth || auth.code !== 0) warnings.push({ rule: "optional-tool", tool, message: `gh is not signed in. ${message}` });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
