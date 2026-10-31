import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStore } from "../../integrations/session-metadata/src/store.mjs";
import { applyObservation } from "../../integrations/session-metadata/src/engine.mjs";
import { metadataFixture } from "./session-metadata-fixtures.mjs";
const [root, role] = process.argv.slice(2);
const f = metadataFixture();
const store = createStore({ root, viewFile: join(root, "view.json") });
const context = structuredClone(f.context);
if (role === "B") {
  const old = context.prs[context.activePrUrl];
  context.activePrUrl = "https://github.com/team/repo-a/pull/6105";
  context.prs = { [context.activePrUrl]: { ...old, number: 6105, url: context.activePrUrl } };
}
const access = {
  get: async key => ({ key, title: await readFile(join(root, "harness-title"), "utf8"), parentId: null }),
  rename: async (_key, title) => {
    process.send({ type: "rename", role });
    if (role === "A") await new Promise(resolve => process.once("message", resolve));
    await writeFile(join(root, "harness-title"), title);
  },
};
process.send({ type: "ready", role });
try {
  const result = await applyObservation({ ...f.observation, eventId: role, observedAt: role === "A" ? 1000 : 2000 }, f.binding,
    { store, access, clock: Date.now, activationMode: async () => "active", validateBinding: async () => true,
      hasAuthority: async () => true, resolveContext: async () => ({ state: "resolved", context }) });
  process.send({ type: "done", state: result.state, role });
} finally { process.disconnect(); }
