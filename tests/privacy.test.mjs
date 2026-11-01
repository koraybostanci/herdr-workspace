import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testTmpRoot } from "./helpers/tmp-root.mjs";
import { scanFiles } from "../scripts/check-private-content.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const j = (...parts) => parts.join("");

// Structured synthetic fixtures: secret-shaped values are assembled at runtime, never stored literally.
const PRIVATE = [
  { rule: "github-token", path: "a.txt", text: `token = ${j("gh", "p_", "A".repeat(36))}\n` },
  { rule: "private-key", path: "b.txt", text: `${j("-----BEGIN ", "OPENSSH PRIVATE", " KEY-----")}\nabc\n` },
  { rule: "aws-key", path: "c.txt", text: `id ${j("AK", "IA", "ABCDEFGHIJKLMNOP")}\n` },
  { rule: "credential-url", path: "d.txt", text: `remote ${j("https://", "user:", "secretpw", "@example.com/x.git")}\n` },
  { rule: "private-artifact", path: "state/review.sqlite", text: "x\n" },
  { rule: "private-artifact", path: ".env", text: "A=1\n" },
  { rule: "private-artifact", path: "node_modules/x/index.js", text: "x\n" },
  { rule: "developer-path", path: "e.txt", text: `p ${j("/Us", "ers/", "someone", "/dev")}\n` },
  { rule: "developer-path", path: "f.txt", text: `p ${j("/private", "/var/", "folders/ab/xyz/T")}\n` },
  { rule: "npm-token", path: "n.txt", text: `${j("//registry.npmjs.org/:_auth", "Token=", "npm_", "a".repeat(36))}\n` },
  { rule: "api-key", path: "o.txt", text: `${j("sk-", "ant-", "api03-", "A".repeat(40))}\n` },
  { rule: "api-key", path: "p.txt", text: `${j("xo", "xb-", "1234567890-", "abcdefghij")}\n` },
  { rule: "api-key", path: "q.txt", text: `${j("Authorization: Bear", "er ", "a".repeat(40))}\n` },
  { rule: "developer-path", path: "r.txt", text: `${j("/home", "/bob/projects/x")}\n` },
  { rule: "developer-path", path: "s.txt", text: `${j("C:", "\\Users", "\\bob\\x")}\n` },
  { rule: "identifier", path: "g.txt", text: `${j("TRA", "CK-", "318")} item\n` },
  { rule: "identifier", path: "h.txt", text: `${j("https://github.com/", "zal", "ando-build/x")}\n` },
];

async function fixtureDir(t) {
  const root = await mkdtemp(join(testTmpRoot(), "privacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, path, text) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}

test("private_artifacts_rejected", async (t) => {
  const root = await fixtureDir(t);
  for (const f of PRIVATE) await put(root, f.path, f.text);
  const result = await scanFiles({ root, files: PRIVATE.map((f) => f.path) });
  assert.equal(result.ok, false);
  for (const f of PRIVATE) {
    assert.ok(result.findings.some((x) => x.path === f.path && x.rule === f.rule), `${f.path} -> ${f.rule}`);
  }
  for (const finding of result.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ["line", "path", "rule"]);
    assert.equal(typeof finding.line, "number");
  }
  assert.ok(!JSON.stringify(result).includes("AAAAAAAA"), "matched values must not be reported");
});

test("synthetic_source_allowed", async (t) => {
  const root = await fixtureDir(t);
  await put(root, "ok.js", `const repo = "https://github.com/team/repo-a/pull/12";\nconst id = "PROJ-101";\nconst home = "/home/example";\n`);
  await put(root, "README.md", "Repository koraybostanci/herdr-workspace\n");
  const result = await scanFiles({ root, files: ["ok.js", "README.md"] });
  assert.deepEqual(result, { ok: true, findings: [] });
});

test("portable_tests_use_owned_temp_root", async (t) => {
  const root = await fixtureDir(t);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {testTmpRoot} from ${JSON.stringify(new URL("./helpers/tmp-root.mjs", import.meta.url).href)};
     import {scratch as s2} from ${JSON.stringify(new URL("./helpers/session-metadata-fixtures.mjs", import.meta.url).href)};
     console.log(JSON.stringify([testTmpRoot(),s2]));`],
    { cwd: root, env: { ...process.env, HERDR_WORKSPACE_TEST_TMPDIR: root }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [a, b] = JSON.parse(result.stdout);
  assert.ok(a.startsWith(root) && b.startsWith(root), "scratch must honor HERDR_WORKSPACE_TEST_TMPDIR");
});

test("shipped_tree_passes_its_own_scan", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const p = join(dir, name);
      statSync(p).isDirectory() ? walk(p) : files.push(relative(repoRoot, p));
    }
  };
  walk(repoRoot);
  return scanFiles({ root: repoRoot, files }).then((r) => assert.deepEqual(r.findings, []));
});
