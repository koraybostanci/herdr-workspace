#!/usr/bin/env node
// Regenerates the content hashes in bundle.json from its `include` list.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileHashes } from "../src/bundle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const path = join(root, "bundle.json");
const bundle = JSON.parse(await readFile(path, "utf8"));
bundle.files = await buildFileHashes(root, bundle.include);
await writeFile(path, JSON.stringify(bundle, null, 2) + "\n");
console.log(`bundle.json: ${Object.keys(bundle.files).length} files`);
