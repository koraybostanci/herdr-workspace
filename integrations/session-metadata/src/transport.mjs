import { randomBytes, randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, readJson } from "./store.mjs";
import { OWNER, bindingKey, validBinding, validSession, validateSnapshot, blankRecord, isHerdrTerminal, commitBinding, bindingIsLive, foregroundProcess } from "./contracts.mjs";

const digest = token => createHash("sha256").update(token).digest("hex");
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const safeName = value => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(value);
export function peerInvocation(peer, args, input) {
  if (!safeName(peer.id) || !safeName(peer.host) || !safeName(peer.target) || !["hc", "ssh"].includes(peer.transport)) throw new Error("Invalid configured execution peer");
  if ([peer.helperPath, peer.node].some(p => p && /[\x00-\x1f]/.test(p))) throw new Error("Invalid peer helper path");
  const separator = args.indexOf("--");
  const tail = separator < 0 ? [...args, "--host", peer.host] : [...args.slice(0, separator), "--host", peer.host, ...args.slice(separator)];
  if (peer.transport === "hc") return { command: "hc", args: ["exec", "-i", "--timeout", "5", "--on", peer.target, "--", peer.node ?? "node", peer.helperPath ?? ".config/herdr-app/integrations/session-metadata/bin/herdr-session-meta.mjs", ...tail], options: { timeout: 5000, input } };
  const helper = peer.helperPath ? quote(peer.helperPath) : '"$HOME/.config/herdr-app/integrations/session-metadata/bin/herdr-session-meta.mjs"';
  const remote = [quote(peer.node ?? "node"), helper, ...tail.map(quote)].join(" ");
  return { command: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", peer.target, remote], options: { timeout: 5000, input } };
}
export async function callPeer(peer, args, run, input) {
  const request = peerInvocation(peer, args, input);
  return run("local", request.command, request.args, request.options);
}
export async function collectSnapshots(peers, run) {
  const snapshots = [], errors = [];
  const ids = new Set();
  const results = await Promise.allSettled(peers.map(async peer => {
    if (ids.has(peer.id)) throw new Error("Duplicate peer");
    ids.add(peer.id);
    const result = await callPeer(peer, ["snapshot", "--json"], run);
    if (result.code !== 0) throw new Error("Peer unavailable");
    const snapshot = validateSnapshot(JSON.parse(result.stdout));
    if (!snapshot || snapshot.entries.some(e => e.record.session.host !== peer.host)) throw new Error("Invalid peer snapshot");
    return snapshot;
  }));
  results.forEach((r, i) => r.status === "fulfilled" ? snapshots.push(r.value) : errors.push({ peer: peers[i].id, reason: "unavailable-or-invalid" }));
  return { snapshots, errors };
}
function offerPath(store, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid pairing token");
  return join(store.root, "offers", hash + ".json");
}
export async function createPairing({ terminal, peer, harness, sessionId = null }, deps) {
  if (!["opencode-v2", "claude"].includes(harness) || !terminal) throw new Error("Pairing target required");
  const result = await deps.run("local", "hc", ["get", terminal, "--json"], { env: { HC_SESSION: deps.env.HC_SESSION ?? "default" } });
  const term = result.code === 0 && JSON.parse(result.stdout);
  if (!isHerdrTerminal(term) || term.state !== "live") throw new Error("Target is not a live Herdr terminal");
  const pid = await foregroundProcess(term, deps.run);
  if (!pid) throw new Error("Target foreground process unavailable");
  await deps.store.listBindings();
  const token = randomBytes(24).toString("hex");
  const expiresAt = deps.clock() + 60000;
  const offer = { schema: 1, owner: OWNER, tokenHash: digest(token), peer: peer.id, host: peer.host, harness, sessionId, expiresAt,
    origin: { coreHost: "local", coreSession: deps.env.HC_SESSION ?? "default", terminal, createdMs: term.created_ms, processPid: pid } };
  await atomicJson(offerPath(deps.store, offer.tokenHash), offer);
  const sent = await callPeer(peer, ["offer"], deps.run, JSON.stringify(offer));
  if (sent.code !== 0) throw new Error("Pairing peer unavailable");
  return { token, expiresAt };
}
export async function installOffer(offer, { store, clock }) {
  if (offer?.schema !== 1 || offer.owner !== OWNER || !safeName(offer.host) || !["opencode-v2", "claude"].includes(offer.harness)) throw new Error("Invalid pairing offer");
  bindingKey(offer.origin);
  await store.listBindings();
  const path = offerPath(store, offer.tokenHash);
  const old = await readJson(path);
  if (old) {
    if (JSON.stringify(old.origin) !== JSON.stringify(offer.origin) || old.sessionId !== offer.sessionId) throw new Error("Pairing mismatch");
    return;
  }
  await atomicJson(path, { ...offer, expiresAt: clock() + 60000 });
}
export async function ownerStamp(pid, run) {
  const r = await run("local", "ps", ["-o", "lstart=", "-p", String(pid)]);
  return r.code === 0 ? r.stdout.trim() : "";
}
export async function ownerIsLive(binding, run) {
  if (!binding.ownerPid || !binding.ownerStartedAt || await ownerStamp(binding.ownerPid, run) !== binding.ownerStartedAt) return false;
  const r = await run("local", "ps", ["-o", "stat=,pgid=,tpgid=", "-p", String(binding.ownerPid)]);
  const fields = r.stdout.trim().split(/\s+/);
  return r.code === 0 && fields.length === 3 && !fields[0].includes("T") && Number(fields[1]) > 0 && Number(fields[1]) === Number(fields[2]);
}
export async function acceptPairing(token, liveSession, deps) {
  if (!/^[a-f0-9]{48}$/.test(token) || !validSession(liveSession.key) || liveSession.parentId) throw new Error("Invalid pairing identity");
  const hash = digest(token), path = offerPath(deps.store, hash);
  const offer = await readJson(path);
  if (!offer || offer.owner !== OWNER || offer.expiresAt < deps.clock()) throw new Error("Pairing expired or missing");
  if (offer.host !== liveSession.key.host || offer.harness !== liveSession.key.harness || offer.sessionId && offer.sessionId !== liveSession.key.id) throw new Error("Pairing host/session mismatch");
  const stamp = deps.ownerStartedAt ?? await ownerStamp(deps.producerPid, deps.run);
  if (!stamp) throw new Error("Pairing producer unavailable");
  try { await fs.writeFile(path + ".used", "used", { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e.code === "EEXIST") throw new Error("Pairing token already used"); throw e; }
  const binding = { ...offer.origin, generation: randomUUID(), session: liveSession.key, lookupDir: liveSession.lookupDir,
    mode: "paired", offerId: hash, peerId: offer.peer, ownerPid: deps.producerPid, ownerStartedAt: stamp };
  const oldBinding = await deps.store.getBinding(bindingKey(binding));
  if (!await deps.store.bind(binding, oldBinding?.generation ?? null)) throw new Error("Pairing revision changed");
  const old = await deps.store.read(liveSession.key);
  const record = { ...(old ?? blankRecord(liveSession.key)), canonicalTitle: liveSession.title, ended: false,
    revision: old ? old.revision + 1 : 0,
    bindings: [...(old?.bindings ?? []).filter(b => b.key !== bindingKey(binding)), { key: bindingKey(binding), generation: binding.generation }] };
  if (!await deps.store.write(record, old?.revision ?? null)) throw new Error("Pairing record changed");
  return binding;
}
export async function reconcileBinding(binding, peer, deps) {
  if (!validBinding(binding) || binding.mode !== "paired" || binding.session.host !== peer.host || binding.peerId !== peer.id) return false;
  const old = await deps.store.getBinding(bindingKey(binding));
  if (old?.generation !== binding.generation) {
    const offer = await readJson(offerPath(deps.store, binding.offerId));
    const renewal = old && old.generation === binding.previousGeneration && old.ownerPid === binding.ownerPid
      && old.ownerStartedAt === binding.ownerStartedAt && old.session.host === binding.session.host && old.session.harness === binding.session.harness;
    if (!renewal && (!offer || offer.expiresAt < deps.clock() || offer.accepted || offer.host !== peer.host || offer.harness !== binding.session.harness
      || offer.sessionId && offer.sessionId !== binding.session.id || JSON.stringify(offer.origin) !== JSON.stringify({ coreHost: binding.coreHost, coreSession: binding.coreSession, terminal: binding.terminal, createdMs: binding.createdMs, processPid: binding.processPid }))) return false;
    if (!await commitBinding(binding, { ...deps, allowPaired: true })) return false;
    if (offer && !offer.accepted) await atomicJson(offerPath(deps.store, binding.offerId), { ...offer, accepted: true });
  }
  return bindingIsLive(binding, deps.run, true);
}
export async function launchPaired({ peer, harness, argv = [] }, deps) {
  const issued = await createPairing({ terminal: deps.env.HC_TERMINAL_ID, peer, harness }, deps);
  const request = peerInvocation(peer, ["launch-local", "--harness", harness, "--pair-token", issued.token, "--", ...argv]);
  if (peer.transport === "ssh") request.args.unshift("-t");
  return deps.launch(request.command, request.args);
}
