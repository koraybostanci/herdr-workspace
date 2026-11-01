const key = row => row.key ?? JSON.stringify([row.session.host, row.session.authority, row.session.harness, row.session.id]);
const compare = (a, b) => b.updatedAt - a.updatedAt || key(a).localeCompare(key(b));
export const historyViewMode = value => ["folder", "harness"].includes(value) ? value : "recent";
export function historyProgram(session, knownPrograms = []) {
  const claude = session.harness === "claude", programKey = claude ? "claude" : "opencode";
  const found = knownPrograms.find(p => p.key === programKey);
  return found?.icon ? found : { ...found, key: programKey, name: found?.name ?? (claude ? "Claude Code" : "OpenCode"),
    icon: claude ? "icons/claude.svg" : "icons/opencode.svg", tint: claude, agent: true };
}
export function historyGroups(rows, { mode = "recent", query = "", now = Date.now() } = {}) {
  mode = historyViewMode(mode);
  const needle = query.trim().toLowerCase();
  const sorted = rows.filter(r => !needle || `${r.title}\n${r.directory ?? ""}`.toLowerCase().includes(needle)).sort(compare);
  const date = new Date(now), today = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime();
  const groups = new Map();
  for (const row of sorted) {
    const label = mode === "recent" ? row.updatedAt >= today ? "Today" : row.updatedAt >= yesterday ? "Yesterday" : "Older"
      : mode === "harness" ? row.session.harness === "claude" ? "Claude Code" : "OpenCode" : row.directory ?? "Directory unavailable";
    const groupKey = mode === "folder" ? JSON.stringify([row.session.host, row.directory]) : label;
    if (!groups.has(groupKey)) groups.set(groupKey, { key: groupKey, label, rows: [] });
    groups.get(groupKey).rows.push(row);
  }
  const result = [...groups.values()];
  return mode === "harness" ? result.sort((a, b) => a.label.localeCompare(b.label))
    : mode === "folder" ? result.sort((a, b) => b.rows[0].updatedAt - a.rows[0].updatedAt || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)) : result;
}
function requestKey(request) {
  return JSON.stringify([request?.requestId, request?.space?.host, request?.space?.coreSession, request?.space?.id,
    request?.space?.folder, request?.space?.machine, request?.view, request?.query, request?.offset, request?.limit]);
}
export function acceptHistoryPage(response, request) {
  return response?.schema === 1 && response.owner === "herdr-session-metadata" && Number.isSafeInteger(response.revision)
    && Array.isArray(response.agents) && Array.isArray(response.history) && requestKey(response.request) === requestKey(request);
}
