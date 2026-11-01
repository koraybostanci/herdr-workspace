import { stat } from "node:fs/promises";
import { join } from "node:path";
import { OWNER, validSession } from "./contracts.mjs";
import { partitionSpaceSessions, sessionIdentityKey, reconcileSessionRegistry, validateRegistry } from "./session-registry.mjs";
import { historyGroups } from "./history-model.mjs";
import { collectSessionPresence } from "./session-presence.mjs";
import { historySources, lookupNativeSession } from "./history-catalog.mjs";
import { readJson } from "./store.mjs";
import { callPeer } from "./transport.mjs";

function validRequest(request) {
  return request?.space && [request.space.host, request.space.coreSession, request.space.id, request.requestId].every(s => typeof s === "string" && s && !/[\x00-\x1f\x7f]/.test(s))
    && typeof request.query === "string" && request.query.length <= 512 && Number.isSafeInteger(request.offset) && request.offset >= 0 && request.limit === 50;
}
export function createHistoryView(registry, request) {
  if (!validRequest(request) || !validateRegistry(registry)) throw Error("Invalid history request or registry");
  const partition = partitionSpaceSessions({ registry, space: request.space });
  const allGroups = historyGroups(partition.history, { mode: request.view, query: request.query });
  const ordered = allGroups.flatMap(g => g.rows);
  const display = row => ({ ...row, title: [...row.title].slice(0, 512).join("") });
  const rows = ordered.slice(request.offset, request.offset + 50).map(display);
  const relevant = new Set([...partition.agents, ...partition.history].map(e => e.sourceId));
  const sources = registry.sources.filter(s => s.host === request.space.host || relevant.has(s.id));
  const result = { schema: 1, owner: OWNER, request, revision: registry.revision, agents: partition.agents.map(display), history: rows,
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
export async function prepareSessionResume(runtime, { session, space }) {
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
  if (row.placement === "agents") return row.connection === "confirmed"
    ? { kind: "focus", sessionKey: key, terminal: row.primaryBinding.address, pane: row.primaryBinding.pane }
    : { error: "connection-unavailable" };
  if (session.host !== (runtime.env?.HERDR_METADATA_HOST ?? "local")) {
    const peer = peers.find(p => p.host === session.host && p.target === space.machine);
    if (!peer || !space.id.startsWith(peer.target + "/")) return { error: "execution-host-unavailable" };
    try {
      const request = { session, space: { ...space, id: space.id.slice(peer.target.length + 1), machine: null } };
      const reply = await callPeer(peer, ["prepare-resume", "--request", JSON.stringify(request), "--json"], runtime.run);
      const prepared = reply.code === 0 && JSON.parse(reply.stdout);
      const source = registry.sources.find(s => s.id === row.sourceId);
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
  return { kind: "launch", sessionKey: key, command: "tab.new", args: { space: space.id, name: row.title, folder: row.directory, argv } };
}
function resumeArguments(session, source) {
  return session.harness === "claude" ? ["claude", "--resume", session.id]
    : ["opencode", ...(source?.server ? ["--server", source.server] : []), "--session", session.id];
}
