import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { testTmpRoot } from "./tmp-root.mjs";

// Synthetic Herdr app home holding only the declared built-in mods, assets and type files.
export async function hostFixture(t, bundle, { omitMods = [], omitAssets = [] } = {}) {
  const appHome = await mkdtemp(join(testTmpRoot(), "host-"));
  t?.after(() => rm(appHome, { recursive: true, force: true }));
  const put = async (path, text = "{}\n") => { await mkdir(dirname(join(appHome, path)), { recursive: true }); await writeFile(join(appHome, path), text); };
  for (const mod of bundle.host.mods) {
    if (omitMods.includes(mod.name)) continue;
    for (const file of mod.files) await put(`mods/${mod.name}/${file}`);
  }
  for (const asset of bundle.host.assets) if (!omitAssets.includes(asset)) await put(asset, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  return appHome;
}

// Controlled external-command runner. `tools` maps a command name to { code, stdout } or null for "not installed".
export function fakeRun(tools = {}) {
  const calls = [];
  const run = async (command, args = []) => {
    calls.push([command, ...args]);
    const key = command.split("/").pop();
    const tool = key === "node" ? tools.node ?? { code: 0, stdout: "" } : tools[key];
    if (tool === undefined || tool === null) { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; }
    const match = tool[args.join(" ")] ?? tool;
    return { code: match.code ?? 0, stdout: match.stdout ?? "", stderr: match.stderr ?? "" };
  };
  run.calls = calls;
  return run;
}
