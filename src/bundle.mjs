import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix } from "node:path";

export const BUNDLE_OWNER = "herdr-workspace";
const HOST_MODULES = new Set(["herdr", "gpui-kit", "gpui-base"]);
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);
const SKIP_FILES = new Set([".DS_Store", "gpui-kit.d.ts", "herdr.d.ts"]);
const RUNTIME_CODE = /^(mods\/.+\.js|integrations\/session-metadata\/(?:src|bin|claude|opencode)\/.+\.(?:mjs|js))$/;

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function loadBundle(root) {
  const bundle = JSON.parse(await readFile(join(root, "bundle.json"), "utf8"));
  if (bundle.schema !== 1 || bundle.owner !== BUNDLE_OWNER) throw new Error("Unsupported bundle manifest");
  return bundle;
}

function safeRelative(path) {
  return typeof path === "string" && path !== "" && !isAbsolute(path) && !path.includes("\\") && normalize(path) === path
    && !path.split("/").includes("..") && !path.startsWith("./");
}

// Expands bundle.include (files or directories) into a sorted relative file list.
export async function expandInclude(root, include) {
  const out = new Set();
  async function walk(rel) {
    const info = await lstat(join(root, rel));
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in bundle: ${rel}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, rel))).sort()) if (!SKIP_DIRS.has(name) && !SKIP_FILES.has(name)) await walk(posix.join(rel, name));
    } else if (info.isFile()) out.add(rel);
  }
  for (const entry of include) await walk(entry);
  return [...out].sort();
}

export async function buildFileHashes(root, include) {
  const files = {};
  for (const path of await expandInclude(root, include)) files[path] = sha256(await readFile(join(root, path)));
  return files;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\'"`])\/\/[^\n]*/g, "$1");
}
export function importsOf(text) {
  const code = stripComments(text), specs = new Set();
  for (const re of [/\bfrom\s*(["'])([^"'\n]+)\1/g, /(?:^|[;\s])import\s*(["'])([^"'\n]+)\1/g, /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g]) {
    for (const m of code.matchAll(re)) specs.add(m[2]);
  }
  return [...specs];
}
export function assetRefsOf(text) {
  const refs = new Set();
  for (const m of text.matchAll(/(["'`])(mods\/[A-Za-z0-9_-]+\/(?:(?!\1)[^\n])*?\.(?:svg|png|webp|json|js))\1/g)) refs.add(m[2].replace(/\$\{[^}]*\}/g, "*"));
  return [...refs];
}
export function overlayModsOf(text) {
  return [...stripComments(text).matchAll(/\bmod\s*:\s*(["'])([A-Za-z0-9_-]+)\1/g)].map(m => m[2]);
}

function globToRegExp(glob) { return new RegExp("^" + glob.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$"); }

export async function validateBundle(bundle, root) {
  const issues = [], add = (rule, extra) => issues.push({ rule, ...extra });
  const declared = new Set(Object.keys(bundle.files ?? {}));
  const ownedMods = new Set((bundle.mods ?? []).map(m => m.name));
  const hostMods = new Set((bundle.host?.mods ?? []).map(m => m.name));
  const hostAssets = new Set(bundle.host?.assets ?? []);
  const patterns = (bundle.host?.assetPatterns ?? []).map(globToRegExp);
  const dependencies = new Set(bundle.runtimeDependencies ?? []);
  const harnessModules = new Set(bundle.harnessModules ?? []);
  const texts = new Map();

  for (const [path, hash] of Object.entries(bundle.files ?? {})) {
    if (!safeRelative(path)) { add("unsafe-path", { path }); continue; }
    let info;
    try { info = await lstat(join(root, path)); } catch { add("missing-file", { path }); continue; }
    if (info.isSymbolicLink() || !info.isFile()) { add("unsafe-path", { path }); continue; }
    const bytes = await readFile(join(root, path));
    if (sha256(bytes) !== hash) add("hash-mismatch", { path });
    texts.set(path, bytes.toString("utf8"));
  }
  // Content can also be changed in a way the manifest hash does not know about only if the file is undeclared.
  for (const path of Object.keys(bundle.files ?? {})) {
    if (!texts.has(path) && issues.every(i => i.path !== path)) add("missing-file", { path });
  }

  for (const [path, text] of texts) {
    if (!RUNTIME_CODE.test(path)) continue;
    for (const spec of importsOf(text)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        const target = posix.normalize(posix.join(dirname(path), spec));
        if (!declared.has(target)) add("unresolved-import", { from: path, to: target });
        continue;
      }
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!HOST_MODULES.has(name) && !dependencies.has(name) && !harnessModules.has(spec) && !harnessModules.has(name)) add("undeclared-dependency", { from: path, spec });
    }
    for (const ref of assetRefsOf(text)) {
      const owner = ref.split("/")[1];
      if (ownedMods.has(owner)) { if (!ref.includes("*") && !declared.has(ref)) add("undeclared-asset", { from: path, asset: ref }); }
      else if (ref.includes("*")) { if (!(bundle.host?.assetPatterns ?? []).includes(ref)) add("undeclared-asset", { from: path, asset: ref }); }
      else if (!hostAssets.has(ref)) add("undeclared-asset", { from: path, asset: ref });
    }
    for (const name of overlayModsOf(text)) if (!ownedMods.has(name) && !hostMods.has(name)) add("undeclared-overlay-mod", { from: path, name });
  }
  for (const asset of hostAssets) if (!hostMods.has(asset.split("/")[1])) add("asset-without-host-mod", { asset });
  for (const pattern of patterns) if (![...hostAssets].some(a => pattern.test(a))) add("empty-asset-pattern", { pattern: String(pattern) });

  for (const mod of bundle.mods ?? []) {
    for (const required of ["mod.json", "main.js"]) if (!declared.has(`mods/${mod.name}/${required}`)) add("missing-file", { path: `mods/${mod.name}/${required}` });
  }
  for (const helper of bundle.helper?.entries ?? []) if (!declared.has(helper)) add("missing-file", { path: helper });
  for (const path of bundle.helper?.manifests ?? []) if (!declared.has(path)) add("missing-file", { path });

  const layoutPath = bundle.layout?.path;
  if (!declared.has(layoutPath)) add("missing-file", { path: layoutPath });
  else if (texts.has(layoutPath)) {
    try {
      const layout = JSON.parse(texts.get(layoutPath));
      (function walk(node) {
        const name = node?.content?.mod;
        if (name && !ownedMods.has(name) && !hostMods.has(name)) add("undeclared-layout-mod", { name });
        for (const child of node?.children ?? []) walk(child);
      })(layout);
    } catch { add("invalid-layout", { path: layoutPath }); }
  }

  for (const [a, b] of bundle.parity ?? []) {
    if (texts.get(a) === undefined || texts.get(b) === undefined || texts.get(a) !== texts.get(b)) add("parity-mismatch", { a, b });
  }
  return { ok: issues.length === 0, issues };
}
