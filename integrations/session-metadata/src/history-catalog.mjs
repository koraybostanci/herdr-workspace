import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { OWNER, validSession } from "./contracts.mjs";
import { readJson } from "./store.mjs";
import { normalizedDirectory, reconcileSessionRegistry, sessionIdentityKey, validateRegistry } from "./session-registry.mjs";
import { collectSessionPresence } from "./session-presence.mjs";
import { callPeer } from "./transport.mjs";

const sourceKey = s => JSON.stringify([s.host, s.authority, s.harness]);
const clean = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim() : "";
const failure = (source, entries = []) => ({ entries, next: null, complete: false,
  source: { ...source, state: entries.length ? "partial" : "unavailable", complete: false, errorCode: "source-unavailable" } });
function entry(source, id, title, directory, updatedAt) {
  const session = { host: source.host, authority: source.authority, harness: source.harness, id };
  if (!validSession(session) || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw Error("Invalid native session");
  return { session, title: clean(title) || (source.harness === "claude" ? "Claude Code" : "OpenCode"),
    directory: normalizedDirectory(directory), updatedAt, sourceId: source.id, saved: "available", associations: [], bindings: [] };
}
export async function discoverClaudeSessions({ sdk, source, limit = 100, offset = 0 }) {
  try {
    const values = await sdk.listSessions({ limit, offset, includeProgrammatic: true });
    if (!Array.isArray(values) || values.length > limit) throw Error("Invalid Claude page");
    const entries = values.filter(v => !v.parentID && !v.agentId).map(v => entry(source, v.sessionId, v.customTitle || v.summary, v.cwd, v.lastModified));
    const complete = values.length < limit;
    return { entries, next: complete ? null : offset + values.length, complete, source: { ...source, state: "ready", complete, errorCode: null } };
  } catch { return failure(source); }
}
export async function openCodeRequest(run, source, path, params = []) {
  if (!source.server) {
    const status = await run("local", "opencode", ["service", "status"]);
    if (status.code !== 0 || !/^https?:\/\/[^\s]+$/.test(status.stdout.trim())) throw Error("OpenCode service unavailable");
  }
  const args = ["api", "get", path, ...params.flatMap(value => ["--param", value]), ...(source.server ? ["--server", source.server] : [])];
  const response = await run("local", "opencode", args);
  if (response.code !== 0) {
    let name;
    for (const line of `${response.stdout ?? ""}\n${response.stderr ?? ""}`.split(/\r?\n/)) {
      try { const error = JSON.parse(line); name = error._tag ?? error.name ?? error.error?.name; if (name) break; } catch {}
    }
    return { missing: name === "SessionNotFoundError", unavailable: true };
  }
  return { value: JSON.parse(response.stdout) };
}
export async function discoverOpenCodeSessions({ run, source, limit = 100, cursor = null }) {
  try {
    const result = await openCodeRequest(run, source, "/api/session", ["parentID=null", `limit=${limit}`, ...(cursor ? [`cursor=${cursor}`] : [])]);
    const value = result.value;
    if (!Array.isArray(value?.data) || !value.cursor || value.data.length > limit || value.cursor.next != null && typeof value.cursor.next !== "string") throw Error("Invalid OpenCode page");
    const entries = value.data.filter(v => !v.parentID).map(v => entry(source, v.id, v.title, v.location?.directory, v.time?.updated));
    return { entries, next: value.cursor.next ?? null, complete: !value.cursor.next,
      source: { ...source, state: "ready", complete: !value.cursor.next, errorCode: null } };
  } catch { return failure(source); }
}
export async function historySources(runtime) {
  const host = runtime.env?.HERDR_METADATA_HOST ?? "local";
  let config = null;
  if (runtime.historySources === undefined) {
    try { config = JSON.parse(await readFile(join(runtime.root, "history-sources.json"), "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw Error("Invalid history source configuration"); }
  }
  if (config && (config.owner !== OWNER || config.schema !== 1)) throw Error("Invalid history source owner");
  const configured = runtime.historySources ?? config?.sources;
  const sources = configured ?? [{ host, authority: "claude", harness: "claude" }, { host, authority: "local", harness: "opencode-v2" }];
  if (!Array.isArray(sources)) throw Error("Invalid history sources");
  return sources.map(s => {
    if (!validSession({ ...s, id: "source" }) || s.host !== host || s.harness === "opencode-v2" && s.authority !== "local" && !s.server) throw Error("Invalid history authority");
    if (s.server) {
      const url = new URL(s.server);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error("Invalid history server");
    }
    return { id: sourceKey(s), host: s.host, authority: s.authority, harness: s.harness, ...(s.server ? { server: s.server } : {}) };
  });
}
export async function lookupNativeSession(runtime, source, id, directory = null) {
  try {
    if (source.harness === "claude") {
      const sdk = runtime.sdk ?? await import("@anthropic-ai/claude-agent-sdk");
      const info = await sdk.getSessionInfo(id, directory ? { dir: directory } : {});
      return info?.sessionId === id ? { state: "available", info } : info === undefined ? { state: "unknown", reason: "metadata-missing" } : { state: "unknown" };
    }
    const result = await openCodeRequest(runtime.run, source, `/api/session/${encodeURIComponent(id)}`);
    const info = result.value?.data ?? result.value;
    return info?.id === id ? { state: "available", info } : { state: result.missing ? "missing" : "unknown" };
  } catch { return { state: "unknown" }; }
}
async function inventory(runtime, source) {
  const entries = [], visited = new Set();
  let cursor = null, page;
  for (let count = 0; count < 10000; count++) {
    page = source.harness === "claude" ? await discoverClaudeSessions({ sdk: runtime.sdk ?? await import("@anthropic-ai/claude-agent-sdk"), source, offset: cursor ?? 0 })
      : await discoverOpenCodeSessions({ run: runtime.run, source, cursor });
    entries.push(...page.entries);
    if (page.complete) return { ...page, entries };
    if (page.source.state === "unavailable") return failure(source, entries);
    if (page.next === null || visited.has(page.next)) break;
    visited.add(page.next); cursor = page.next;
  }
  return failure(source, entries);
}
export async function refreshSessionCatalog(runtime, { force = false } = {}) {
  return runtime.store.withHistoryMutation(async () => {
    const previous = await runtime.store.readHistory(), now = runtime.clock();
    const discoveries = [], remoteAssociations = [], remoteHealth = [], sources = await historySources(runtime);
    for (const source of sources) {
      const oldSource = previous?.sources.find(s => s.id === source.id);
      if (!force && oldSource?.checkedAt != null && now - oldSource.checkedAt < 60000) continue;
      let page;
      try { page = await inventory(runtime, source); } catch { page = failure(source); }
      page.source.checkedAt = now;
      for (const discovered of page.entries) if (discovered.saved === "available" && await runtime.store.historyDeleted(discovered.session)) {
        await runtime.store.clearHistoryDeletion(discovered.session);
      }
      if (page.complete) for (const old of previous?.sessions ?? []) {
        if (old.sourceId !== source.id || page.entries.some(e => sessionIdentityKey(e.session) === sessionIdentityKey(old.session))) continue;
        const found = await lookupNativeSession(runtime, source, old.session.id, old.directory);
        if (found.state === "missing") { page.entries.push({ ...old, saved: "missing" }); await runtime.store.markHistoryMissing(old.session); }
      }
      discoveries.push(page);
    }
    const config = runtime.peers !== undefined ? null : await readJson(join(runtime.root, "peers.json"));
    const peers = runtime.peers ?? (config?.owner === OWNER ? config.peers : []) ?? [];
    for (const peer of peers) {
      try {
        let offset = 0, finished = false;
        const seen = new Set(), health = [];
        for (let count = 0; count < 10000; count++) {
          const reply = await callPeer(peer, ["history-snapshot", "--offset", String(offset), "--json"], runtime.run);
          const page = reply.code === 0 && JSON.parse(reply.stdout);
          if (page?.owner !== OWNER || page.schema !== 1 || !Array.isArray(page.entries) || page.entries.some(e => e.session?.host !== peer.host)
            || !validateRegistry({ schema: 1, owner: OWNER, revision: 0, updatedAt: 0, sessions: page.entries, sources: page.sources ?? [] })) throw Error("Invalid peer history");
          for (const e of page.entries) {
            seen.add(sessionIdentityKey(e.session));
            for (const association of e.associations) if (association.host === peer.host) remoteAssociations.push({ session: e.session,
              space: { host: peer.host, coreSession: association.coreSession, id: `${peer.target}/${association.id}` }, associatedAt: association.associatedAt });
          }
          health.splice(0, health.length, ...(page.sources ?? []).filter(s => s.host === peer.host).map(s => ({ ...s, peerId: peer.id, machine: peer.target, checkedAt: now })));
          discoveries.push({ entries: page.entries.map(e => ({ ...e, bindings: [], associations: [] })), complete: false });
          if (page.next == null) { finished = true; break; }
          if (!Number.isSafeInteger(page.next) || page.next <= offset) throw Error("Invalid peer cursor");
          offset = page.next;
        }
        if (!finished) throw Error("Incomplete peer inventory");
        remoteHealth.push(...health);
        for (const old of previous?.sessions ?? []) {
          if (old.session.host !== peer.host || seen.has(sessionIdentityKey(old.session)) || !health.some(s => s.id === old.sourceId && s.complete)) continue;
          const reply = await callPeer(peer, ["history-lookup", "--session", JSON.stringify(old.session), "--json"], runtime.run);
          const found = reply.code === 0 && JSON.parse(reply.stdout);
          if (found?.owner === OWNER && found.schema === 1 && found.state === "missing") discoveries.push({ entries: [{ ...old, saved: "missing" }] });
        }
      } catch {
        const old = previous?.sources.filter(s => s.host === peer.host) ?? [];
        const unavailable = old.length ? old : ["claude", "opencode-v2"].map(harness => ({ host: peer.host, authority: harness === "claude" ? "claude" : "local", harness }));
        remoteHealth.push(...unavailable.map(s => ({ ...s, id: s.id ?? sourceKey(s), peerId: peer.id, machine: peer.target, checkedAt: now,
          state: "unavailable", complete: false, errorCode: "peer-unavailable" })));
      }
    }
    const observed = await collectSessionPresence({ ...runtime, previous }, peers);
    const next = reconcileSessionRegistry(previous, { discoveries, presence: observed.presence, sources: [...observed.sources, ...remoteHealth], now });
    for (const association of [...await runtime.store.listHistoryAssociations(), ...remoteAssociations]) {
      let record = next.sessions.find(e => sessionIdentityKey(e.session) === sessionIdentityKey(association.session));
      if (!record && !discoveries.some(p => p.entries.some(e => e.saved === "missing" && sessionIdentityKey(e.session) === sessionIdentityKey(association.session)))) {
        const metadata = await runtime.store.read(association.session);
        record = { session: association.session, title: clean(metadata?.canonicalTitle) || (association.session.harness === "claude" ? "Claude Code" : "OpenCode"),
          directory: normalizedDirectory(association.directory), updatedAt: 0, sourceId: sourceKey(association.session), saved: "checking", associations: [], bindings: [] };
        next.sessions.push(record);
      }
      if (record && !record.associations.some(a => a.associatedAt > association.associatedAt)) record.associations = [{ ...association.space, associatedAt: association.associatedAt }];
    }
    await runtime.store.writeHistory(next, previous?.revision ?? null);
    return next;
  });
}
