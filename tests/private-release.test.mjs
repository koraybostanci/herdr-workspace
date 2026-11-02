import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { testTmpRoot } from "./helpers/tmp-root.mjs";

const publisher = await import("../scripts/lib/private-release.mjs").catch(error => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const COMMIT = "a".repeat(40), REPO = "example/herdr-workspace", VERSION = "0.1.0-beta.1", TAG = "v" + VERSION;
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(testTmpRoot(), "private-beta-")); t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), directory = join(root, "artifact");
  await mkdir(sourceRoot); await mkdir(directory);
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ private: true, version: VERSION, repository: { url: `https://github.com/${REPO}.git` } }));
  await writeFile(join(sourceRoot, "bundle.json"), JSON.stringify({ version: VERSION }));
  const manifest = { schema: 1, owner: "herdr-workspace", version: VERSION, sourceCommit: options.artifactCommit ?? COMMIT, repository: REPO,
    rootDirectory: "herdr-workspace-" + VERSION, files: {} };
  const names = [`herdr-workspace-${VERSION}.tar.gz`, `herdr-workspace-${VERSION}.manifest.json`, "SHA256SUMS"];
  for (const name of names) await writeFile(join(directory, name), name.endsWith("manifest.json") ? JSON.stringify(manifest) : "fixture artifact " + name);
  const calls = []; let phase = options.existingRelease ? "published" : "absent", privacyReads = 0;
  const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const absent = () => ({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  const run = async (command, args = [], execution = {}) => {
    calls.push({ command, args, cwd: execution.cwd });
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: COMMIT + "\n", stderr: "" };
    if (command === "git" && args[0] === "status") return { code: 0, stdout: options.dirty ? " M README.md\n" : "", stderr: "" };
    if (command === "npm") return { code: options.failValidation && args.includes("test") ? 1 : 0, stdout: "validation fixture", stderr: "" };
    assert.equal(command, "gh");
    if (args[0] === "api") {
      const endpoint = args[1];
      if (endpoint === `repos/${REPO}`) {
        privacyReads++;
        return json({ private: options.public === true || options.publicAt && privacyReads >= options.publicAt ? false : true, permissions: { push: true } });
      }
      if (endpoint === `repos/${REPO}/commits/${COMMIT}`) return json({ sha: COMMIT });
      if (endpoint === `repos/${REPO}/releases?per_page=100`) return json(options.draftOnPageTwo ? Array.from({ length: 100 }, (_, index) => ({ tag_name: `older-${index}` })) : options.existingDraft ? [{ tag_name: TAG, draft: true }] : []);
      if (endpoint === `repos/${REPO}/releases?per_page=100&page=2`) return json([{ tag_name: TAG, draft: true }]);
      if (endpoint === `repos/${REPO}/git/ref/tags/${TAG}`) return options.wrongTag ? json({ object: { type: "commit", sha: "b".repeat(40) } })
        : phase === "published" && !options.missingPublishedTag ? json({ object: { type: "commit", sha: COMMIT } }) : absent();
      if (endpoint === `repos/${REPO}/releases/tags/${TAG}`) return phase === "absent" ? absent() : json({ tag_name: TAG });
      throw Error("Unexpected API endpoint: " + endpoint);
    }
    assert.equal(args[0], "release");
    if (args[1] === "create") { phase = "draft"; return { code: 0, stdout: `https://github.com/${REPO}/releases/tag/${TAG}`, stderr: "" }; }
    if (args[1] === "view") return json({ isDraft: phase === "draft", isPrerelease: true, targetCommitish: COMMIT, tagName: TAG,
      url: `https://github.com/${REPO}/releases/tag/${TAG}`, assets: names.map(name => ({ name })) });
    if (args[1] === "download") {
      const target = args[args.indexOf("--dir") + 1]; await mkdir(target, { recursive: true });
      for (const name of names) await cp(join(directory, name), join(target, name));
      if (options.tamperDownload) await writeFile(join(target, names[0]), "altered remote bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "edit") { phase = "published"; return { code: 0, stdout: "", stderr: "" }; }
    throw Error("Unexpected GitHub command: " + args.join(" "));
  };
  const verify = async dir => ({ manifest: JSON.parse(await readFile(join(dir, names[1]), "utf8")),
    archivePath: join(dir, names[0]), manifestPath: join(dir, names[1]), checksumsPath: join(dir, names[2]) });
  return { sourceRoot, directory, repo: REPO, run, verify, verifySource: async () => {}, tmpRoot: root, platform: "darwin", calls, names, phase: () => phase };
}
function publish() { assert.equal(typeof publisher.publishPrivateBeta, "function"); return publisher.publishPrivateBeta; }
const writes = f => f.calls.filter(call => call.command === "gh" && call.args[0] === "release" && ["create", "edit", "upload", "delete"].includes(call.args[1]));

test("private prerelease planning verifies provenance without writing a release", async t => {
  const f = await fixture(t), result = await publish()({ ...f, publish: false });
  assert.equal(result.mode, "plan"); assert.equal(result.commit, COMMIT); assert.deepEqual(writes(f), []);
  assert.equal(f.calls.some(call => call.command === "npm"), false);
});
test("publication refuses a public repository before uploading anything", async t => {
  const f = await fixture(t, { public: true });
  await assert.rejects(publish()({ ...f, publish: true }), /private/i); assert.deepEqual(writes(f), []);
});
test("publication refuses dirty source or artifacts for a different commit", async t => {
  for (const options of [{ dirty: true }, { artifactCommit: "b".repeat(40) }]) {
    const f = await fixture(t, options); await assert.rejects(publish()({ ...f, publish: true }), /clean|dirty|commit/i); assert.deepEqual(writes(f), []);
  }
});
test("a failed validation gate cannot create or publish a release", async t => {
  const f = await fixture(t, { failValidation: true });
  await assert.rejects(publish()({ ...f, publish: true }), /validation|test/i); assert.deepEqual(writes(f), []);
});
test("an existing version or conflicting tag is never overwritten", async t => {
  for (const options of [{ wrongTag: true }, { existingRelease: true }]) {
    const f = await fixture(t, options); await assert.rejects(publish()({ ...f, publish: true }), /tag|exists|existing/i); assert.deepEqual(writes(f), []);
  }
});
test("an existing draft omitted by release-by-tag lookup blocks all remote writes", async t => {
  for (const options of [{ existingDraft: true }, { draftOnPageTwo: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(publish()({ ...f, publish: true }), /draft|existing|exists/i);
    assert.deepEqual(writes(f), []);
  }
});
test("publication cannot report success without a remote tag bound to the source commit", async t => {
  const f = await fixture(t, { missingPublishedTag: true });
  await assert.rejects(publish()({ ...f, publish: true }), /tag/i);
});
test("publication stops with a draft if repository privacy changes before publishing", async t => {
  const f = await fixture(t, { publicAt: 3 });
  await assert.rejects(publish()({ ...f, publish: true }), /private/i);
  assert.equal(f.phase(), "draft"); assert.equal(writes(f).some(call => call.args[1] === "edit"), false);
});
test("downloaded asset corruption keeps the release in draft", async t => {
  const f = await fixture(t, { tamperDownload: true });
  await assert.rejects(publish()({ ...f, publish: true }), /hash|bytes|checksum|integrity/i);
  assert.equal(f.phase(), "draft"); assert.equal(writes(f).some(call => call.args[1] === "edit"), false);
});
test("verified publication is a private prerelease bound to the exact source commit", async t => {
  const f = await fixture(t), result = await publish()({ ...f, publish: true });
  assert.equal(result.mode, "published"); assert.equal(result.commit, COMMIT); assert.equal(f.phase(), "published");
  const create = writes(f).find(call => call.args[1] === "create"), edit = writes(f).find(call => call.args[1] === "edit");
  assert.ok(create.args.includes("--draft")); assert.ok(create.args.includes("--prerelease"));
  assert.equal(create.args[create.args.indexOf("--target") + 1], COMMIT);
  assert.ok(edit.args.includes("--draft=false")); assert.ok(edit.args.includes("--prerelease")); assert.ok(edit.args.includes("--latest=false"));
  assert.ok(f.calls.some(call => call.command === "npm" && call.args.includes("test:native-install")));
  assert.ok(f.calls.some(call => call.command === "npm" && call.args.includes("check:privacy")));
  assert.ok(f.calls.some(call => call.command === "npm" && call.args.includes("test:clean-install")));
  assert.ok(create.args.filter(arg => f.names.includes(basename(arg))).length === 3);
});
