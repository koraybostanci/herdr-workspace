import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assetRefsOf, loadBundle, validateBundle } from "../src/bundle.mjs";
import { exportBundle, repoRoot } from "./helpers/bundle-export.mjs";

const rules = result => result.issues.map(i => i.rule);

test("shipped bundle validates", async () => {
  const bundle = await loadBundle(repoRoot);
  assert.equal(bundle.owner, "herdr-workspace");
  assert.deepEqual(await validateBundle(bundle, repoRoot), { ok: true, issues: [] });
});

test("runtime_import_and_asset_closure_complete", async t => {
  for (const [omit, rule] of [
    ["integrations/session-metadata/src/scope.mjs", "missing-file"],
    ["mods/space-agents/pull-request.svg", "missing-file"],
  ]) {
    const root = await exportBundle(t);
    await rm(join(root, omit));
    const result = await validateBundle(await loadBundle(root), root);
    assert.equal(result.ok, false, omit);
    assert.ok(rules(result).includes(rule), `${omit}: ${rules(result)}`);
  }
});

test("undeclared imports and assets are reported even when the file exists", async t => {
  const root = await exportBundle(t);
  const bundle = await loadBundle(root);
  delete bundle.files["integrations/session-metadata/src/scope.mjs"];
  const result = await validateBundle(bundle, root);
  assert.ok(result.issues.some(i => i.rule === "unresolved-import" && i.to.endsWith("src/scope.mjs")), JSON.stringify(result.issues));
  const root2 = await exportBundle(t);
  await writeFile(join(root2, "mods/space-agents/main.js"), (await readFile(join(root2, "mods/space-agents/main.js"), "utf8")) + '\nsvg("mods/nope/missing.svg");\nimport "left-pad";\n');
  const result2 = await validateBundle(await loadBundle(root2), root2);
  assert.ok(rules(result2).includes("undeclared-asset"));
  assert.ok(rules(result2).includes("undeclared-dependency"));
  assert.ok(rules(result2).includes("hash-mismatch"));
});

test("traversal and symlinks are refused", async t => {
  const root = await exportBundle(t);
  const bundle = await loadBundle(root);
  bundle.files["../outside.txt"] = "0".repeat(64);
  assert.ok(rules(await validateBundle(bundle, root)).includes("unsafe-path"));
  const root2 = await exportBundle(t);
  await rm(join(root2, "mods/space-agents/pull-request.svg"));
  await symlink("/etc/hosts", join(root2, "mods/space-agents/pull-request.svg"));
  assert.ok(rules(await validateBundle(await loadBundle(root2), root2)).includes("unsafe-path"));
});

test("layout_uses_only_declared_mods", async t => {
  const bundle = await loadBundle(repoRoot);
  const layout = JSON.parse(await readFile(join(repoRoot, "layouts/herdr-workspace.json"), "utf8"));
  const used = new Set();
  (function walk(node) { if (node.content?.mod) used.add(node.content.mod); (node.children ?? []).forEach(walk); })(layout);
  const declared = new Set([...bundle.mods.map(m => m.name), ...bundle.host.mods.map(m => m.name)]);
  assert.deepEqual([...used].filter(name => !declared.has(name)), []);
  assert.equal(layout.id, "root");
  const root = await exportBundle(t);
  layout.children[0].children[0].content.mod = "not-declared";
  await writeFile(join(root, "layouts/herdr-workspace.json"), JSON.stringify(layout));
  assert.ok(rules(await validateBundle(await loadBundle(root), root)).includes("undeclared-layout-mod"));
});

test("owned protocol/client/model copies stay byte identical", async () => {
  const bundle = await loadBundle(repoRoot);
  for (const [a, b] of bundle.parity) assert.equal(await readFile(join(repoRoot, a), "utf8"), await readFile(join(repoRoot, b), "utf8"), `${a} == ${b}`);
  assert.ok(bundle.parity.length >= 1);
});

test("global program icons do not require a fake host mod and cannot escape icons", async () => {
  const bundle = await loadBundle(repoRoot);
  assert.ok(!(await validateBundle(bundle, repoRoot)).issues.some(i => i.rule === "asset-without-host-mod"));
  for (const asset of ["icons/../other.svg", "other/file.svg"]) {
    const result = await validateBundle({ ...bundle, host: { ...bundle.host, assets: [...bundle.host.assets, asset] } }, repoRoot);
    assert.ok(result.issues.some(i => i.rule === "asset-without-host-mod" && i.asset === asset));
  }
});

test("static frame images are required host assets", async () => {
  assert.deepEqual(assetRefsOf('image("frame/welcome/herdr.png"); svg("icons/claude.svg");'), ["frame/welcome/herdr.png", "icons/claude.svg"]);
  const bundle = await loadBundle(repoRoot);
  assert.ok(bundle.host.assets.includes("frame/welcome/herdr.png"));
  const missing = { ...bundle, host: { ...bundle.host, assets: bundle.host.assets.filter(asset => asset !== "frame/welcome/herdr.png") } };
  assert.ok((await validateBundle(missing, repoRoot)).issues.some(issue => issue.rule === "undeclared-asset" && issue.asset === "frame/welcome/herdr.png"));
});

test("host asset declarations cannot escape their supported resource directories", async () => {
  const bundle = await loadBundle(repoRoot);
  for (const asset of ["frame/../other.png", "frame/welcome/../../outside.png", "mods/undeclared/no.svg", "mods/files/../outside.svg", "frame/welcome/link.js"]) {
    const result = await validateBundle({ ...bundle, host: { ...bundle.host, assets: [...bundle.host.assets, asset] } }, repoRoot);
    assert.ok(result.issues.some(issue => issue.rule === "asset-without-host-mod" && issue.asset === asset), asset);
  }
});
