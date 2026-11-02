import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, posix, resolve } from "node:path";
import { crc32, gzipSync, inflateRawSync } from "node:zlib";
import { scanText } from "../check-private-content.mjs";
import { importsOf, validateBundle } from "../../src/bundle.mjs";

const OWNER = "herdr-workspace", REPOSITORY = "koraybostanci/herdr-workspace";
const MAX_ARCHIVE = 64 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024, MAX_ENTRIES = 8192;
const REQUIRED_DISTRIBUTION = ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY.md", "licenses", "assets/logo.svg", "docs/installation.md", "docs/limitations.md", "docs/private-beta.md", "docs/release-process.md", "scripts"];
const PRIVATE_SEGMENTS = new Set([".git", ".github", ".agents", ".aws", ".ssh", ".config", ".local", ".cache", ".claude", ".opencode", "node_modules", "__pycache__", "state", "releases", "logs", "journal", "backups", "credentials", "secrets", "tests"]);
const PRIVATE_NAME = /^(?:credentials?(?:\..*)?|secrets?(?:\..*)?|\.env(?:\..*)?|\.git.*|\.DS_Store|progress\.md|id_(?:rsa|ed25519|ecdsa).*)$|\.(?:sqlite3?|db|pem|p12|key|log|journal)$|-(?:wal|shm)$/i;
// Match src/bundle.mjs exclusions when checking runtime include/hash closure, not when selecting release resources.
const RUNTIME_EXCLUSIONS = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", "gpui-kit.d.ts", "herdr.d.ts"]);
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

// Strict portable relative paths; error messages deliberately never echo untrusted paths or contents.
function safePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 240 || !/^[A-Za-z0-9._+/-]+$/.test(path)) fail("Unsafe release path");
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || part.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail("Unsafe release path");
    if (PRIVATE_SEGMENTS.has(part.toLowerCase()) || PRIVATE_NAME.test(part)) fail("Private artifact path is not permitted");
  }
  if (scanText(path, path).length) fail("Private content detected in release path");
  return path;
}

function scan(path, bytes) {
  // Scan all payloads, including binary-looking files, so a NUL cannot hide a credential.
  if (scanText(path, bytes.toString("utf8")).length) fail("Private content detected in release payload; run the privacy scanner for rule locations");
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`Invalid ${label} JSON`); }
}

function assertList(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ENTRIES) fail(`Missing or invalid ${label} include list`);
  for (const path of value) safePath(path);
}

async function sourceInfo(root, path) {
  safePath(path);
  let info, current = root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    try { info = await lstat(current); } catch { fail("Missing or unreadable release resource"); }
    if (info.isSymbolicLink()) fail("Unsafe symlink in release source");
    if (index < parts.length - 1 && !info.isDirectory()) fail("Unsafe release source ancestor");
  }
  if (!info.isFile() && !info.isDirectory()) fail("Unsafe non-regular release resource");
  return info;
}

async function sourceFile(root, path) {
  const info = await sourceInfo(root, path);
  if (!info.isFile()) fail("Release resource must be a regular file");
  if (info.size > MAX_FILE) fail("Release file exceeds size limit");
  let handle;
  try {
    handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_FILE) fail("Unsafe release file or size limit exceeded");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE) fail("Release file exceeds size limit");
    return { bytes, mode: opened.mode & 0o111 ? 0o755 : 0o644 };
  } catch { fail("Unsafe or unreadable release file"); }
  finally { await handle?.close(); }
}

async function expand(root, includes, runtimeClosure = false) {
  const out = new Set(); let visited = 0;
  async function walk(path) {
    if (++visited > MAX_ENTRIES) fail("Release entry limit exceeded");
    const info = await sourceInfo(root, path);
    if (info.isDirectory()) {
      const names = await readdir(join(root, path));
      if (!names.length) fail("Missing release resource: included directory is empty");
      if (names.length > MAX_ENTRIES) fail("Release entry limit exceeded");
      for (const name of names.sort()) if (!runtimeClosure || !RUNTIME_EXCLUSIONS.has(name)) await walk(`${path}/${name}`);
    } else out.add(path);
  }
  for (const path of includes) await walk(path);
  return [...out].sort();
}

function checkMembership(paths) {
  if (paths.length > MAX_ENTRIES) fail("Release entry limit exceeded");
  const seen = new Set();
  for (const path of paths) {
    safePath(path);
    const folded = path.toLowerCase();
    if (seen.has(folded) || folded === "release.json" || folded.startsWith("release.json/")) fail("Unsafe or duplicate reserved release path");
    seen.add(folded);
  }
  for (const path of seen) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/"))) fail("Unsafe file/directory path conflict");
      parts.pop();
    }
  }
}

async function collect(sourceRoot, distribution = false) {
  const rootInfo = await lstat(resolve(sourceRoot));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("Unsafe release source root");
  const root = await realpath(sourceRoot);
  const bundleFile = await sourceFile(root, "bundle.json"), bundle = parseJson(bundleFile.bytes, "bundle");
  if (bundle.schema !== 1 || bundle.owner !== OWNER || !object(bundle.files) || !Object.keys(bundle.files).length) fail("Unsupported bundle manifest");
  assertList(bundle.installer, "installer"); assertList(bundle.include, "bundle");
  const runtime = Object.keys(bundle.files).sort();
  for (const path of runtime) {
    safePath(path);
    if (!HASH.test(bundle.files[path])) fail("Invalid bundle file hash");
  }
  let resources = [];
  if (distribution) {
    assertList(bundle.distributionFiles, "distribution");
    if (REQUIRED_DISTRIBUTION.some(path => !bundle.distributionFiles.includes(path))) fail("Required distribution resources are missing from distributionFiles");
    resources = await expand(root, bundle.distributionFiles);
    if (JSON.stringify(await expand(root, bundle.include, true)) !== JSON.stringify(runtime)) fail("Bundle include/hash closure mismatch");
  }
  const installer = await expand(root, bundle.installer);
  const paths = [...new Set(["bundle.json", ...installer, ...runtime, ...resources])].sort();
  checkMembership(paths);
  const files = new Map(); let total = 0;
  for (const path of paths) {
    const file = path === "bundle.json" ? bundleFile : await sourceFile(root, path);
    if ((total += 512 + Math.ceil(file.bytes.length / 512) * 512) > MAX_ARCHIVE - MAX_FILE) fail("Release size limit exceeded");
    scan(path, file.bytes);
    if (distribution && Object.hasOwn(bundle.files, path) && sha(file.bytes) !== bundle.files[path]) fail("Bundle file hash mismatch; regenerate bundle hashes");
    files.set(path, file);
  }
  if (distribution) {
    for (const path of installer) {
      if (!/\.(?:mjs|js|cjs)$/.test(path)) continue;
      const file = files.get(path);
      for (const spec of importsOf(file.bytes.toString("utf8"))) {
        if (spec.startsWith(".") && !files.has(posix.normalize(posix.join(posix.dirname(path), spec)))) fail("Packaged relative import is outside the release closure");
      }
    }
    const validation = await validateBundle(bundle, root);
    if (!validation.ok) fail(`Bundle closure validation failed (${validation.issues[0].rule}); validate the bundle before release`);
  }
  return { root, bundle, files };
}

// Base install export intentionally excludes distribution-only documentation and release tooling.
export async function exportBundleTo(sourceRoot, dest) {
  const { files } = await collect(sourceRoot);
  const existing = await lstat(dest).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory() || (await readdir(dest)).length)) fail("Export destination must be a new or empty directory");
  await mkdir(dest, { recursive: true });
  for (const [path, { bytes, mode }] of files) {
    await mkdir(dirname(join(dest, path)), { recursive: true });
    await writeFile(join(dest, path), bytes, { flag: "wx", mode });
  }
  return dest;
}

function metadata(bundle, files, commit) {
  const pkg = parseJson(files.get("package.json")?.bytes ?? Buffer.alloc(0), "package");
  const lock = parseJson(files.get("package-lock.json")?.bytes ?? Buffer.alloc(0), "package-lock");
  const version = bundle.version;
  if (typeof version !== "string" || !VERSION.test(version) || version.length > 80 || pkg.version !== version || lock.version !== version || lock.packages?.[""]?.version !== version) fail("Package, bundle and package-lock versions must match a valid version");
  if (pkg.name !== OWNER || pkg.private !== true) fail("Release package must remain private and owned by herdr-workspace");
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof repository !== "string" || !/^(?:git\+)?https:\/\/github\.com\/koraybostanci\/herdr-workspace(?:\.git)?\/?$/.test(repository)) fail("Package repository must identify the approved GitHub repository");
  return { schema: 1, owner: OWNER, version, sourceCommit: commit, repository: REPOSITORY, rootDirectory: `${OWNER}-${version}`, files: Object.fromEntries([...files].map(([path, file]) => [path, { sha256: sha(file.bytes), mode: file.mode }])) };
}

function assertCommittedFiles(root, files, commit) {
  const tree = spawnSync("git", ["-C", root, "ls-tree", "-r", "-z", "--full-tree", commit], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (tree.status !== 0) fail("Cannot verify the committed release source tree");
  const committed = new Map(tree.stdout.split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t"); return [entry.slice(tab + 1), entry.slice(0, tab)];
  }));
  for (const [path, file] of files) {
    const entry = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(committed.get(path) ?? "");
    if (!entry || file.mode !== (entry[1] === "100755" ? 0o755 : 0o644)) fail("Release payload includes uncommitted, ignored or changed source files/modes");
    const blob = spawnSync("git", ["-C", root, "cat-file", "blob", entry[2]], { encoding: null, maxBuffer: MAX_FILE + 1024 });
    if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout) || !blob.stdout.equals(file.bytes)) fail("Release payload differs from the committed source bytes");
  }
}

// Bind archive provenance to both the tested working source and actual Git blobs, not a self-declared commit label.
export async function verifyReleaseSource({ sourceRoot, manifest }) {
  if (typeof manifest?.sourceCommit !== "string" || !COMMIT.test(manifest.sourceCommit)) fail("Invalid release source commit");
  const { root, bundle, files } = await collect(sourceRoot, true);
  if (!serialize(metadata(bundle, files, manifest.sourceCommit)).equals(serialize(manifest))) fail("Archive payload does not match the tested source inventory, bytes or modes");
  assertCommittedFiles(root, files, manifest.sourceCommit);
}

function tarHeader(path, size, mode) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || ![0o644, 0o755].includes(mode)) fail("Unsafe tar size or mode");
  let name = path, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf("/", 155);
    if (split < 1) fail("Unsafe tar path length");
    prefix = path.slice(0, split); name = path.slice(split + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) fail("Unsafe tar path length");
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header[156] = 48;
  header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
  header.write(prefix, 345, "ascii");
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function createArchive(root, files) {
  const chunks = [];
  for (const [path, { bytes, mode }] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    chunks.push(tarHeader(`${root}/${path}`, bytes.length, mode), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(chunks);
  if (tar.length > MAX_ARCHIVE) fail("Release archive size limit exceeded");
  const archive = gzipSync(tar, { level: 9 });
  archive[9] = 255; // No host operating-system metadata.
  return archive;
}

export async function buildRelease({ sourceRoot, outputDirectory, commit, requireCommittedSource = false }) {
  if (typeof commit !== "string" || !COMMIT.test(commit)) fail("A full lowercase 40-hex source commit is required");
  if (typeof outputDirectory !== "string" || !outputDirectory) fail("An output directory is required");
  const { root, bundle, files } = await collect(sourceRoot, true);
  if (requireCommittedSource) assertCommittedFiles(root, files, commit);
  const manifest = metadata(bundle, files, commit), manifestBytes = serialize(manifest);
  scan("RELEASE.json", manifestBytes);
  files.set("RELEASE.json", { bytes: manifestBytes, mode: 0o644 });
  const archive = createArchive(manifest.rootDirectory, files);
  // Exercise the same verification boundary the publisher and download verifier use before writing anything.
  verifyReleaseArchive(archive);
  const directory = resolve(outputDirectory);
  const archiveName = `${manifest.rootDirectory}.tar.gz`, manifestName = `${manifest.rootDirectory}.manifest.json`;
  const archivePath = join(directory, archiveName), manifestPath = join(directory, manifestName), checksumsPath = join(directory, "SHA256SUMS");
  const sums = Buffer.from(`${sha(archive)}  ${archiveName}\n${sha(manifestBytes)}  ${manifestName}\n`);
  const existing = await lstat(directory).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory() || (await readdir(directory)).length)) fail("Output directory already exists with contents; use a new or empty directory to avoid collisions");
  await mkdir(directory, { recursive: true });
  const written = [];
  try {
    for (const [path, bytes] of [[archivePath, archive], [manifestPath, manifestBytes], [checksumsPath, sums]]) {
      const handle = await open(path, "wx", 0o644); written.push(path);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
    }
  } catch {
    for (const path of written) await rm(path, { force: true });
    fail("Could not write release output without a collision; use a new writable output directory");
  }
  return { version: manifest.version, tag: `v${manifest.version}`, rootName: manifest.rootDirectory, manifest, archivePath, manifestPath, checksumsPath };
}

function decompress(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18 || buffer.length > MAX_ARCHIVE) fail("Invalid gzip archive or compressed size limit");
  if (!buffer.subarray(0, 10).equals(Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 2, 255]))) fail("Invalid or noncanonical gzip archive header");
  let result;
  try { result = inflateRawSync(buffer.subarray(10, -8), { maxOutputLength: MAX_ARCHIVE, info: true }); }
  catch { fail("Invalid gzip archive or decompressed size limit exceeded"); }
  const tar = result.buffer;
  if (result.engine.bytesWritten !== buffer.length - 18 || buffer.readUInt32LE(buffer.length - 8) !== crc32(tar) || buffer.readUInt32LE(buffer.length - 4) !== tar.length) fail("Invalid gzip archive checksum, size or trailing compressed data");
  return tar;
}

function readTar(tar) {
  if (tar.length < 1024 || tar.length % 512 !== 0) fail("Malformed tar archive length");
  const files = new Map(); let offset = 0, root, previous = "";
  const text = bytes => {
    const end = bytes.indexOf(0), value = bytes.subarray(0, end < 0 ? bytes.length : end);
    if ([...value].some(byte => byte > 127)) fail("Unsafe tar path encoding");
    return value.toString("ascii");
  };
  const octal = bytes => {
    if (!/^[0-7]+\0$/.test(bytes.toString("ascii"))) fail("Malformed tar numeric header");
    return parseInt(bytes.toString("ascii"), 8);
  };
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset !== 1024 || !tar.subarray(offset).every(byte => byte === 0)) fail("Malformed tar archive end or trailing data");
      if (!files.size) fail("Empty tar archive");
      return { root, files };
    }
    if (files.size >= MAX_ENTRIES + 1) fail("Archive entry limit exceeded");
    const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100));
    const full = prefix ? `${prefix}/${name}` : name;
    const size = octal(header.subarray(124, 136)), mode = octal(header.subarray(100, 108));
    if (!header.equals(tarHeader(full, size, mode))) fail("Unsafe or noncanonical tar header (links and metadata are forbidden)");
    const slash = full.indexOf("/");
    if (slash < 1) fail("Unsafe archive root path");
    const entryRoot = full.slice(0, slash), path = full.slice(slash + 1);
    safePath(entryRoot); safePath(path);
    if (root && root !== entryRoot) fail("Inconsistent archive root");
    root = entryRoot;
    if (files.has(path)) fail("Duplicate archive path");
    if (previous && previous >= path) fail("Noncanonical archive entry order");
    previous = path;
    const end = offset + 512 + size, paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (paddedEnd > tar.length - 1024) fail("Truncated tar archive payload");
    if (!tar.subarray(end, paddedEnd).every(byte => byte === 0)) fail("Unsafe tar padding");
    files.set(path, { bytes: tar.subarray(offset + 512, end), mode });
    offset = paddedEnd;
  }
  fail("Missing tar archive end");
}

function validateManifest(bytes, root, files) {
  const manifest = parseJson(bytes, "release manifest");
  if (!exactKeys(manifest, ["schema", "owner", "version", "sourceCommit", "repository", "rootDirectory", "files"]) || manifest.schema !== 1 || manifest.owner !== OWNER || typeof manifest.version !== "string" || !VERSION.test(manifest.version) || manifest.version.length > 80 || typeof manifest.sourceCommit !== "string" || !COMMIT.test(manifest.sourceCommit) || manifest.repository !== REPOSITORY || manifest.rootDirectory !== `${OWNER}-${manifest.version}` || manifest.rootDirectory !== root || !object(manifest.files)) fail("Invalid release manifest metadata");
  if (!serialize(manifest).equals(bytes)) fail("Release manifest is not canonical JSON");
  const paths = Object.keys(manifest.files);
  checkMembership(paths);
  if (paths.length === 0 || paths.join("\0") !== [...paths].sort().join("\0") || paths.length + 1 !== files.size) fail("Release manifest membership mismatch");
  for (const path of paths) {
    const entry = manifest.files[path], file = files.get(path);
    if (!exactKeys(entry, ["sha256", "mode"]) || !HASH.test(entry.sha256) || ![0o644, 0o755].includes(entry.mode)) fail("Invalid release manifest file entry");
    if (!file || sha(file.bytes) !== entry.sha256 || file.mode !== entry.mode) fail("Release manifest file hash, membership or mode mismatch");
  }
  if (files.get("RELEASE.json").mode !== 0o644) fail("Unsafe release manifest mode");
  return manifest;
}

// No extraction, subprocesses, or filesystem access. Only our normalized regular-file format is accepted.
export function verifyReleaseArchive(buffer, { expectedSha256 } = {}) {
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !HASH.test(expectedSha256) || !Buffer.isBuffer(buffer) || sha(buffer) !== expectedSha256)) fail("Archive SHA256 checksum mismatch");
  const { root, files } = readTar(decompress(buffer));
  const embedded = files.get("RELEASE.json");
  if (!embedded) fail("Missing embedded release manifest");
  const manifest = validateManifest(embedded.bytes, root, files);
  for (const [path, file] of files) scan(path, file.bytes);
  return { manifest, files: new Map([...files].map(([path, file]) => [path, file.bytes])) };
}

async function outputFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail("Unsafe release output file or size limit exceeded");
  const bytes = await readFile(path);
  if (bytes.length > limit) fail("Release output size limit exceeded");
  return bytes;
}

export async function verifyReleaseDirectory(directory) {
  directory = resolve(directory);
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("Unsafe release directory");
  const names = (await readdir(directory)).sort();
  const archives = names.filter(name => /^herdr-workspace-.+\.tar\.gz$/.test(name));
  if (names.length !== 3 || archives.length !== 1) fail("Release directory must contain exactly one release trio and no unexpected files");
  const archiveName = archives[0], manifestName = archiveName.replace(/\.tar\.gz$/, ".manifest.json");
  if (!names.includes(manifestName) || !names.includes("SHA256SUMS")) fail("Missing matching release trio");
  const archivePath = join(directory, archiveName), manifestPath = join(directory, manifestName), checksumsPath = join(directory, "SHA256SUMS");
  const archive = await outputFile(archivePath, MAX_ARCHIVE), standalone = await outputFile(manifestPath, MAX_FILE), sums = await outputFile(checksumsPath, 1024);
  const expected = Buffer.from(`${sha(archive)}  ${archiveName}\n${sha(standalone)}  ${manifestName}\n`);
  if (!sums.equals(expected)) fail("Release directory SHA256 checksum mismatch");
  const result = verifyReleaseArchive(archive);
  if (`${result.manifest.rootDirectory}.tar.gz` !== archiveName || !result.files.get("RELEASE.json").equals(standalone)) fail("Embedded and standalone release manifest must be exactly equal and match the archive name");
  return { ...result, archivePath, manifestPath, checksumsPath };
}
