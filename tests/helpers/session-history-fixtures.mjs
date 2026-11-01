export const historySpace = { host: "local", coreSession: "default", id: "one", machine: null, folder: "/repo" };
export const historySource = { id: '["local","local","opencode-v2"]', host: "local", authority: "local", harness: "opencode-v2", state: "ready", complete: true, checkedAt: 1000, errorCode: null };
export function historyEntry(id = "ses_saved", extra = {}) {
  return { session: { host: "local", authority: "local", harness: "opencode-v2", id }, title: "Saved session", directory: "/repo", updatedAt: 1000,
    sourceId: historySource.id, saved: "available", associations: [], bindings: [], ...extra };
}
export function historyRegistry(sessions, sources = [historySource]) {
  return { schema: 1, owner: "herdr-session-metadata", revision: 1, updatedAt: 1000, sessions, sources };
}
