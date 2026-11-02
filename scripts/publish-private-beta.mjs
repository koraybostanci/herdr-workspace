#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishPrivateBeta } from "./lib/private-release.mjs";

const usage = "usage: node scripts/publish-private-beta.mjs --directory <verified-artifacts> [--source-root <checkout>] [--repo <owner/repo>] [--native-host-home <Herdr-home>] [--publish]";
try {
  const args = process.argv.slice(2), options = { sourceRoot: resolve(fileURLToPath(new URL("../", import.meta.url))) };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") { console.log(usage); process.exit(0); }
    if (flag === "--publish") { options.publish = true; continue; }
    const key = { "--directory": "directory", "--source-root": "sourceRoot", "--repo": "repo", "--native-host-home": "nativeHostHome" }[flag];
    if (!key || !args[index + 1] || args[index + 1].startsWith("--")) throw Error(usage);
    options[key] = args[++index];
  }
  if (!options.directory) throw Error(usage);
  const result = await publishPrivateBeta(options);
  console.log(`${result.mode}: ${result.repo} ${result.tag} at ${result.commit}`);
  if (result.url) console.log(result.url);
  else console.log("No release was written. Add --publish to run all validation gates and publish the verified private prerelease.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
