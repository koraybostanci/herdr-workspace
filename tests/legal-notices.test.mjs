import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFileHashes, sha256 } from "../src/bundle.mjs";
import { planInstall } from "../src/install-plan.mjs";
import { applyInstall } from "../src/install-journal.mjs";
import { repoRoot } from "./helpers/bundle-export.mjs";
import { installHome, NODE } from "./helpers/install-home.mjs";

const UPSTREAM = "https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2";
// Independently verified against the pinned upstream LICENSE, including its appendix.
const APACHE_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";
const LUCIDE = "https://raw.githubusercontent.com/lucide-icons/lucide/f12b0de177fbc2a6795e99be065887e72b237123";
const LUCIDE_LICENSE_SHA256 = "1e7290b35280a048667bbf0ebabac1c7fd52a75300e8b2946ac165715997f2bc";
const ICONS = [
  ["pull-request.svg", "git-pull-request.svg", "6dbc18c42d08f225e3fc0a34fe5bf62d8b2abae83ada8163f3bbb649f2b8d25f"],
  ["trash.svg", "trash-2.svg", "e63698acf757d3043fcb4a9ea6ffceff9dd84708707eafc879c86b34a6ff2786"],
];
const MODS = [
  ["compact-spaces", "spaces"],
  ["space-agents", "agents"],
  ["session-tabs", "tabs"],
  ["workspace-header", "workspace-chrome"],
];

test("source distribution retains the full Apache license and owner notice", async () => {
  assert.equal(sha256(await readFile(join(repoRoot, "LICENSE"))), APACHE_SHA256);
  const notice = await readFile(join(repoRoot, "NOTICE"), "utf8");
  assert.match(notice, /Copyright \(c\) 2026 koraybostanci/);
  assert.ok(notice.includes(UPSTREAM + "/LICENSE"), "notice identifies the licensed upstream source");
});

test("source distribution retains the icon license from the exact pinned Lucide revision", async () => {
  const license = await readFile(join(repoRoot, "licenses/Lucide-0.468.0.txt")).catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
  assert.notEqual(license, null, "the actual icon revision's full license must accompany the archive");
  assert.equal(sha256(license), LUCIDE_LICENSE_SHA256);
});

for (const [file, source, hash] of ICONS) {
  test(`${file} is an unmodified copy of the pinned canonical Lucide icon`, async () => {
    const bytes = await readFile(join(repoRoot, "mods/space-agents", file));
    assert.equal(sha256(bytes), hash, `${source} must match the independently verified upstream bytes`);
    assert.match(bytes.toString(), /viewBox="0 0 24 24"/);
    assert.match(bytes.toString(), /stroke="currentColor"/);
  });
}

test("the project logo identifies its known-source workspace glyph without changing its document size", async () => {
  const logo = await readFile(join(repoRoot, "assets/logo.svg"), "utf8");
  const header = logo.match(/^<!--[\s\S]*?-->/)?.[0] ?? "";
  assert.ok(header.includes(`${LUCIDE}/icons/panels-top-left.svg`), "the modified logo must carry its pinned glyph provenance");
  assert.match(header, /Modified by koraybostanci/);
  assert.match(logo, /<svg\b[^>]*width="128"[^>]*height="128"[^>]*viewBox="0 0 128 128"/);
  assert.match(logo, /<title\b[^>]*>herdr-workspace<\/title>/);
  assert.doesNotMatch(logo, /<(?:image|script)\b|\b(?:href|onload)=/i, "the document mark must not pull in external artwork or code");
});

test("asset provenance inventory describes the exact SVG bytes shipped to recipients", async () => {
  const text = await readFile(join(repoRoot, "licenses/assets.json"), "utf8").catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
  assert.notEqual(text, null, "ship an auditable asset source and modification inventory");
  const inventory = JSON.parse(text);
  assert.equal(inventory.revision, "f12b0de177fbc2a6795e99be065887e72b237123");
  assert.equal(inventory.license.source, `${LUCIDE}/LICENSE`);
  assert.equal(inventory.license.sha256, LUCIDE_LICENSE_SHA256);
  assert.deepEqual(inventory.assets.map(asset => asset.path).sort(), ["assets/logo.svg", "mods/space-agents/pull-request.svg", "mods/space-agents/trash.svg"]);
  for (const asset of inventory.assets) {
    assert.equal(sha256(await readFile(join(repoRoot, asset.path))), asset.shippedSha256, asset.path);
    assert.ok(asset.source.startsWith(`${LUCIDE}/icons/`));
    assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/);
    if (asset.path.startsWith("mods/")) {
      assert.equal(asset.shippedSha256, asset.sourceSha256, "control icons are unchanged canonical copies");
      assert.deepEqual(asset.modifications, []);
    } else {
      assert.equal(asset.sourceSha256, "321a2a5500f2b814a2e62eb73c4b01dc65c7334fe2e6f7d77517239383e26bb1");
      assert.notEqual(asset.shippedSha256, asset.sourceSha256);
      assert.ok(asset.modifications.length > 0);
    }
  }
});

// Build the current include tree in memory: the bundle integrity suite separately
// checks the checked-in hashes. This test catches lost legal files at installation,
// not a pending manifest refresh during development.
for (const [name, upstream] of MODS) {
  test(`installed ${name} retains its full license, provenance and modification notice`, async t => {
    const h = await installHome(t);
    const bundle = { ...h.bundle, files: await buildFileHashes(h.sourceRoot, h.bundle.include) };
    const plan = await planInstall({ bundle, sourceRoot: h.sourceRoot, appHome: h.appHome, stateRoot: h.stateRoot, node: NODE });
    assert.deepEqual(plan.blockers, []);
    const receipt = await applyInstall(plan, { run: h.run });
    assert.equal(receipt.phase, "installed");
    const dir = join(h.appHome, "mods", name);
    const license = await h.read(join(dir, "LICENSE"));
    assert.notEqual(license, null, "installed mod must carry its full license");
    assert.equal(sha256(license), APACHE_SHA256);
    const notice = await h.read(join(dir, "NOTICE"));
    assert.notEqual(notice, null, "installed mod must carry attribution independently of the checkout");
    assert.match(notice, /Copyright \(c\) 2026 koraybostanci/);
    assert.ok(notice.includes(`${UPSTREAM}/defaults/mods/${upstream}/main.js`), "installed notice identifies the actual upstream source");
    const source = await h.read(join(dir, "main.js"));
    const header = source.match(/^\/\*[\s\S]*?\*\//)?.[0] ?? "";
    assert.match(header, /SPDX-License-Identifier: Apache-2\.0/);
    assert.match(header, /Modified by koraybostanci\b/, "derived file must prominently identify modifications");
    assert.ok(header.includes(`${UPSTREAM}/defaults/mods/${upstream}/main.js`), "derived file must retain provenance when separated from other files");
    for (const file of ["LICENSE", "NOTICE"]) {
      assert.ok(receipt.steps.some(step => step.kind === "file" && step.dest === join(dir, file)), `${file} is installer-owned`);
    }
    if (name === "space-agents") {
      const tree = await h.read(join(dir, "space-tree.js"));
      const treeHeader = tree.match(/^\/\*[\s\S]*?\*\//)?.[0] ?? "";
      assert.match(treeHeader, /Modified by koraybostanci/);
      assert.match(treeHeader, /SPDX-License-Identifier: Apache-2\.0/);
      assert.ok(treeHeader.includes(`${UPSTREAM}/defaults/mods/spaces/main.js`));
      const iconLicense = await readFile(join(repoRoot, "licenses/Lucide-0.468.0.txt"), "utf8");
      assert.ok(notice.includes(iconLicense), "installed mod retains the complete license from its actual icon revision");
      for (const [file, source, hash] of ICONS) {
        assert.equal(sha256(await readFile(join(dir, file))), hash, "installed icons retain verified source bytes");
        assert.ok(notice.includes(`${LUCIDE}/icons/${source}`), "installed provenance must work without the checkout");
      }
      assert.match(notice, /Lucide Contributors 2022/, "retain the existing icon attribution");
      assert.match(notice, /Cole Bemis/);
      assert.match(notice, /Permission to use, copy, modify, and\/or distribute/);
      assert.match(notice, /Permission is hereby granted, free of charge/);
      assert.match(notice, /OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE/);
    }
  });
}
