#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Rules report only path, line and rule name. Matched values are never returned or printed.
// Patterns are written so that this file does not match its own rules.
const CONTENT_RULES = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["credential-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i],
  ["npm-token", /\b_auth(?:Token)?\s*=\s*\S{16,}|\bnpm_[A-Za-z0-9]{30,}\b/i],
  ["api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bBearer\s+[A-Za-z0-9._~+\/=-]{32,}/],
  ["developer-path", /\/Users\/(?!example\b)[A-Za-z0-9_.-]+|\/(?:private\/)?var\/folders\/|\/home\/(?!example\b)[a-z][a-z0-9_-]*\/|[A-Za-z]:\\+Users\\+(?!example\b)[A-Za-z0-9_.-]+/i],
  ["identifier", /\bTRACK-\d+\b|zal(?:ando)|k(?:bostanci)|bostanci\.koray|_z(?:se)\b|\bgithub-z(?:se)\b/i],
];
// Exact synthetic values that regression tests need to feed to validators. Matching is by exact value, not by path.
const SYNTHETIC_VALUES = new Set(["https://name:" + "password@example.com"]);
const PRIVATE_SEGMENTS = new Set(["node_modules", "state", "releases", "logs", "journal", "backups"]);
const PRIVATE_NAME = /(?:^\.env(?:\..*)?$|\.(?:sqlite3?|db|pem|p12|key|log|journal)$|-(?:wal|shm)$|^id_(?:rsa|ed25519|ecdsa)|^progress\.md$|^\.DS_Store$)/;

function pathRules(path) {
  const parts = path.split("/");
  const hit = parts.slice(0, -1).some((p) => PRIVATE_SEGMENTS.has(p)) || PRIVATE_NAME.test(basename(path));
  return hit ? ["private-artifact"] : [];
}

function flagged(pattern, text) {
  const match = pattern.exec(text);
  return Boolean(match) && !SYNTHETIC_VALUES.has(match[0]);
}

export function scanText(path, text) {
  const findings = pathRules(path).map((rule) => ({ path, line: 0, rule }));
  text.split("\n").forEach((content, index) => {
    for (const [rule, pattern] of CONTENT_RULES) if (flagged(pattern, content)) findings.push({ path, line: index + 1, rule });
  });
  return findings;
}

export async function scanFiles({ root, files }) {
  const findings = [];
  for (const path of files) {
    const rules = pathRules(path);
    let text = "";
    try {
      const buffer = await readFile(join(root, path));
      if (!buffer.includes(0)) text = buffer.toString("utf8");
    } catch { /* unreadable or removed files only get path rules */ }
    findings.push(...scanText(path, text).filter((f) => f.line > 0 || rules.includes(f.rule)));
    if (!text && rules.length === 0) continue;
  }
  return { ok: findings.length === 0, findings };
}

export function matchesAllowlist(path, entries) {
  return entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

export async function scanAllowlist({ root }) {
  const allow = JSON.parse(await readFile(join(root, "bundle-files.json"), "utf8"));
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const result = await scanFiles({ root, files });
  for (const path of files) {
    if (!matchesAllowlist(path, allow.files)) result.findings.push({ path, line: 0, rule: "not-in-allowlist" });
  }
  result.ok = result.findings.length === 0;
  return result;
}

// Scans lines added by commits in <range> (for example origin/main..HEAD), plus every path they touched.
export async function scanHistory({ root, range }) {
  const findings = [];
  const log = git(root, ["log", "--no-color", "--format=commit %H%n%an <%ae>%n%s%n%b", "-p", "--no-ext-diff", range]);
  let path = "(history)";
  let line = 0;
  for (const content of log.split("\n")) {
    if (content.startsWith("+++ b/")) { path = content.slice(6); line = 0; findings.push(...pathRules(path).map((rule) => ({ path, line: 0, rule }))); continue; }
    if (content.startsWith("@@")) { line = Number(/\+(\d+)/.exec(content)?.[1] ?? 0) - 1; continue; }
    if (content.startsWith("+") || !content.startsWith("-") && !content.startsWith(" ") && !content.startsWith("diff")) {
      line += 1;
      const text = content.startsWith("+") ? content.slice(1) : content;
      for (const [rule, pattern] of CONTENT_RULES) if (flagged(pattern, text)) findings.push({ path, line, rule });
    } else if (content.startsWith(" ")) line += 1;
  }
  return { ok: findings.length === 0, findings };
}

function report(result) {
  for (const f of result.findings) console.error(`${f.path}:${f.line} ${f.rule}`);
  console.log(result.ok ? "privacy scan: no findings" : `privacy scan: ${result.findings.length} finding(s)`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const args = process.argv.slice(2);
  if (args.includes("--tracked-and-untracked-allowlist")) report(await scanAllowlist({ root }));
  else if (args[0] === "--history" && args[1]) report(await scanHistory({ root, range: args[1] }));
  else { console.error("usage: check-private-content.mjs --tracked-and-untracked-allowlist | --history <range>"); process.exitCode = 2; }
}
