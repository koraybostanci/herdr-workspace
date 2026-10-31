import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadBundle } from "../../src/bundle.mjs";
import { repoRoot } from "./bundle-export.mjs";
import { hostFixture, fakeRun } from "./host-fixture.mjs";
import { testTmpRoot } from "./tmp-root.mjs";

export const NODE = process.execPath;

// Private isolated HOME + compatible synthetic Herdr app home + state root, with a controlled command runner.
// Cleanup only removes paths created here.
export async function installHome(t, { sourceRoot = repoRoot, hostOptions, tools } = {}) {
  const bundle = await loadBundle(sourceRoot);
  const home = await mkdtemp(join(testTmpRoot(), "home-"));
  t?.after(() => rm(home, { recursive: true, force: true }));
  const appHome = join(home, ".config/herdr-app");
  await mkdir(appHome, { recursive: true });
  const host = await hostFixture(t, bundle, hostOptions);
  const { cp } = await import("node:fs/promises");
  await cp(host, appHome, { recursive: true });
  const calls = [];
  const base = fakeRun({ node: { code: 0, stdout: "" }, git: { code: 0, stdout: "git version 2" }, gh: { code: 0, stdout: "gh 2" }, "herdr-app": { code: 0, stdout: "herdr-app 0.1.9" }, ...tools });
  // npm ci is simulated: it records the call and creates the dependency folders the lockfile would install.
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === "npm" && run.noNpm) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    if (command === "npm" && args[0] !== "ci") return { code: 0, stdout: "10.0.0\n", stderr: "" };
    if (command === "npm") {
      if (run.failNpm) return { code: 1, stdout: "", stderr: "registry unreachable" };
      for (const dep of ["jsonc-parser", "@anthropic-ai/claude-agent-sdk"]) {
        await mkdir(join(options.cwd, "node_modules", dep), { recursive: true });
        await writeFile(join(options.cwd, "node_modules", dep, "package.json"), "{}\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "--input-type=module") return { code: 0, stdout: "", stderr: "" };
    return base(command, args, options);
  };
  run.calls = calls;
  const paths = {
    home, appHome, stateRoot: join(home, "state/herdr-agent-metadata"),
    opencodePath: join(home, ".config/opencode/cli.json"), claudePath: join(home, ".claude/settings.json"),
  };
  const write = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  return { bundle, sourceRoot, ...paths, run, write, read: path => readFile(path, "utf8").catch(e => e.code === "ENOENT" ? null : Promise.reject(e)),
    list: async dir => (await readdir(dir, { recursive: true }).catch(() => [])).sort() };
}

// Synthetic settings: JSONC comments, provider/model/credential-helper fields and unrelated hooks.
export const OPENCODE_SETTINGS = `{
  // keep this comment
  "provider": { "example": { "options": { "baseURL": "https://llm.example.test/v1" } } },
  "model": "example/model-x",
  "plugins": ["other-plugin"]
}
`;
export const CLAUDE_SETTINGS = JSON.stringify({
  apiKeyHelper: "/usr/local/bin/example-key-helper",
  env: { KEEP_ME: "1" },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "unrelated-hook" }] }] },
}, null, 2) + "\n";
