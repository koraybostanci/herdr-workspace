import { testTmpRoot } from "./tmp-root.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../../integrations/session-metadata/src/store.mjs";

export const scratch = testTmpRoot();
export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export function metadataFixture(overrides = {}) {
  const key = { host: "local", authority: "local", harness: "opencode-v2", id: "ses_fixture_A" };
  const binding = { coreHost: "local", coreSession: "default", terminal: "t-fixture", createdMs: 100,
    processPid: 20, generation: "generation-A", session: key, lookupDir: "/parent", mode: "inherited" };
  const repo = { host: "github.com", owner: "team", name: "repo-a" };
  const url = "https://github.com/team/repo-a/pull/6104";
  const pr = { repo, number: 6104, url, state: "OPEN", title: "PROJ-101 Features", headRefName: "proj-101-features", headRepo: repo, verifiedAt: 1000 };
  const context = { host: "local", gitRoot: "/parent/repo-a", cwd: "/parent/repo-a", repo, subdir: null,
    branch: "proj-101-features", ticket: { id: "PROJ-101", source: "task" }, prs: { [url]: pr }, activePrUrl: url, lastCreatedPrUrl: url };
  const record = { schema: 1, session: key, revision: 0, canonicalTitle: "Features", lastManagedTitle: null,
    manualOverride: false, description: "Features", contexts: { "github.com/team/repo-a": context }, activeRepo: "github.com/team/repo-a",
    bindings: [], pendingRename: null, seenEvents: [], lastObservedAt: 0, ended: false };
  const observation = { session: key, generation: binding.generation, eventId: "event-1", kind: "task", observedAt: 1000,
    parentId: null, payload: { prompt: "Implement PROJ-101 Features", cwd: "/parent/repo-a" } };
  const titleInput = { currentTitle: "Features", lastManagedTitle: null, manualOverride: false, description: "Features", context };
  const calls = [];
  const access = { get: async () => ({ key, title: record.canonicalTitle, parentId: null, lookupDir: "/parent" }),
    rename: async (_key, title) => { calls.push(title); record.canonicalTitle = title; } };
  return { key, binding, record, context, observation, titleInput, access, calls, ...overrides };
}
export async function isolatedFixture() {
  const root = await mkdtemp(join(scratch, "herdr-meta-test-"));
  return { ...metadataFixture(), root, store: createStore({ root, viewFile: join(root, "view.json"), clock: () => 1000 }),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
