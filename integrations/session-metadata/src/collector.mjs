import { OWNER, bindingIsLive } from "./contracts.mjs";
import { collectSnapshots, reconcileBinding } from "./transport.mjs";
import { dispatchPending } from "./pending.mjs";

export async function refreshView(runtime, peers = []) {
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
