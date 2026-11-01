import test from "node:test";
import assert from "node:assert/strict";
import { exportBundle } from "./helpers/bundle-export.mjs";
import { testTmpRoot } from "./helpers/tmp-root.mjs";
import { runCleanInstall } from "../scripts/test-clean-install.mjs";

test("installed checked release serves scoped history and uninstall retains its private catalog", async t => {
  const exportRoot = await exportBundle(t);
  const result = await runCleanInstall({ exportRoot, tmpRoot: testTmpRoot() });
  assert.deepEqual(result.checks.filter(c => !c.ok), []);
  for (const name of ["installed helper serves Space-filtered history", "uninstall retains private session history"]) {
    assert.ok(result.checks.some(c => c.name === name && c.ok), name);
  }
  const reads = result.commands.filter(c => c.args.includes("history-view"));
  assert.equal(reads.length, 2);
  for (const read of reads) assert.match(read.args[0], /\/integrations\/session-metadata\/releases\/[a-f0-9-]{36}\/bin\/herdr-session-meta\.mjs$/);
  assert.equal(result.liveHomeTouched, false);
});
