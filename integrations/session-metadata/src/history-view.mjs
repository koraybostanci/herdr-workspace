import { stat } from "node:fs/promises";
import { join } from "node:path";
import { OWNER, validSession } from "./contracts.mjs";
import { partitionSpaceSessions, sessionIdentityKey, reconcileSessionRegistry, validateRegistry } from "./session-registry.mjs";
import { historyGroups } from "./history-model.mjs";
import { collectSessionPresence, probeSessionBinding } from "./session-presence.mjs";
import { historySources, lookupNativeSession } from "./history-catalog.mjs";
import { readJson } from "./store.mjs";
import { callPeer } from "./transport.mjs";

function validRequest(request) {
  return request?.space && [request.space.host, request.space.coreSession, request.space.id, request.requestId].every(s => typeof s === "string" && s && !/[\x00-\x1f\x7f]/.test(s))
    && typeof request.query === "string" && request.query.length <= 512 && Number.isSafeInteger(request.offset) && request.offset >= 0 && request.limit === 50;
}
export function createHistoryView(registry, request, { coreSession } = {}) {
  if (!validRequest(request) || !validateRegistry(registry)) throw Error("Invalid history request or registry");
  const mapped = request.space.machine && registry.sources.find(s => s.machine === request.space.machine);
  const resolvedSpace = { ...request.space, ...(mapped ? { host: mapped.host } : {}), ...(!request.space.machine && coreSession ? { coreSession } : {}) };
  const partition = partitionSpaceSessions({ registry, space: resolvedSpace });
  const allGroups = historyGroups(partition.history, { mode: request.view, query: request.query });
  const ordered = allGroups.flatMap(g => g.rows);
  const display = row => ({ ...row, title: [...row.title].slice(0, 512).join("") });
  const rows = ordered.slice(request.offset, request.offset + 50).map(display);
  const relevant = new Set([...partition.agents, ...partition.history].map(e => e.sourceId));
  const sources = registry.sources.filter(s => s.host === resolvedSpace.host || relevant.has(s.id));
  const result = { schema: 1, owner: OWNER, request, resolvedSpace, revision: registry.revision, agents: partition.agents.map(display), history: rows,
    groups: [], total: ordered.length, hasMore: false, nextOffset: request.offset, sources, complete: sources.length > 0 && sources.every(s => s.complete) };
  for (;;) {
    result.groups = historyGroups(result.history, { mode: request.view });
    result.nextOffset = request.offset + result.history.length;
    result.hasMore = result.nextOffset < result.total;
    if (Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024) return result;
    if (!result.history.length) throw Error("view-too-large");
    result.history.pop();
  }
}
async function configuredPeers(runtime) {
  if (runtime.peers !== undefined) return runtime.peers;
  const config = await readJson(join(runtime.root, "peers.json"));
  return config?.owner === OWNER && Array.isArray(config.peers) ? config.peers : [];
}
export async function prepareSessionResume(runtime, { session, space, browsing = false }) {
  if (!validSession(session) || !/^[A-Za-z0-9][\w-]*$/.test(session.id) || !space?.id) return { error: "session-unavailable" };
  const key = sessionIdentityKey(session), peers = await configuredPeers(runtime);
  let registry;
  try {
    registry = await runtime.store.withHistoryMutation(async () => {
      const previous = await runtime.store.readHistory();
      if (!previous) return null;
      const observed = await collectSessionPresence({ ...runtime, previous }, peers);
      const next = reconcileSessionRegistry(previous, { ...observed, now: runtime.clock() });
      await runtime.store.writeHistory(next, previous.revision);
      return next;
    });
  } catch { return { error: "history-unavailable" }; }
  if (!registry) return { error: "session-unavailable" };
  const partition = partitionSpaceSessions({ registry, space });
  const row = [...partition.agents, ...partition.history].find(r => r.key === key);
  if (!row) return { error: "session-unavailable" };
  if (row.primaryBinding) return row.connection === "confirmed"
    ? { kind: "focus", sessionKey: key, terminal: row.primaryBinding.address, pane: row.primaryBinding.pane }
    : { error: "connection-unavailable" };
  if (session.host !== (runtime.env?.HERDR_METADATA_HOST ?? "local")) {
    const peer = peers.find(p => p.host === session.host && p.target === space.machine);
    if (!peer || !space.id.startsWith(peer.target + "/")) return { error: "execution-host-unavailable" };
    try {
      const request = { session, browsing, space: { ...space, id: space.id.slice(peer.target.length + 1), machine: null } };
      const reply = await callPeer(peer, ["prepare-resume", "--request", JSON.stringify(request), "--json"], runtime.run);
      const prepared = reply.code === 0 && JSON.parse(reply.stdout);
      const source = registry.sources.find(s => s.id === row.sourceId);
      if (prepared?.kind === "focus" && prepared.sessionKey === key && typeof prepared.terminal === "string" && /^[A-Za-z0-9_-]+$/.test(prepared.terminal)) {
        return { kind: "focus", sessionKey: key, terminal: `${peer.target}/${prepared.terminal}`, pane: null };
      }
      if (prepared?.kind !== "launch" || prepared.sessionKey !== key || prepared.command !== "tab.new"
        || prepared.args?.folder !== row.directory || JSON.stringify(prepared.args.argv) !== JSON.stringify(resumeArguments(session, source))) return { error: "remote-resume-unavailable" };
      return { kind: "launch", sessionKey: key, command: "tab.new", args: { ...prepared.args, space: space.id } };
    } catch { return { error: "execution-host-unavailable" }; }
  }
  let source;
  try { source = (await historySources(runtime)).find(s => s.host === session.host && s.authority === session.authority && s.harness === session.harness); }
  catch { return { error: "authority-unavailable" }; }
  if (!source) return { error: "authority-unavailable" };
  const found = await lookupNativeSession(runtime, source, session.id, row.directory);
  if (found.state !== "available") return { error: found.state === "missing" ? "session-missing" : "session-unavailable" };
  try { if (!row.directory || !(await stat(row.directory)).isDirectory()) return { error: "directory-unavailable" }; }
  catch { return { error: "directory-unavailable" }; }
  const argv = resumeArguments(session, source);
  try { if ((await runtime.run("local", argv[0], ["--version"], { cwd: row.directory })).code !== 0) return { error: "harness-unavailable" }; }
  catch { return { error: "harness-unavailable" }; }
  if (browsing) {
    if (session.harness === "opencode-v2" && !Number.isSafeInteger(found.info.time?.updated)) return { error: "session-unavailable" };
    const baseline = Math.max(0, ...Object.values(found.info.time ?? {}).filter(v => Number.isSafeInteger(v) && v >= 0));
    const claimed = await runtime.store.withHistoryMutation(async () => {
      const latest = await runtime.store.readHistory();
      if (!latest || !partitionSpaceSessions({ registry: latest, space }).history.some(row => row.key === key)) return false;
      await runtime.store.beginHistoryBrowse(session, space, baseline);
      return true;
    });
    if (!claimed) return { error: "session-unavailable" };
  }
  return { kind: "launch", sessionKey: key, command: "tab.new", args: { space: space.id, name: row.title, folder: row.directory, argv } };
}
function resumeArguments(session, source) {
  return session.harness === "claude" ? ["claude", "--resume", session.id]
    : ["opencode", ...(source?.server ? ["--server", source.server] : []), "--session", session.id];
}

export async function deleteSavedSession(runtime, { session, space, confirmed, forwarded = false } = {}) {
  if (confirmed !== true || !validSession(session) || !/^[A-Za-z0-9][\w-]*$/.test(session.id)
    || !space || ![space.host, space.coreSession, space.id].every(v => typeof v === "string" && v && !/[\x00-\x1f\x7f]/.test(v))) return { error: "session-unavailable" };
  const key = sessionIdentityKey(session);
  try {
    const peers = await configuredPeers(runtime);
    return await runtime.store.withHistoryMutation(async () => {
      const previous = await runtime.store.readHistory();
      if (!previous) return { error: "session-unavailable" };
      const observed = await collectSessionPresence({ ...runtime, previous }, peers);
      const next = reconcileSessionRegistry(previous, { ...observed, now: runtime.clock() });
      const partition = partitionSpaceSessions({ registry: next, space });
      const row = [...partition.agents, ...partition.history].find(r => r.key === key)
        ?? (forwarded && runtime.env?.HERDR_METADATA_HOST === session.host && space.host === session.host && !space.machine
          ? next.sessions.find(e => sessionIdentityKey(e.session) === key && e.directory !== null && e.directory === space.folder) : null);
      if (!row) return !next.sessions.some(e => sessionIdentityKey(e.session) === key) && await runtime.store.historyDeleted(session)
        ? { schema: 1, owner: OWNER, deleted: true, sessionKey: key } : { error: "session-unavailable" };
      if (row.bindings.length || observed.presence.some(o => sessionIdentityKey(o.binding.session) === key && o.state !== "closed")) return { error: "session-open" };
      if (session.host !== (runtime.env?.HERDR_METADATA_HOST ?? "local")) {
        const source = next.sources.find(s => s.id === row.sourceId);
        const candidates = peers.filter(p => p.host === session.host && (!space.machine || p.target === space.machine) && (!source?.peerId || source.peerId === p.id));
        const peer = candidates.length === 1 && candidates[0];
        if (!peer || space.machine && !space.id.startsWith(peer.target + "/")) return { error: "execution-host-unavailable" };
        try {
          const request = { session, confirmed: true, forwarded: true, space: { ...space, host: session.host, folder: row.directory,
            id: space.machine ? space.id.slice(peer.target.length + 1) : space.id, machine: null } };
          const reply = await callPeer(peer, ["delete-session", "--request", JSON.stringify(request), "--json"], runtime.run);
          const result = reply.code === 0 && JSON.parse(reply.stdout);
          if (result?.schema !== 1 || result.owner !== OWNER || result.deleted !== true || result.sessionKey !== key) return { error: "remote-delete-unavailable" };
        } catch { return { error: "remote-delete-unavailable" }; }
      } else {
        let source;
        try { source = (await historySources(runtime)).find(s => s.host === session.host && s.authority === session.authority && s.harness === session.harness); }
        catch { return { error: "authority-unavailable" }; }
        if (!source) return { error: "authority-unavailable" };
        const error = await runtime.store.withMutation(session, async () => {
          if (await runtime.store.historyOpening(session, runtime.clock())) return "session-open";
          for (const binding of await runtime.store.listBindings()) {
            if (sessionIdentityKey(binding.session) === key && (await probeSessionBinding(binding, runtime)).state !== "closed") return "session-open";
          }
          const found = await lookupNativeSession(runtime, source, session.id, row.directory);
          if (found.state === "missing" && session.harness !== "claude") return null;
          if (found.state === "unknown" && !(session.harness === "claude" && found.reason === "metadata-missing")) return "session-unavailable";
          try {
            if (session.harness === "claude") {
              const sdk = runtime.sdk ?? await import("@anthropic-ai/claude-agent-sdk");
              try { await sdk.deleteSession(session.id, { dir: row.directory }); }
              catch (error) {
                const missing = row.directory ? `Session ${session.id} not found in project directory for ${row.directory}` : `Session ${session.id} not found in any project directory`;
                if (error.message !== missing) throw error;
                if (found.reason === "metadata-missing" && await runtime.store.historyDeleted(session)) return null;
                return "deletion-unverified";
              }
            } else {
              const result = await runtime.run("local", "opencode", ["api", "delete", `/api/session/${encodeURIComponent(session.id)}`,
                ...(source.server ? ["--server", source.server] : [])]);
              if (result.code !== 0) return "delete-failed";
            }
          } catch { return "delete-failed"; }
          const after = await lookupNativeSession(runtime, source, session.id, row.directory);
          // Claude's successful SDK mutation is the proof; missing summary metadata alone is not.
          return after.state === "missing" || session.harness === "claude" && after.reason === "metadata-missing" ? null : "deletion-unverified";
        });
        if (error) return { error };
      }
      await runtime.store.forgetHistorySession(session);
      await runtime.store.writeHistory({ ...next, sessions: next.sessions.filter(e => sessionIdentityKey(e.session) !== key) }, previous.revision);
      return { schema: 1, owner: OWNER, deleted: true, sessionKey: key };
    });
  } catch { return { error: "history-unavailable" }; }
}
