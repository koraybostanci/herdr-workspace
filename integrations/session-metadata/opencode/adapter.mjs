import { sessionKey } from "../src/contracts.mjs";
import { applyPeerPending } from "../src/pending.mjs";
import { operationScope } from "../src/scope.mjs";

export function executionScope(argv, options) {
  const index = argv.findIndex(a => a === "--server" || a.startsWith("--server="));
  if (index < 0) return { host: options.host ?? "local", authority: options.authority ?? "local" };
  const origin = argv[index] === "--server" ? argv[index + 1] : argv[index].slice(9);
  const configured = options.servers?.[origin];
  return configured?.host && configured?.authority ? { host: configured.host, authority: configured.authority } : null;
}

export function unwrapSession(value, id) {
  const info = value?.data?.id ? value.data : value;
  if (info?.id !== id || info.title != null && typeof info.title !== "string") throw new Error("Unexpected OpenCode session response");
  return { ...info, title: info.title ?? "" };
}
export function createOpenCodeAdapter(context, deps) {
  const scope = deps.scope ?? { host: context.options?.host ?? "local", authority: context.options?.authority ?? "local" };
  let binding = null, disposed = false, running = null, rerun = false;
  const routeId = () => {
    const route = context.ui.router.current();
    return route?.type === "session" ? route.sessionID : null;
  };
  const stillCurrent = id => !disposed && routeId() === id;
  const access = {
    async get(key) {
      const info = unwrapSession(await context.client.session.get({ sessionID: key.id }), key.id);
      return { key, title: info.title, parentId: info.parentID ?? null, lookupDir: info.location?.directory ?? null };
    },
    async rename(key, title) {
      if (!stillCurrent(key.id)) throw new Error("Session changed before rename");
      await context.client.session.update({ sessionID: key.id, title });
    },
  };
  async function release() {
    const old = binding; binding = null;
    if (old) await deps.identity.release(old);
  }
  async function refreshNow() {
    if (disposed || deps.identity.enabled === false || !/^v?2\./.test(context.app.version)) return;
    const id = routeId();
    if (!id) { await release(); await deps.publish?.(); return; }
    if (binding && binding.session.id !== id) await release();
    const info = unwrapSession(await context.client.session.get({ sessionID: id }), id);
    if (!stillCurrent(id)) return;
    if (info.parentID || context.data.session.root?.(id) && context.data.session.root(id) !== id) { await release(); return; }
    const session = { ...scope, harness: "opencode-v2", id };
    const first = !binding;
    if (first) {
      const next = await deps.identity.verify(session);
      if (!next || !stillCurrent(id)) return;
      next.lookupDir = info.location?.directory ?? null;
      if (!await deps.identity.commit(next) || !stillCurrent(id)) return;
      binding = next;
      await context.data.session.message.sync(id);
    }
    const current = binding;
    if (!current || !stillCurrent(id)) return;
    const engineDeps = { store: deps.store, access, run: deps.run, clock: deps.clock,
      validateBinding: b => stillCurrent(b.session.id) && deps.identity.validate(b),
      hasAuthority: async b => b.mode === "inherited",
      activationMode: deps.activationMode ?? (() => deps.store.activationMode()) };
    const messages = context.data.session.message.list(id) ?? [];
    const observations = [];
    for (const message of messages) {
      if (message.type === "location-switched") observations.push({ eventId: message.id, kind: "location", observedAt: message.time.created,
        payload: { cwd: message.location?.directory } });
      if (message.type === "user") observations.push({ eventId: message.id, kind: "task", observedAt: message.time.created,
        payload: { prompt: message.text, cwd: info.location?.directory } });
      if (message.type === "assistant") for (const tool of message.content ?? []) {
        if (tool.type !== "tool" || tool.state?.status !== "completed") continue;
        const output = tool.state.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        observations.push({ eventId: `${message.id}:${tool.id}:completed`, kind: "tool", observedAt: tool.time.completed ?? message.time.completed ?? message.time.created,
          payload: { ...tool.state.input, output, tool: tool.name, failed: tool.state.content.some(c => c.type === "error") } });
      }
    }
    observations.sort((a, b) => a.observedAt - b.observedAt);
    for (const o of observations) {
      if (!stillCurrent(id)) return;
      await deps.engine({ ...o, session, generation: current.generation, parentId: null }, current,
        first ? { ...engineDeps, activationMode: async () => "observe" } : engineDeps);
    }
    if (!stillCurrent(id)) return;
    const scopeEvidence = observations.filter(o => o.kind === "location" || o.kind === "tool" && operationScope(o.payload)).slice(-128)
      .map(o => ({ eventId: o.eventId, eventAt: o.observedAt,
        operation: o.kind === "location" ? { kind: "directory", paths: [o.payload.cwd], source: "session-location" } : operationScope(o.payload) }));
    await deps.engine({ session, generation: current.generation, parentId: null, kind: "title",
      eventId: `reconcile:${current.generation}:${info.time?.updated ?? 0}:${info.title}:${await engineDeps.activationMode()}:${Math.floor(deps.clock() / 60000)}`,
      observedAt: deps.clock(), payload: { cwd: info.location?.directory, scopeEvidence } }, current, engineDeps);
    await deps.publish?.();
  }
  const adapter = {
    refresh() {
      if (running) { rerun = true; return running; }
      running = refreshNow().finally(() => { running = null; if (rerun && !disposed) { rerun = false; void adapter.refresh().catch(() => {}); } });
      return running;
    },
    async pair(token) {
      const id = routeId();
      if (!id || !deps.pair) throw new Error("Pairing is not configured");
      const live = await access.get({ ...scope, harness: "opencode-v2", id });
      if (live.parentId || !stillCurrent(id)) throw new Error("Pair only the current root session");
      const next = await deps.pair(token, live);
      if (!stillCurrent(id)) return;
      binding = next;
    },
    async applyPending(request) {
      if (!binding || !stillCurrent(binding.session.id) || request.generation !== binding.generation) return null;
      return applyPeerPending(request, { ...deps, access, validateOwner: b => stillCurrent(b.session.id) && deps.identity.validate(b) });
    },
    async dispose() { disposed = true; await release(); },
  };
  return adapter;
}
