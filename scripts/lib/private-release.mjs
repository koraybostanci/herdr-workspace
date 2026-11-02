import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyReleaseDirectory, verifyReleaseSource } from "./release.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const runProcess = (command, args, options = {}) => new Promise(resolveResult => {
  execFile(command, args, { cwd: options.cwd, env: options.env ?? process.env, timeout: 1200000, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout, stderr) => resolveResult({ code: error ? Number.isInteger(error.code) ? error.code : 1 : 0, stdout: stdout ?? "", stderr: stderr ?? error?.message ?? "" }));
});
function repository(value) {
  if (typeof value !== "string") return null;
  const slug = value.replace(/^git\+/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git\/?$/, "").replace(/\/$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug) ? slug : null;
}

export async function publishPrivateBeta({ sourceRoot, directory, repo, publish = false, run = runProcess, verify = verifyReleaseDirectory,
  verifySource = verifyReleaseSource, platform = process.platform, nativeHostHome, tmpRoot = process.env.HERDR_WORKSPACE_TEST_TMPDIR ?? tmpdir() }) {
  if (platform !== "darwin") throw Error("Private-beta publication requires macOS so the real native-runtime gate can run.");
  sourceRoot = resolve(sourceRoot); directory = resolve(directory);
  const artifact = await verify(directory), manifest = artifact.manifest;
  const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const bundle = JSON.parse(await readFile(join(sourceRoot, "bundle.json"), "utf8"));
  const expectedRepo = repository(typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url);
  repo = repository(repo ?? manifest.repository);
  if (!repo || repo !== expectedRepo || repo !== repository(manifest.repository)) throw Error("Artifact, source package and requested repository must identify the same GitHub repository.");
  if (pkg.private !== true) throw Error("The source package must remain private.");
  if (manifest.schema !== 1 || manifest.owner !== "herdr-workspace" || !/^\d+\.\d+\.\d+-[A-Za-z0-9.-]+$/.test(manifest.version)
    || pkg.version !== manifest.version || bundle.version !== manifest.version) throw Error("Private-beta artifact must have the matching source prerelease version.");
  const version = manifest.version, tag = "v" + version;
  const execute = async (command, args, options = {}, { optional = false } = {}) => {
    const result = await run(command, args, options);
    if (result?.code !== 0) {
      if (optional && /\bHTTP 404\b/.test(result?.stderr ?? "")) return null;
      throw Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${String(result?.stderr ?? "command unavailable").slice(-1500)}`);
    }
    return result.stdout ?? "";
  };
  const api = async (endpoint, optional = false) => {
    const output = await execute("gh", ["api", endpoint], {}, { optional });
    if (output === null) return null;
    try { return JSON.parse(output); } catch { throw Error("GitHub returned invalid JSON; refusing publication."); }
  };
  const cleanCommit = async () => {
    const commit = (await execute("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).trim();
    const dirty = await execute("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: sourceRoot });
    if (dirty.trim()) throw Error("Publication requires a clean committed source tree.");
    if (!/^[a-f0-9]{40}$/.test(commit) || commit !== manifest.sourceCommit) throw Error("Artifact source commit does not match the current Git HEAD.");
    return commit;
  };
  const privateRepository = async () => {
    const info = await api(`repos/${repo}`);
    if (info?.private !== true) throw Error("Repository is not verified PRIVATE; refusing private-beta publication.");
    if (info.permissions?.push !== true && info.permissions?.admin !== true) throw Error("Authenticated GitHub write permission is required; no login or permission changes are performed automatically.");
  };
  const correctTag = async (required = false) => {
    let ref = (await api(`repos/${repo}/git/ref/tags/${tag}`, true))?.object;
    if (!ref && required) throw Error("Published release tag is missing; cannot verify its source commit.");
    const seen = new Set();
    while (ref?.type === "tag") {
      if (!/^[a-f0-9]{40}$/.test(ref.sha) || seen.has(ref.sha) || seen.size >= 5) throw Error("Tag cannot be safely resolved.");
      seen.add(ref.sha); ref = (await api(`repos/${repo}/git/tags/${ref.sha}`))?.object;
    }
    if (ref && (ref.type !== "commit" || ref.sha !== manifest.sourceCommit)) throw Error("Existing tag points to a different commit; tags are never moved or overwritten.");
  };
  const absentRelease = async () => {
    if (await api(`repos/${repo}/releases/tags/${tag}`, true)) throw Error("A release for this version already exists; existing releases and assets are never overwritten.");
    // The release-by-tag endpoint omits drafts. The paginated authenticated list includes them.
    for (let page = 1; page <= 100; page++) {
      const releases = await api(`repos/${repo}/releases?per_page=100${page === 1 ? "" : `&page=${page}`}`);
      if (!Array.isArray(releases)) throw Error("Cannot verify existing draft releases.");
      if (releases.some(release => release.tag_name === tag)) throw Error("A draft or published release for this version already exists; inspect it rather than retrying publication.");
      if (releases.length < 100) return;
    }
    throw Error("Release listing exceeded the safe pagination limit; refusing publication.");
  };
  const commit = await cleanCommit();
  await verifySource({ sourceRoot, manifest });
  await privateRepository();
  if ((await api(`repos/${repo}/commits/${commit}`))?.sha !== commit) throw Error("The tested commit must be pushed to the private repository first.");
  await correctTag();
  await absentRelease();
  const names = [`herdr-workspace-${version}.tar.gz`, `herdr-workspace-${version}.manifest.json`, "SHA256SUMS"];
  const paths = [artifact.archivePath, artifact.manifestPath, artifact.checksumsPath];
  const expectedHashes = new Map();
  for (let index = 0; index < paths.length; index++) {
    if (resolve(paths[index]) !== join(directory, names[index])) throw Error("Unexpected release asset path.");
    const info = await lstat(paths[index]);
    if (!info.isFile() || info.isSymbolicLink()) throw Error("Release assets must be regular files, not symlinks.");
    const bytes = await readFile(paths[index]); expectedHashes.set(names[index], hash(bytes));
    if (index === 1 && !isDeepStrictEqual(JSON.parse(bytes), manifest)) throw Error("Artifact manifest changed after verification.");
  }
  const base = { repo, version, tag, commit, assets: names };
  if (!publish) return { mode: "plan", ...base };

  const gates = [
    ["ci", "--ignore-scripts"],
    ["ci", "--ignore-scripts", "--prefix", "integrations/session-metadata"],
    ["test"], ["run", "check:privacy"], ["run", "test:clean-install"],
    ["run", "test:native-install", ...(nativeHostHome ? ["--", "--host-home", nativeHostHome] : [])],
  ];
  for (const args of gates) {
    const result = await run("npm", args, { cwd: sourceRoot });
    if (result?.code !== 0) throw Error(`Validation failed: npm ${args.join(" ")}. ${String(result?.stderr ?? "").slice(-1500)}`);
  }
  await cleanCommit(); await verifySource({ sourceRoot, manifest }); await privateRepository(); await correctTag(); await absentRelease();
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(tmpRoot, "private-release-"));
  let created = false;
  try {
    const notesPath = join(temporary, "notes.md");
    const notes = `# Private beta ${tag}\n\nSource: https://github.com/${repo}/tree/${commit}\n\n` +
      `This prerelease is available only to authorized users of this private repository. Do not make the repository public as part of installation.\n\n` +
      `Baseline: macOS, Herdr ${bundle.host?.version ?? "0.1.12"}, Node26+. Installer, privacy, clean-export and isolated real-native gates passed before publication. A second physical Mac acceptance test is still pending.\n\n` +
      `## Install\n\nAuthenticate your own GitHub CLI account and ensure it has repository read access. In a new empty download folder:\n\n` +
      "```sh\n" + `gh release download ${tag} --repo ${repo}\nshasum -a 256 -c SHA256SUMS\ntar -xzf ${names[0]}\ncd herdr-workspace-${version}\nnpm ci --ignore-scripts\nnode bin/herdr-workspace.mjs plan\nnode bin/herdr-workspace.mjs install\nnode bin/herdr-workspace.mjs doctor\nherdr-app do layout.switch '{"name":"herdr-workspace"}'\n` + "```\n\n" +
      `Stop on checksum failures or plan blockers. Harness integration is opt-in; see docs/private-beta.md and docs/installation.md for matching plan/install flags, upgrades, removal and SDK terms. No GitHub credentials are needed by the installed UI.\n\nArchive SHA-256: \`${expectedHashes.get(names[0])}\`\n`;
    await writeFile(notesPath, notes, { mode: 0o600 });
    await execute("gh", ["release", "create", tag, ...paths, "--repo", repo, "--target", commit, "--title", `herdr-workspace ${tag}`, "--notes-file", notesPath, "--draft", "--prerelease", "--latest=false"]);
    created = true;
    const view = async () => {
      const data = JSON.parse(await execute("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease,targetCommitish,tagName,url,assets"]));
      if (data.tagName !== tag || data.targetCommitish !== commit || data.isPrerelease !== true || !Array.isArray(data.assets)
        || data.assets.length !== names.length || !names.every(name => data.assets.some(asset => asset.name === name))) throw Error("Remote prerelease metadata or asset membership differs from the verified plan.");
      return data;
    };
    if ((await view()).isDraft !== true) throw Error("New release was not created as a draft.");
    const downloaded = join(temporary, "download"); await mkdir(downloaded, { mode: 0o700 });
    await execute("gh", ["release", "download", tag, "--repo", repo, "--dir", downloaded]);
    for (const name of names) if (hash(await readFile(join(downloaded, name))) !== expectedHashes.get(name)) throw Error("Downloaded release asset hash differs from the verified local bytes.");
    const remote = await verify(downloaded);
    if (!isDeepStrictEqual(remote.manifest, manifest)) throw Error("Downloaded artifact provenance differs from the verified source manifest.");
    await cleanCommit(); await verifySource({ sourceRoot, manifest }); await correctTag(); await privateRepository();
    await execute("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease", "--latest=false"]);
    await privateRepository(); await correctTag(true);
    const result = await view();
    if (result.isDraft !== false) throw Error("Release did not leave draft state.");
    return { mode: "published", ...base, url: result.url, checks: gates.map(args => `npm ${args.join(" ")}`) };
  } catch (error) {
    throw Error(error.message + (created ? ` Draft/prerelease ${tag} was left for owner inspection; no remote assets or tags were deleted or overwritten.` : ""));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
