import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testTmpRoot } from "./tmp-root.mjs";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Copies only the files declared by bundle.json (bundled files, installer files and bundle.json itself) into a fresh directory.
export async function exportBundle(t, { omit = [] } = {}) {
  const { loadBundle, expandInclude } = await import("../../src/bundle.mjs");
  const bundle = await loadBundle(repoRoot);
  const dest = await mkdtemp(join(testTmpRoot(), "export-"));
  t?.after(() => rm(dest, { recursive: true, force: true }));
  const installer = await expandInclude(repoRoot, bundle.installer ?? []);
  for (const path of ["bundle.json", ...installer, ...Object.keys(bundle.files)]) {
    if (omit.includes(path)) continue;
    await mkdir(dirname(join(dest, path)), { recursive: true });
    await cp(join(repoRoot, path), join(dest, path));
  }
  return dest;
}
