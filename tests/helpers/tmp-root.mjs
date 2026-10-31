import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test scratch root: HERDR_WORKSPACE_TEST_TMPDIR when set, else a private folder under the OS temp dir.
export function testTmpRoot() {
  const base = process.env.HERDR_WORKSPACE_TEST_TMPDIR || join(tmpdir(), "herdr-workspace-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return realpathSync(base);
}
