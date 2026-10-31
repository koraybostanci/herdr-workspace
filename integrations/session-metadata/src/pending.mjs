import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, readJson } from "./store.mjs";
import { bindingKey, sessionKey } from "./contracts.mjs";
import { reconcileBinding, callPeer, ownerIsLive } from "./transport.mjs";
import { applyPendingRename } from "./engine.mjs";

export async function dispatchPending({ binding, record }, peer, deps) {
  if (!record.pendingRename || !await reconcileBinding(binding, peer, deps)) return null;
  const result = await callPeer(peer, ["apply-pending", "--session", sessionKey(record.session), "--generation", binding.generation,
    "--revision", String(record.revision)], deps.run, JSON.stringify({ session: record.session, generation: binding.generation,
    revision: record.revision, issuedAt: deps.clock(), expiresAt: deps.clock() + 5000, requestId: randomUUID() }));
  if (result.code !== 0) return null;
  const actual = JSON.parse(result.stdout).record;
  return actual?.revision > record.revision && sessionKey(actual.session) === sessionKey(record.session) ? actual : null;
}
export async function applyPeerPending(request, deps) {
  const now = deps.clock();
  if (!Number.isFinite(request.issuedAt) || request.issuedAt > now || request.expiresAt < now || request.expiresAt - request.issuedAt > 5000) return null;
  const binding = (await deps.store.listBindings()).find(b => b.mode === "paired" && b.generation === request.generation && sessionKey(b.session) === sessionKey(request.session));
  const validate = deps.validateOwner ?? (b => ownerIsLive(b, deps.run));
  if (!binding || !await validate(binding)) return null;
  return applyPendingRename(request.session, binding, request.revision, { ...deps,
    activationMode: deps.activationMode ?? (() => deps.store.activationMode()),
    validateBinding: b => deps.clock() <= request.expiresAt && validate(b),
    hasAuthority: async b => b.generation === request.generation && deps.clock() <= request.expiresAt });
}
export async function mailboxRequest(request, deps) {
  if (!/^[\w-]+$/.test(request.requestId ?? "")) return null;
  await deps.store.listBindings();
  const dir = join(deps.store.root, "mailbox");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const input = join(dir, request.requestId + ".request.json"), output = join(dir, request.requestId + ".ack.json");
  return new Promise((resolve, reject) => {
    let timer;
    const finish = async value => { clearTimeout(timer); watcher.close(); await unlink(input).catch(() => {}); await unlink(output).catch(() => {}); resolve(value); };
    const watcher = watch(dir, async (_event, name) => {
      if (name !== request.requestId + ".ack.json") return;
      const ack = await readJson(output);
      if (ack?.requestId === request.requestId) await finish(ack.record);
    });
    timer = setTimeout(() => { void finish(null); }, Math.max(1, Math.min(4500, request.expiresAt - deps.clock())));
    atomicJson(input, request).catch(e => { watcher.close(); clearTimeout(timer); reject(e); });
  });
}
export async function watchMailbox(deps, handler) {
  await deps.store.listBindings();
  const dir = join(deps.store.root, "mailbox");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const watcher = watch(dir, async (_event, name) => {
    if (!/^[\w-]+\.request\.json$/.test(name ?? "")) return;
    try {
      const request = await readJson(join(dir, name));
      if (!request) return;
      const record = await handler(request);
      if (record) await atomicJson(join(dir, name.replace(".request.json", ".ack.json")), { requestId: request.requestId, record });
    } catch {} // Expired or foreign requests do not affect the owner.
  });
  return () => watcher.close();
}
