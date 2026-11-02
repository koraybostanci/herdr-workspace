#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./lib/release.mjs";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Cannot inspect Git source. Install Git and use a source repository with a committed HEAD.");
  return result.stdout.trim();
}

async function main(args) {
  let sourceRoot = fileURLToPath(new URL("../", import.meta.url)), outputDirectory;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--source-root", "--output"].includes(flag) || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Usage: build-release.mjs [--source-root DIR] --output DIR. Unknown or duplicate options are not allowed; there is no dirty-tree bypass.");
    seen.add(flag);
    if (flag === "--source-root") sourceRoot = resolve(args[++index]);
    else outputDirectory = resolve(args[++index]);
  }
  if (!outputDirectory) throw new Error("--output DIR is required. Use a new directory outside the source checkout.");
  sourceRoot = await realpath(sourceRoot);
  if (await realpath(git(sourceRoot, ["rev-parse", "--show-toplevel"])) !== sourceRoot) throw new Error("--source-root must be the Git repository root.");
  if (git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) throw new Error("A clean Git tree is required. Commit or move pending changes before building; there is no dirty-tree bypass.");
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
  const result = await buildRelease({ sourceRoot, outputDirectory, commit, requireCommittedSource: true });
  console.log(`Built ${result.version} from ${commit}: ${result.archivePath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`Release build failed: ${error.message}`); process.exitCode = 1; }
}
