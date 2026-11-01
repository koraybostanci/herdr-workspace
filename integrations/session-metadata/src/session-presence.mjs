import { OWNER, bindingKey, validBinding, producerMatches } from "./contracts.mjs";
import { registryBindingKey } from "./session-registry.mjs";
import { callPeer, ownerIsLive, reconcileBinding } from "./transport.mjs";

export async function probeSessionBinding(binding, { run, env = {} }) {
  const result = (state, reason, extra = {}) => ({ state, reason, binding: { ...binding, ...extra } });
  if (!validBinding(binding)) return result("unknown", "invalid-binding");
  const options = { env: { HC_SESSION: binding.coreSession ?? env.HC_SESSION ?? "default" } };
  try {
    if (binding.mode === "paired") {
      if (!binding.ownerPid || !binding.ownerStartedAt) return result("unknown", "paired-owner-unverified");
      const process = await run("local", "ps", ["-o", "pid=", "-p", String(binding.ownerPid)], options);
      if (process.code !== 0) return result(process.code === 1 && !process.stdout?.trim() && !process.stderr?.trim() ? "closed" : "unknown", "paired-owner-unavailable");
      if (Number(process.stdout.trim()) !== binding.ownerPid) return result("unknown", "paired-owner-unverified");
      const start = await run("local", "ps", ["-o", "lstart=", "-p", String(binding.ownerPid)], options);
      if (start.code !== 0 || !start.stdout.trim()) return result("unknown", "paired-owner-unverified");
      if (start.stdout.trim() !== binding.ownerStartedAt) return result("closed", "paired-owner-replaced");
      return result(await ownerIsLive(binding, run) ? "open" : "unknown", "paired-owner");
    }
    const response = await run("local", "hc", ["get", binding.terminal, "--json"], options);
    if (response.code !== 0) {
      let kind;
      try { kind = JSON.parse(response.stderr || response.stdout).error?.kind; } catch {}
      return result(kind === "not_found" ? "closed" : "unknown", kind === "not_found" ? "terminal-missing" : "core-unavailable");
    }
    let term;
    try { term = JSON.parse(response.stdout); } catch { return result("unknown", "invalid-snapshot"); }
    if (!term || !["live", "finished"].includes(term.state) || !Number.isSafeInteger(term.created_ms)) return result("unknown", "invalid-snapshot");
    if (term.state === "finished" || term.created_ms !== binding.createdMs || !term.pid && term.reason) return result("closed", "terminal-ended-or-replaced");
    let proof;
    try { proof = JSON.parse(term.labels?.["herdr.meta-binding"] ?? "null"); } catch { return result("unknown", "invalid-proof"); }
    if (proof?.key !== bindingKey(binding) || proof.generation !== binding.generation) return result("closed", "binding-released");
    if (!term.labels?.["herdr.space"] || !term.labels["herdr.tab"]) return result("unknown", "space-unavailable");
    const process = await run("local", "ps", ["-o", "pid=", "-p", String(binding.processPid)], options);
    if (process.code !== 0) return result(process.code === 1 && !process.stdout?.trim() && !process.stderr?.trim() ? "closed" : "unknown", "producer-unavailable");
    if (Number(process.stdout.trim()) !== binding.processPid) return result("unknown", "producer-unverified");
    const start = await run("local", "ps", ["-o", "lstart=", "-p", String(binding.processPid)], options);
    const processStartedAt = start.code === 0 ? start.stdout.trim() : null;
    if (binding.processStartedAt && (!processStartedAt || processStartedAt !== binding.processStartedAt)) return result(processStartedAt ? "closed" : "unknown", "producer-replaced");
    if (!await producerMatches(term, binding.processPid, run, options)) return result("unknown", "foreground-unverified");
    return result("open", "verified", { processStartedAt, space: { host: binding.session.host, coreSession: binding.coreSession, id: term.labels["herdr.space"] },
      tab: term.labels["herdr.tab"], pane: binding.pane ?? null, address: binding.terminal, focused: false,
      activity: ["working", "blocked", "done", "idle"].includes(term.status) ? term.status : null });
  } catch { return result("unknown", "probe-unavailable"); }
}

export async function collectSessionPresence(runtime, peers = []) {
  const previous = runtime.previous ?? await runtime.store.readHistory?.();
  const known = (previous?.sessions ?? []).flatMap(entry => entry.bindings ?? []);
  const presence = [], sources = [];
  let bindings;
  try { bindings = await runtime.store.listBindings(); }
  catch { bindings = null; }
  for (const old of known.filter(b => !b.fromPeerId)) {
    if (bindings?.some(b => registryBindingKey(b) === registryBindingKey(old) && b.generation === old.generation)) continue;
    presence.push({ state: bindings ? "closed" : "unknown", binding: old, reason: bindings ? "binding-released" : "store-unavailable" });
  }
  for (const binding of bindings ?? []) {
    const old = known.find(b => !b.fromPeerId && registryBindingKey(b) === registryBindingKey(binding) && b.generation === binding.generation);
    const record = await runtime.store.read?.(binding.session).catch(() => null);
    presence.push(await probeSessionBinding({ ...old, ...binding, title: record?.canonicalTitle ?? old?.title,
      directory: binding.lookupDir ?? old?.directory }, runtime));
  }
  for (const peer of peers) {
    try {
      const reply = await callPeer(peer, ["presence-snapshot", "--json"], runtime.run);
      const snapshot = reply.code === 0 && JSON.parse(reply.stdout);
      if (snapshot?.schema !== 1 || snapshot.owner !== OWNER || !Array.isArray(snapshot.presence)
        || snapshot.presence.some(o => !validBinding(o.binding) || o.binding.session.host !== peer.host || !["open", "closed", "unknown"].includes(o.state))) throw Error("Invalid peer presence");
      const received = [];
      for (const observation of snapshot.presence) {
        let binding = { ...observation.binding, fromPeerId: peer.id };
        if (binding.mode === "inherited") binding = { ...binding, coreHost: peer.host, address: `${peer.target}/${binding.terminal}`,
          space: binding.space && { ...binding.space, id: `${peer.target}/${binding.space.id}` }, tab: binding.tab && `${peer.target}/${binding.tab}` };
        else {
          if (observation.state !== "open") {
            const old = known.find(b => b.fromPeerId === peer.id && registryBindingKey(b) === registryBindingKey(binding) && b.generation === binding.generation);
            if (old) received.push({ ...observation, binding: old });
            continue;
          }
          if (!await reconcileBinding(binding, peer, runtime)) throw Error("Pairing unavailable");
          const origin = await runtime.run("local", "hc", ["get", binding.terminal, "--json"], { env: { HC_SESSION: binding.coreSession } });
          const term = origin.code === 0 && JSON.parse(origin.stdout);
          if (!term?.labels?.["herdr.space"]) throw Error("Pairing location unavailable");
          binding = { ...binding, space: { host: "local", coreSession: binding.coreSession, id: term.labels["herdr.space"] },
            address: binding.terminal, tab: term.labels["herdr.tab"], pane: null, activity: term.status ?? null };
        }
        received.push({ ...observation, binding });
      }
      presence.push(...received);
      for (const old of known.filter(b => b.fromPeerId === peer.id)) if (!received.some(o => registryBindingKey(o.binding) === registryBindingKey(old) && o.binding.generation === old.generation)) {
        presence.push({ state: "closed", binding: old, reason: "peer-binding-released" });
      }
    } catch {
      for (const old of known.filter(b => b.fromPeerId === peer.id)) presence.push({ state: "unknown", binding: old, reason: "peer-unavailable" });
    }
  }
  // Unconfigured peers are not silently declared closed or contacted.
  for (const old of known.filter(b => b.fromPeerId && !peers.some(peer => peer.id === b.fromPeerId))) presence.push({ state: "unknown", binding: old, reason: "peer-unconfigured" });
  return { presence, sources };
}
