import { OWNER, bindingIsLive, bindingKey } from "./contracts.mjs";
import { collectSnapshots, reconcileBinding } from "./transport.mjs";
import { dispatchPending } from "./pending.mjs";

// Claude fires no hook for /rename, so the stored title is reconciled against the transcript on every refresh.
export async function reconcileClaudeTitles(runtime) {
  const bindings = (await runtime.store.listBindings()).filter(b => b.mode === "inherited" && b.session.harness === "claude");
  if (!bindings.length) return;
  let sdk;
  try { sdk = runtime.sdk ?? await import("@anthropic-ai/claude-agent-sdk"); } catch { return; }
  for (const binding of bindings) {
    try {
      const info = await sdk.getSessionInfo(binding.session.id, binding.lookupDir ? { dir: binding.lookupDir } : {});
      const title = info?.sessionId === binding.session.id ? info.customTitle ?? info.summary : null;
      if (typeof title !== "string" || !title || /[\x00-\x1f\x7f]/.test(title)) continue;
      await runtime.store.withMutation(binding.session, async () => {
        const record = await runtime.store.read(binding.session);
        if (!record || record.ended || record.canonicalTitle === title) return;
        if (!record.bindings.some(b => b.key === bindingKey(binding) && b.generation === binding.generation)) return;
        const external = Boolean(record.lastManagedTitle) && record.lastManagedTitle !== title;
        await runtime.store.write({ ...record, revision: record.revision + 1, canonicalTitle: title,
          manualOverride: record.manualOverride || external, pendingRename: external ? null : record.pendingRename }, record.revision);
      });
    } catch {} // One unreadable transcript must not block the other sessions.
  }
}
export async function refreshView(runtime, peers = []) {
  await reconcileClaudeTitles(runtime);
  const terminals = [];
  for (const binding of await runtime.store.listBindings()) {
    if (binding.mode !== "inherited" || !await bindingIsLive(binding, runtime.run)) continue;
    const r = await runtime.run("local", "hc", ["get", binding.terminal, "--json"], { env: { HC_SESSION: binding.coreSession } });
    if (r.code === 0) try { terminals.push({ ...JSON.parse(r.stdout), address: binding.terminal }); } catch {}
  }
  const local = await runtime.store.view(terminals);
  const remote = await collectSnapshots(peers, runtime.run);
  const entries = [...local.entries];
  for (const snapshot of remote.snapshots) for (const entry of snapshot.entries) {
    const peer = peers.find(p => p.host === entry.record.session.host);
    if (!peer) continue;
    if (entry.binding.mode === "paired") {
      if (!await reconcileBinding(entry.binding, peer, runtime)) continue;
      if (await runtime.store.activationMode() === "active" && entry.record.pendingRename) {
        const record = await dispatchPending(entry, peer, runtime);
        if (record) entry.record = record;
      }
    } else {
      // The producer revalidates native remote-core bindings; qualify only the view address.
      entry.binding = { ...entry.binding, viewTerminal: `${peer.target}/${entry.binding.terminal}` };
    }
    entries.push(entry);
  }
  const view = { schema: 1, owner: OWNER, updatedAt: runtime.clock(), entries, errors: remote.errors };
  await runtime.store.publish(view);
  return view;
}
