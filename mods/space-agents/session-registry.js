// Pure shared contract. Keep the native mod copy byte-identical (bundle parity).
const text = value => typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sameSpace = (a, b) => a?.host === b?.host && a?.coreSession === b?.coreSession && a?.id === b?.id;
const validSpace = value => value && [value.host, value.coreSession, value.id].every(text);
const rank = { blocked: 4, done: 3, working: 2, idle: 1 };
export function normalizedDirectory(value) {
  if (typeof value !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
  const path = /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g, "/") : value;
  return /^[A-Za-z]:\/+$/u.test(path) ? path.slice(0, 2) + "/" : path.replace(/\/+$/, "") || "/";
}
export function sessionIdentityKey(session) {
  if (!session || ![session.host, session.authority, session.id].every(text) || !["claude", "opencode-v2"].includes(session.harness)) throw Error("Invalid session identity");
  return JSON.stringify([session.host, session.authority, session.harness, session.id]);
}
export function registryBindingKey(binding) {
  return JSON.stringify([binding.coreHost, binding.coreSession, binding.terminal, binding.createdMs]);
}
function validEntry(entry) {
  try {
    sessionIdentityKey(entry.session);
    return typeof entry.title === "string" && !/[\x00-\x1f\x7f]/.test(entry.title) && text(entry.sourceId)
      && (entry.directory === null || normalizedDirectory(entry.directory) !== null) && integer(entry.updatedAt)
      && ["available", "checking", "unavailable", "missing"].includes(entry.saved)
      && Array.isArray(entry.associations) && entry.associations.every(a => validSpace(a) && integer(a.associatedAt))
      && Array.isArray(entry.bindings) && entry.bindings.every(b => validSpace(b.space) && text(b.terminal) && text(b.coreHost)
        && text(b.coreSession) && text(b.generation) && integer(b.createdMs) && b.createdMs > 0 && text(b.address)
        && ["open", "unknown"].includes(b.presence) && ["confirmed", "unavailable", "reconnecting"].includes(b.connection)
        && (b.browsing === undefined || typeof b.browsing === "boolean")
        && (b.activity == null || Object.hasOwn(rank, b.activity))
        && sessionIdentityKey(b.session) === sessionIdentityKey(entry.session));
  } catch { return false; }
}
export function validateRegistry(value) {
  if (value?.schema !== 1 || value.owner !== "herdr-session-metadata" || !integer(value.revision) || !integer(value.updatedAt)
    || !Array.isArray(value.sessions) || !value.sessions.every(validEntry) || !Array.isArray(value.sources)) return null;
  if (new Set(value.sessions.map(e => sessionIdentityKey(e.session))).size !== value.sessions.length) return null;
  if (!value.sources.every(s => text(s.id) && text(s.host) && text(s.authority) && ["claude", "opencode-v2"].includes(s.harness)
    && ["ready", "partial", "unavailable"].includes(s.state) && typeof s.complete === "boolean")) return null;
  return value;
}
export function partitionSpaceSessions({ registry, space }) {
  const result = { agents: [], history: [] };
  if (!validSpace(space) || !validateRegistry(registry)) return result;
  for (const entry of registry.sessions) {
    const bound = entry.bindings.filter(b => sameSpace(b.space, space));
    if (entry.bindings.length && !bound.length) continue;
    const active = bound.filter(b => !b.browsing);
    if (entry.bindings.some(b => !b.browsing) && !active.length) continue;
    if (!entry.bindings.length) {
      if (entry.saved === "missing") continue;
      const association = [...entry.associations].sort((a, b) => b.associatedAt - a.associatedAt || a.id.localeCompare(b.id))[0];
      if (association ? !sameSpace(association, space)
        : entry.session.host !== space.host || !normalizedDirectory(space.folder) || normalizedDirectory(entry.directory) !== normalizedDirectory(space.folder)) continue;
    }
    const candidates = active.length ? active : bound;
    const primaryBinding = [...candidates].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || a.address.localeCompare(b.address))[0] ?? null;
    const activity = candidates.reduce((status, b) => (rank[b.activity] ?? 0) > (rank[status] ?? 0) ? b.activity : status, null);
    const placement = active.length ? "agents" : "history";
    result[placement].push({ ...entry, key: sessionIdentityKey(entry.session), placement, primaryBinding, activity,
      connection: candidates.some(b => b.presence === "open" && b.connection === "confirmed") ? "confirmed" : bound.length ? "unavailable" : null });
  }
  return result;
}
export function reconcileSessionRegistry(previous, { discoveries = [], presence = [], sources = [], now = Date.now() } = {}) {
  const base = validateRegistry(previous) ?? { schema: 1, owner: "herdr-session-metadata", revision: 0, updatedAt: 0, sessions: [], sources: [] };
  const entries = new Map(base.sessions.map(e => [sessionIdentityKey(e.session), { ...e, associations: [...e.associations], bindings: [...e.bindings] }]));
  for (const page of discoveries) for (const discovered of page.entries ?? []) {
    if (!validEntry(discovered)) continue;
    const key = sessionIdentityKey(discovered.session), old = entries.get(key);
    entries.set(key, old ? { ...old, ...discovered, associations: old.associations, bindings: old.bindings } : { ...discovered, associations: [], bindings: [] });
  }
  for (const observation of presence) {
    const b = observation.binding;
    let key;
    try { key = sessionIdentityKey(b.session); } catch { continue; }
    let entry = entries.get(key);
    if (observation.state === "open") {
      const oldBinding = entry?.bindings.find(existing => registryBindingKey(existing) === registryBindingKey(b) && existing.generation === b.generation);
      const next = { ...b, presence: "open", connection: "confirmed", browsing: oldBinding?.browsing === false ? false : b.browsing ?? oldBinding?.browsing ?? false };
      const candidate = entry ?? { session: b.session, title: b.title || (b.session.harness === "claude" ? "Claude Code" : "OpenCode"),
        directory: normalizedDirectory(b.directory ?? b.lookupDir), updatedAt: 0,
        sourceId: JSON.stringify([b.session.host, b.session.authority, b.session.harness]), saved: "checking", associations: [], bindings: [] };
      if (!validEntry({ ...candidate, bindings: [next] })) continue;
      for (const e of entries.values()) e.bindings = e.bindings.filter(existing => registryBindingKey(existing) !== registryBindingKey(b));
      entry = { ...candidate, bindings: [...candidate.bindings.filter(existing => registryBindingKey(existing) !== registryBindingKey(b)), next] };
      entry.associations = [...entry.associations.filter(a => !sameSpace(a, b.space)), { host: b.space.host, coreSession: b.space.coreSession, id: b.space.id, associatedAt: now }];
      entries.set(key, entry);
    } else if (entry && ["closed", "unknown"].includes(observation.state)) {
      entry.bindings = entry.bindings.flatMap(existing => {
        if (registryBindingKey(existing) !== registryBindingKey(b) || existing.generation !== b.generation) return [existing];
        return observation.state === "closed" ? [] : [{ ...existing, presence: "unknown", connection: "unavailable" }];
      });
    }
  }
  const health = new Map(base.sources.map(source => [source.id, source]));
  for (const source of [...discoveries.map(p => p.source).filter(Boolean), ...sources]) health.set(source.id, source);
  return { schema: 1, owner: "herdr-session-metadata", revision: base.revision + 1, updatedAt: now,
    sessions: [...entries.values()].filter(e => e.saved !== "missing" || e.bindings.length), sources: [...health.values()] };
}
