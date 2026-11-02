#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseArchive, verifyReleaseDirectory } from "./lib/release.mjs";

async function main(args) {
  let result;
  if (args.length === 2 && args[0] === "--directory") result = await verifyReleaseDirectory(args[1]);
  else if (args.length === 1 && !args[0].startsWith("--")) {
    const info = await lstat(args[0]);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("Archive must be a regular file of at most 64 MiB.");
    result = verifyReleaseArchive(await readFile(args[0]));
  } else throw new Error("Usage: verify-release.mjs ARCHIVE.tar.gz | --directory DIR");
  console.log(`Verified ${result.manifest.version} from ${result.manifest.sourceCommit}: ${result.files.size} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`Release verification failed: ${error.message}`); process.exitCode = 1; }
}
