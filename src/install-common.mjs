import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { applyEdits, createScanner, modify, parse } from "jsonc-parser";

export const OWNER = "herdr-workspace";
export const ABSENT = "absent";
export const hashOf = data => (data === null ? ABSENT : createHash("sha256").update(data).digest("hex"));
export const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const journalPathFor = appHome => join(appHome, "data/herdr-workspace/install-journal.json");
export const configKey = (path, at) => `${path}\0${at.join("/")}`;

export async function readBytes(path) {
  try { return await readFile(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export async function readJournal(path) {
  const bytes = await readBytes(path);
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("foreign-journal"); }
  if (value?.owner !== OWNER || value.schema !== 1) throw new Error("foreign-journal");
  return value;
}

export function parseDoc(text) {
  const errors = [];
  const value = parse(text ?? "{}\n", errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-config");
  return value;
}
export const getAt = (doc, at) => at.reduce((value, key) => value?.[key], doc);
function change(text, path, value) {
  const base = text ?? "{}\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: base.includes("\r\n") ? "\r\n" : "\n" };
  return applyEdits(base, modify(base, path, value, { formattingOptions }));
}
// Identifies an owned-looking entry: an OpenCode plugin by package, a Claude hook group by helper path.
const fingerprint = entry => entry?.package ?? entry?.hooks?.find(h => h?.args)?.args?.[0];

// Idempotent: adds, replaces or leaves one array entry. Creates the array (and its parent object) when missing.
export function applyEntryToText(text, { at, value, previous }) {
  const list = getAt(parseDoc(text), at);
  if (list === undefined) return change(text, at, [value]);
  if (!Array.isArray(list)) throw new Error("invalid-config");
  if (list.some(entry => deepEqual(entry, value))) return text;
  const index = previous === undefined ? -1 : list.findIndex(entry => deepEqual(entry, previous));
  return change(text, index >= 0 ? [...at, index] : [...at, -1], value);
}

// Removes only an entry that is byte-for-value identical to the one we wrote.
export function removeEntryFromText(text, { at, value, createdArray, createdParent }) {
  const list = getAt(parseDoc(text), at);
  if (!Array.isArray(list)) return { text, outcome: "absent" };
  const index = list.findIndex(entry => deepEqual(entry, value));
  if (index < 0) {
    const like = fingerprint(value) !== undefined && list.some(entry => fingerprint(entry) === fingerprint(value));
    return { text, outcome: like ? "modified" : "absent" };
  }
  let out = change(text, [...at, index], undefined);
  if (createdArray && getAt(parseDoc(out), at)?.length === 0) out = change(out, at, undefined);
  if (createdParent) {
    const parent = getAt(parseDoc(out), at.slice(0, -1));
    if (parent && typeof parent === "object" && Object.keys(parent).length === 0) out = change(out, at.slice(0, -1), undefined);
  }
  return { text: out, outcome: "removed" };
}

// True only for an empty object with no comments, so a user's notes are never mistaken for "nothing left".
export function isEmptyDoc(text) {
  const scanner = createScanner(text, false);
  let braces = 0;
  for (let token = scanner.scan(); token !== 17; token = scanner.scan()) {
    if (token === 1 || token === 2) braces += 1;
    else if (token !== 15 && token !== 14) return false;
  }
  return braces === 2;
}

// Returns the first path component below `root` that is a symlink (or not a directory), else null.
export async function symlinkedBelow(root, dest) {
  const parts = dest.slice(root.length + 1).split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`;
    let info;
    try { info = await lstat(current); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    if (info.isSymbolicLink() || !info.isDirectory()) return current;
  }
  return null;
}
