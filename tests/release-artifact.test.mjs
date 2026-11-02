import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { testTmpRoot } from "./helpers/tmp-root.mjs";
import { buildRelease, exportBundleTo, verifyReleaseArchive, verifyReleaseDirectory } from "../scripts/lib/release.mjs";
import { publishPrivateBeta } from "../scripts/lib/private-release.mjs";

const VERSION = "0.1.0-beta.1", COMMIT = "a".repeat(40), ROOT = `herdr-workspace-${VERSION}`;
const buildCli = fileURLToPath(new URL("../scripts/build-release.mjs", import.meta.url));
const verifyCli = fileURLToPath(new URL("../scripts/verify-release.mjs", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const distribution = ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY.md", "licenses", "assets/logo.svg", "docs/installation.md", "docs/limitations.md", "docs/private-beta.md", "docs/release-process.md", "scripts"];
const expectedFiles = [".npmrc", "LICENSE", "NOTICE", "README.md", "THIRD_PARTY.md", "assets/logo.svg", "bin/install.mjs", "bundle.json", "docs/installation.md", "docs/limitations.md", "docs/private-beta.md", "docs/release-process.md", "layouts/herdr-workspace.json", "licenses/example.txt", "mods/example/main.js", "mods/example/mod.json", "package-lock.json", "package.json", "scripts/tool.mjs", "src/install.mjs"].sort();

async function fixture(t) {
  const base = await mkdtemp(join(testTmpRoot(), "release-owned-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, "source"), outputDirectory = join(base, "output");
  const put = async (path, text) => {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), text);
  };
  const pkg = { name: "herdr-workspace", version: VERSION, private: true, type: "module", repository: { type: "git", url: "git+https://github.com/koraybostanci/herdr-workspace.git" } };
  const lock = { name: pkg.name, version: VERSION, lockfileVersion: 3, packages: { "": { name: pkg.name, version: VERSION } } };
  const runtime = { "layouts/herdr-workspace.json": "{}\n", "mods/example/main.js": "export const ready = true;\n", "mods/example/mod.json": "{}\n" };
  const bundle = { schema: 1, owner: "herdr-workspace", version: VERSION, include: ["layouts", "mods"], installer: ["bin", "src", "package.json", "package-lock.json", ".npmrc"], distributionFiles: [...distribution], files: Object.fromEntries(Object.entries(runtime).map(([path, text]) => [path, sha(text)])), layout: { path: "layouts/herdr-workspace.json" }, mods: [{ name: "example" }] };
  for (const [path, text] of Object.entries(runtime)) await put(path, text);
  await put("package.json", json(pkg)); await put("package-lock.json", json(lock)); await put("bundle.json", json(bundle));
  await put("bin/install.mjs", "#!/usr/bin/env node\nconsole.log('ready');\n");
  await chmod(join(sourceRoot, "bin/install.mjs"), 0o755);
  await put("src/install.mjs", "export const install = () => true;\n");
  await put(".npmrc", "ignore-scripts=true\n");
  for (const path of distribution.filter(path => !["licenses", "scripts"].includes(path))) await put(path, "Public release resource.\n");
  await put("licenses/example.txt", "Example license notice.\n");
  await put("scripts/tool.mjs", "console.log('release tool');\n");
  await put("developer-only.txt", "Not distributed.\n");
  await put(".env", "PRIVATE_FIXTURE=not-for-export\n");
  return { sourceRoot, outputDirectory, put, bundle, pkg, lock, build: () => buildRelease({ sourceRoot, outputDirectory, commit: COMMIT }) };
}

function pack(tar) { const out = gzipSync(tar, { level: 9 }); out[9] = 255; return out; }
function commitFixture(f) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = args => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", f.sourceRoot, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(["init", "--initial-branch=release-fixture"]); git(["add", "."]); git(["commit", "-m", "Synthetic release fixture"]);
  return { env, git, head: git(["rev-parse", "HEAD"]) };
}
function entries(tar) {
  const result = [];
  for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
    const size = parseInt(tar.toString("ascii", offset + 124, offset + 135), 8);
    result.push({ offset, size, name: tar.toString("utf8", offset, offset + 100).split("\0")[0], length: 512 + Math.ceil(size / 512) * 512 });
    offset += result.at(-1).length;
  }
  return result;
}
function checksum(tar, offset) {
  tar.fill(32, offset + 148, offset + 156);
  let sum = 0; for (const byte of tar.subarray(offset, offset + 512)) sum += byte;
  tar.write(sum.toString(8).padStart(6, "0") + "\0 ", offset + 148, 8, "ascii");
}
function rename(tar, entry, name) {
  tar.fill(0, entry.offset, entry.offset + 100);
  tar.write(name, entry.offset, "ascii"); checksum(tar, entry.offset);
}

function replaceManifest(tar, change) {
  const entry = entries(tar).find(e => e.name.endsWith("/RELEASE.json"));
  const manifest = JSON.parse(tar.subarray(entry.offset + 512, entry.offset + 512 + entry.size));
  change(manifest);
  const bytes = Buffer.from(json(manifest)), header = Buffer.from(tar.subarray(entry.offset, entry.offset + 512));
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); checksum(header, 0);
  return Buffer.concat([tar.subarray(0, entry.offset), header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), tar.subarray(entry.offset + entry.length)]);
}

test("release build is deterministic, exact, private-data-free and independently verifiable", async t => {
  const f = await fixture(t), first = await f.build();
  assert.equal(first.version, VERSION); assert.equal(first.tag, `v${VERSION}`); assert.equal(first.rootName, ROOT);
  assert.deepEqual((await readdir(f.outputDirectory)).sort(), ["SHA256SUMS", `${ROOT}.manifest.json`, `${ROOT}.tar.gz`].sort());
  const archive = await readFile(first.archivePath), standalone = await readFile(first.manifestPath);
  const verified = verifyReleaseArchive(archive, { expectedSha256: sha(archive) });
  assert.deepEqual([...verified.files.keys()].sort(), [...expectedFiles, "RELEASE.json"].sort());
  assert.deepEqual(Object.keys(verified.manifest.files).sort(), expectedFiles);
  assert.equal(verified.files.get("RELEASE.json").equals(standalone), true);
  assert.deepEqual(verified.manifest, { schema: 1, owner: "herdr-workspace", version: VERSION, sourceCommit: COMMIT, repository: "koraybostanci/herdr-workspace", rootDirectory: ROOT, files: first.manifest.files });
  assert.deepEqual(verified.manifest.files["bin/install.mjs"], { sha256: sha("#!/usr/bin/env node\nconsole.log('ready');\n"), mode: 0o755 });
  assert.equal(verified.manifest.files["src/install.mjs"].mode, 0o644);
  const payload = [...verified.files.values()].map(bytes => bytes.toString()).join("\n");
  for (const needle of [f.sourceRoot, process.env.HOME, "PRIVATE_FIXTURE", "developer-only"]) assert.equal(payload.includes(needle), false);
  await chmod(join(f.sourceRoot, "src/install.mjs"), 0o600);
  const second = await buildRelease({ sourceRoot: f.sourceRoot, outputDirectory: join(dirname(f.outputDirectory), "second"), commit: COMMIT });
  assert.deepEqual(await readFile(second.archivePath), archive);
  assert.deepEqual(await readFile(second.manifestPath), standalone);
  assert.deepEqual(await readFile(second.checksumsPath), await readFile(first.checksumsPath));
});

test("base exporter excludes distribution/developer files and preserves old script API", async t => {
  const f = await fixture(t), dest = join(dirname(f.sourceRoot), "export");
  assert.equal(await exportBundleTo(f.sourceRoot, dest), dest);
  const paths = [];
  async function walk(dir, prefix = "") {
    for (const name of await readdir(dir)) {
      const info = await lstat(join(dir, name)); assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) await walk(join(dir, name), prefix + name + "/"); else paths.push(prefix + name);
    }
  }
  await walk(dest);
  assert.deepEqual(paths.sort(), expectedFiles.filter(path => !path.startsWith("docs/") && !path.startsWith("licenses/") && !path.startsWith("scripts/") && !path.startsWith("assets/") && !["README.md", "LICENSE", "NOTICE", "THIRD_PARTY.md"].includes(path)));
  const legacy = await import("../scripts/test-clean-install.mjs");
  assert.equal(legacy.exportBundleTo, exportBundleTo);
});

test("release refuses collisions without overwriting existing output", async t => {
  const f = await fixture(t), result = await f.build(), before = await readFile(result.archivePath);
  await assert.rejects(f.build(), /exist|collision/i);
  assert.deepEqual(await readFile(result.archivePath), before);
});

test("release requires exact package, lockfile and bundle versions and a full commit", async t => {
  for (const target of ["package", "lock", "lock-root", "bundle", "commit"]) await t.test(target, async t => {
    const f = await fixture(t);
    if (target === "package") { f.pkg.version = "0.2.0"; await f.put("package.json", json(f.pkg)); }
    if (target === "lock") { f.lock.version = "0.2.0"; await f.put("package-lock.json", json(f.lock)); }
    if (target === "lock-root") { f.lock.packages[""].version = "0.2.0"; await f.put("package-lock.json", json(f.lock)); }
    if (target === "bundle") { f.bundle.version = "../../bad"; await f.put("bundle.json", json(f.bundle)); }
    await assert.rejects(buildRelease({ sourceRoot: f.sourceRoot, outputDirectory: f.outputDirectory, commit: target === "commit" ? "abc123" : COMMIT }), /version|commit/i);
    assert.equal(await lstat(f.outputDirectory).then(() => true, () => false), false);
  });
});

test("release requires complete distribution resources, repository metadata and hash closure", async t => {
  for (const target of ["missing-field", "missing-resource", "omitted-legal", "hash", "undeclared", "repository"]) await t.test(target, async t => {
    const f = await fixture(t);
    if (target === "missing-field") delete f.bundle.distributionFiles;
    if (target === "missing-resource") await rm(join(f.sourceRoot, "LICENSE"));
    if (target === "omitted-legal") f.bundle.distributionFiles = distribution.filter(path => path !== "LICENSE");
    if (target === "hash") await f.put("mods/example/main.js", "changed\n");
    if (target === "undeclared") await f.put("mods/example/extra.js", "undeclared\n");
    if (target === "repository") { delete f.pkg.repository; await f.put("package.json", json(f.pkg)); }
    await f.put("bundle.json", json(f.bundle));
    await assert.rejects(f.build(), /distribution|resource|missing|hash|closure|repository|include/i);
    assert.equal(await lstat(f.outputDirectory).then(() => true, () => false), false);
  });
});

test("release rejects unsafe include declarations, private paths and symlink ancestors", async t => {
  const cases = ["../escape", "/absolute", "C:/drive", "docs/../LICENSE", "docs\\file", ".git/config", "node_modules/sdk/index.js", "state/catalog.json", "credentials.json", "docs/.env", "docs/private.key", "symlink-file", "symlink-parent"];
  for (const target of cases) await t.test(target, async t => {
    const f = await fixture(t);
    if (target === "symlink-file") {
      await symlink(join(f.sourceRoot, "LICENSE"), join(f.sourceRoot, "scripts/link"));
    } else if (target === "symlink-parent") {
      await symlink(join(f.sourceRoot, "src"), join(f.sourceRoot, "linked"));
      f.bundle.distributionFiles.push("linked/install.mjs");
    } else f.bundle.distributionFiles.push(target);
    await f.put("bundle.json", json(f.bundle));
    await assert.rejects(f.build(), /unsafe|private|symlink/i);
  });
});

test("release scans packaged content without revealing secret values", async t => {
  for (const secret of ["gh" + "p_" + "X".repeat(40), "/Users/" + "private-person/project", "https://user:" + "secret-password@invalid.example"]) await t.test("redacted content rejection", async t => {
    const f = await fixture(t); await f.put("README.md", secret);
    await assert.rejects(f.build(), error => /private|privacy|content/i.test(error.message) && !error.message.includes(secret));
    assert.equal(await lstat(f.outputDirectory).then(() => true, () => false), false);
  });
});

test("base export rejects symlinks and escaping bundle file paths before writing", async t => {
  for (const target of ["symlink", "traversal"]) await t.test(target, async t => {
    const f = await fixture(t), dest = join(dirname(f.sourceRoot), "export");
    if (target === "symlink") { await rm(join(f.sourceRoot, "src/install.mjs")); await symlink(join(f.sourceRoot, "LICENSE"), join(f.sourceRoot, "src/install.mjs")); }
    else { f.bundle.files["../escape"] = "0".repeat(64); await f.put("bundle.json", json(f.bundle)); }
    await assert.rejects(exportBundleTo(f.sourceRoot, dest), /unsafe|symlink/i);
    assert.equal(await lstat(dest).then(() => true, () => false), false);
  });
});

test("release rejects reserved manifest aliases and file/directory conflicts", async t => {
  for (const path of ["release.json", "RELEASE.json/nested.json"]) await t.test(path, async t => {
    const f = await fixture(t); await f.put(path, "not a manifest\n");
    f.bundle.distributionFiles.push(path); await f.put("bundle.json", json(f.bundle));
    await assert.rejects(f.build(), /unsafe|duplicate|conflict|reserved/i);
  });
});

test("release requires installer relative imports to remain in the packaged closure", async t => {
  const f = await fixture(t);
  await f.put("src/install.mjs", "import '../developer-only.txt';\n");
  await assert.rejects(f.build(), /closure|import/i);
});

test("distribution tooling may contain import examples for generated fixture files", async t => {
  const f = await fixture(t);
  await f.put("scripts/tool.mjs", "export const fixture = `\nimport './fixture-only.mjs';\n`;\n");
  const built = await f.build(), verified = verifyReleaseArchive(await readFile(built.archivePath));
  assert.equal(verified.files.get("scripts/tool.mjs").toString(), "export const fixture = `\nimport './fixture-only.mjs';\n`;\n");
});

test("runtime closure retains existing bundle exclusions without vendoring SDK or developer files", async t => {
  const f = await fixture(t);
  for (const path of ["mods/example/gpui-kit.d.ts", "mods/example/herdr.d.ts", "mods/example/.DS_Store", "mods/example/node_modules/sdk/index.js", "mods/example/.git/config", "mods/example/__pycache__/cache.pyc"]) await f.put(path, "Excluded developer-only resource.\n");
  const built = await f.build(), verified = verifyReleaseArchive(await readFile(built.archivePath));
  assert.deepEqual(Object.keys(verified.manifest.files).sort(), expectedFiles);
});

test("base exporter scans filenames as well as file bodies without echoing credentials", async t => {
  const f = await fixture(t), secret = "gh" + "p_" + "X".repeat(40);
  await f.put(`src/${secret}.mjs`, "export const ready = true;\n");
  await assert.rejects(exportBundleTo(f.sourceRoot, join(dirname(f.sourceRoot), "export")), error => /private|privacy|content/i.test(error.message) && !error.message.includes(secret));
});

test("release uses portable USTAR prefix fields for long legal-resource paths", async t => {
  const f = await fixture(t), path = `licenses/${"notice-".repeat(12)}/source.txt`;
  await f.put(path, "Long-path legal resource.\n");
  const built = await f.build(), verified = verifyReleaseArchive(await readFile(built.archivePath));
  assert.equal(verified.files.get(path).toString(), "Long-path legal resource.\n");
  const tar = gunzipSync(await readFile(built.archivePath)), entry = entries(tar).find(entry => entry.name === "source.txt");
  assert.ok(entry, "long file uses the USTAR name/prefix split");
  assert.equal(tar.toString("ascii", entry.offset + 345, entry.offset + 500).split("\0")[0], `${ROOT}/${dirname(path)}`);
});

test("archive manifest requires typed commit metadata and exact file modes", async t => {
  const f = await fixture(t), built = await f.build(), original = gunzipSync(await readFile(built.archivePath));
  assert.throws(() => verifyReleaseArchive(pack(replaceManifest(original, manifest => { manifest.sourceCommit = [COMMIT]; }))), /manifest/i);
  const mode = Buffer.from(original), first = entries(mode)[0];
  mode.write("0000755\0", first.offset + 100, "ascii"); checksum(mode, first.offset);
  assert.throws(() => verifyReleaseArchive(pack(mode)), /manifest|mode/i);
});

test("archive verifier rejects bad digest, gzip, tar, links, duplicate paths and traversal", async t => {
  const f = await fixture(t), built = await f.build(), archive = await readFile(built.archivePath), original = gunzipSync(archive);
  assert.throws(() => verifyReleaseArchive(archive, { expectedSha256: "0".repeat(64) }), /checksum|sha256/i);
  for (const bytes of [Buffer.from("not gzip"), archive.subarray(0, -4), Buffer.concat([archive, Buffer.from("garbage")]), Buffer.concat([archive, archive])]) assert.throws(() => verifyReleaseArchive(bytes), /gzip|archive|compressed/i);
  for (const kind of ["checksum", "symlink", "hardlink", "duplicate", "traversal", "absolute", "drive", "prefix", "padding", "trailing", "mode", "timestamp"]) await t.test(kind, () => {
    let tar = Buffer.from(original); const list = entries(tar), first = list[0];
    if (kind === "checksum") tar[first.offset + 1] ^= 1;
    if (kind === "symlink" || kind === "hardlink") { tar[first.offset + 156] = kind === "symlink" ? 50 : 49; checksum(tar, first.offset); }
    if (kind === "duplicate") tar = Buffer.concat([tar.subarray(0, -1024), tar.subarray(first.offset, first.offset + first.length), Buffer.alloc(1024)]);
    if (kind === "traversal") rename(tar, first, `${ROOT}/../escape`);
    if (kind === "absolute") rename(tar, first, "/absolute");
    if (kind === "drive") rename(tar, first, "C:/unsafe");
    if (kind === "prefix") rename(tar, first, "different-root/file");
    if (kind === "padding") tar[first.offset + 512 + first.size] = 1;
    if (kind === "trailing") tar = Buffer.concat([tar, Buffer.alloc(512)]);
    if (kind === "mode") { tar.write("0000777\0", first.offset + 100, "ascii"); checksum(tar, first.offset); }
    if (kind === "timestamp") { tar.write("00000000001\0", first.offset + 136, "ascii"); checksum(tar, first.offset); }
    assert.throws(() => verifyReleaseArchive(pack(tar)), /unsafe|archive|tar|duplicate|root|mode|header|padding|path|canonical/i);
  });
});

test("archive verifier rejects payload tampering and unknown or missing members", async t => {
  const f = await fixture(t), built = await f.build(), original = gunzipSync(await readFile(built.archivePath));
  for (const kind of ["tamper", "missing", "unknown", "manifest"]) await t.test(kind, () => {
    let tar = Buffer.from(original); const list = entries(tar), entry = list.find(e => e.name.endsWith("/README.md"));
    if (kind === "tamper") tar[entry.offset + 512] ^= 1;
    if (kind === "missing") tar = Buffer.concat([tar.subarray(0, entry.offset), tar.subarray(entry.offset + entry.length)]);
    if (kind === "unknown") rename(tar, entry, `${ROOT}/README-extra.md`);
    if (kind === "manifest") { const manifest = list.find(e => e.name.endsWith("/RELEASE.json")); tar[manifest.offset + 512] = 33; }
    assert.throws(() => verifyReleaseArchive(pack(tar)), /hash|manifest|member|membership|missing|unknown|canonical|order/i);
  });
});

test("archive decompression is bounded", () => {
  const oversized = pack(Buffer.alloc(65 * 1024 * 1024));
  assert.throws(() => verifyReleaseArchive(oversized), /size|large|limit|gzip|archive/i);
});

test("archive verifier bounds file sizes and entry counts before manifest processing", async t => {
  const f = await fixture(t), built = await f.build(), tar = gunzipSync(await readFile(built.archivePath));
  const header = Buffer.from(tar.subarray(0, 512));
  header.write("00040000001\0", 124, "ascii"); checksum(header, 0);
  assert.throws(() => verifyReleaseArchive(pack(Buffer.concat([header, Buffer.alloc(1024)]))), /size|limit/i);
  header.write("00000000000\0", 124, "ascii");
  const headers = [];
  for (let index = 0; index < 8194; index += 1) {
    const next = Buffer.from(header); rename(next, { offset: 0 }, `${ROOT}/a${String(index).padStart(5, "0")}`); headers.push(next);
  }
  assert.throws(() => verifyReleaseArchive(pack(Buffer.concat([...headers, Buffer.alloc(1024)]))), /entry limit/i);
});

test("directory verification checks exact trio, both checksums and identical manifest bytes", async t => {
  const f = await fixture(t), built = await f.build(), verified = await verifyReleaseDirectory(f.outputDirectory);
  assert.deepEqual(verified.manifest, built.manifest);
  assert.equal(verified.archivePath, built.archivePath); assert.equal(verified.manifestPath, built.manifestPath); assert.equal(verified.checksumsPath, built.checksumsPath);
  const manifest = await readFile(built.manifestPath), sums = await readFile(built.checksumsPath, "utf8");
  await writeFile(built.manifestPath, Buffer.concat([manifest, Buffer.from("\n")]));
  await assert.rejects(verifyReleaseDirectory(f.outputDirectory), /checksum|sha256/i);
  await writeFile(built.checksumsPath, sums.replace(sha(manifest), sha(Buffer.concat([manifest, Buffer.from("\n")]))));
  await assert.rejects(verifyReleaseDirectory(f.outputDirectory), /manifest|equal/i);
  await writeFile(built.manifestPath, manifest); await writeFile(built.checksumsPath, sums);
  await writeFile(join(f.outputDirectory, "unexpected.txt"), "unexpected");
  await assert.rejects(verifyReleaseDirectory(f.outputDirectory), /trio|exact|unexpected/i);
});

test("verify CLI reports version, exact commit and file count without extraction", async t => {
  const f = await fixture(t), built = await f.build();
  for (const args of [[built.archivePath], ["--directory", f.outputDirectory]]) {
    const result = spawnSync(process.execPath, [verifyCli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0\.1\.0-beta\.1/); assert.ok(result.stdout.includes(COMMIT)); assert.match(result.stdout, /21 files/);
  }
  assert.equal((await readdir(f.outputDirectory)).length, 3);
});

test("build CLI records clean Git HEAD and refuses dirty trees and dirty bypass", async t => {
  const f = await fixture(t);
  const { env, head } = commitFixture(f);
  const clean = spawnSync(process.execPath, [buildCli, "--source-root", f.sourceRoot, "--output", f.outputDirectory], { env, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal((await verifyReleaseDirectory(f.outputDirectory)).manifest.sourceCommit, head);
  await f.put("developer-only.txt", "dirty\n");
  for (const extra of [[], ["--allow-dirty"]]) {
    const dirtyOutput = join(dirname(f.outputDirectory), "dirty");
    const result = spawnSync(process.execPath, [buildCli, "--source-root", f.sourceRoot, "--output", dirtyOutput, ...extra], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /clean|dirty|unknown/i);
    assert.equal(await lstat(dirtyOutput).then(() => true, () => false), false);
  }
});

test("build CLI refuses ignored local files inside recursive release resources", async t => {
  const f = await fixture(t);
  await f.put(".gitignore", "*.error\n");
  const { env, git } = commitFixture(f);
  await f.put("scripts/local.error", "Local diagnostic not committed or intended for distribution.\n");
  assert.equal(git(["status", "--porcelain"]), "");
  const result = spawnSync(process.execPath, [buildCli, "--source-root", f.sourceRoot, "--output", f.outputDirectory], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /committed|tracked|source/i);
  assert.equal(await lstat(f.outputDirectory).then(() => true, () => false), false);
});

test("publisher binds actual archive payload to the tested committed source before GitHub writes", async t => {
  const f = await fixture(t), { head } = commitFixture(f);
  const original = await readFile(join(f.sourceRoot, "src/install.mjs"));
  await f.put("src/install.mjs", "export const install = () => 'different untested payload';\n");
  const built = await buildRelease({ sourceRoot: f.sourceRoot, outputDirectory: f.outputDirectory, commit: head });
  await f.put("src/install.mjs", original);
  let phase = "absent"; const writes = [], repo = "koraybostanci/herdr-workspace", tag = "v" + VERSION;
  const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const run = async (command, args, options = {}) => {
    if (command === "git") { const r = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
    if (command === "npm") return { code: 0, stdout: "", stderr: "" };
    assert.equal(command, "gh");
    if (args[0] === "api") {
      if (args[1] === `repos/${repo}`) return json({ private: true, permissions: { push: true } });
      if (args[1] === `repos/${repo}/commits/${head}`) return json({ sha: head });
      if (args[1] === `repos/${repo}/releases?per_page=100`) return json([]);
      if (args[1] === `repos/${repo}/git/ref/tags/${tag}` && phase === "published") return json({ object: { type: "commit", sha: head } });
      return { code: 1, stdout: "", stderr: "Not Found (HTTP 404)" };
    }
    if (["create", "edit"].includes(args[1])) { writes.push(args); phase = args[1] === "create" ? "draft" : "published"; return { code: 0, stdout: "", stderr: "" }; }
    if (args[1] === "view") return json({ isDraft: phase === "draft", isPrerelease: true, targetCommitish: head, tagName: tag, url: "https://example.test/release", assets: [built.archivePath, built.manifestPath, built.checksumsPath].map(path => ({ name: path.split("/").pop() })) });
    if (args[1] === "download") {
      const directory = args[args.indexOf("--dir") + 1]; await mkdir(directory, { recursive: true });
      for (const path of [built.archivePath, built.manifestPath, built.checksumsPath]) await writeFile(join(directory, path.split("/").pop()), await readFile(path));
      return { code: 0, stdout: "", stderr: "" };
    }
    throw Error("Unexpected release command");
  };
  await assert.rejects(publishPrivateBeta({ sourceRoot: f.sourceRoot, directory: f.outputDirectory, platform: "darwin", publish: true, run, tmpRoot: dirname(f.outputDirectory) }), /source|payload|committed|provenance/i);
  assert.deepEqual(writes, []);
});
