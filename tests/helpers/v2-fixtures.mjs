import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
import { testTmpRoot } from './tmp-root.mjs';
export const scratch = testTmpRoot();
export const session = {host:'local', authority:'local', harness:'opencode-v2', id:'ses_plan_A'};
export const proof = {channel:'plan', session, coreHost:'local', coreSession:'fixture', terminal:'t-plan', createdMs:100,
  processPid:20, processStartedAt:'fixture-start', generation:'generation-A', epoch:2, verifiedAt:1000, leaseUntil:46000};
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
export async function v2Fixture(overrides = {}) {
  const root = await mkdtemp(join(scratch, 'herdr-plan-test-'));
  const {openDatabase} = await import('../../integrations/session-metadata/src/database.mjs');
  const db = openDatabase({root:join(root, 'v2')});
  const calls = [], clock = () => 1000;
  return {root, db, session, proof, clock, calls,
    run: async (...args) => { calls.push(args); return {code:1, stdout:'', stderr:'unavailable'}; },
    cleanup: async () => { db.close(); await rm(root, {recursive:true, force:true}); }, ...overrides};
}
