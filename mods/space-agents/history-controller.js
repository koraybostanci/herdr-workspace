import { InputState } from "gpui-base";
import { appHome, readTextFile, exec, focused, run, shared, setShared } from "herdr";
import { reconcileSessionRegistry, partitionSpaceSessions, sessionIdentityKey, validateRegistry, registryBindingKey } from "./session-registry.js";
import { historyGroups, historyViewMode, acceptHistoryPage } from "./history-model.js";

const empty = () => ({ schema: 1, owner: "herdr-session-metadata", revision: 0, updatedAt: 0, sessions: [], sources: [] });
export class HistoryController {
  init(cx) {
    this.registry = empty(); this.cache = new Map(); this.contexts = new Map(); this.pending = new Map(); this.requestSeq = 0; this.loading = false;
    this.query = ""; this.selectedKey = null; this.menuOpen = false; this.menuIndex = 0; this.confirmDeleteKey = null;
    this.listHandle = cx.focus_handle(); this.menuHandle = cx.focus_handle(); this.deleteHandle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search sessions…" });
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value().slice(0, 512); this.selectedKey = null;
      const version = this.queryVersion = (this.queryVersion ?? 0) + 1;
      cx.timer.after(250, cx => { if (this.queryVersion === version) this.refresh(cx); });
      cx.notify();
    });
  }
  setSpace(space) {
    const contextKey = space && JSON.stringify([space.id, space.machine, space.coreSession]);
    if (contextKey !== this.contextKey) {
      if (this.contextKey) this.cache.set(this.contextKey, { registry: this.registry, page: this.page });
      const cached = this.cache.get(contextKey);
      this.registry = cached?.registry ?? empty(); this.page = cached?.page ?? null;
      this.currentRequest = null; this.error = null; this.selectedKey = null; this.confirmDeleteKey = null; this.contextKey = contextKey;
    }
    this.space = space;
    if (space) this.contexts.set(JSON.stringify([space.id, space.machine ?? null]), space);
  }
  async call(command, request) {
    const home = appHome(), raw = await readTextFile(`${home}/data/space-agents/runtime.json`);
    const runtime = JSON.parse(raw ?? "null"), prefix = `${home}/integrations/session-metadata/releases/`;
    const absolute = v => typeof v === "string" && /^(?:\/|[A-Za-z]:[\\/])/.test(v) && !/[\x00-\x1f\x7f]/.test(v);
    if (runtime?.owner !== "herdr-session-metadata" || runtime.schema !== 1 || !absolute(runtime.node) || !absolute(runtime.stateRoot)
      || typeof runtime.helperPath !== "string" || !runtime.helperPath.startsWith(prefix)
      || !/^[a-f0-9-]{36}\/bin\/herdr-session-meta\.mjs$/.test(runtime.helperPath.slice(prefix.length))) throw Error("metadata-unavailable");
    const result = await exec(runtime.node, [runtime.helperPath, command, "--request", JSON.stringify(request), "--json", "--app-home", home, "--state-root", runtime.stateRoot]);
    if (result.code !== 0) throw Error("history-unavailable");
    return JSON.parse(result.stdout);
  }
  refresh(cx, append = false) {
    if (!this.space) return;
    const request = { space: this.space, view: historyViewMode(shared("space-agents.history.view")), query: this.query,
      offset: append ? this.page?.nextOffset ?? 0 : 0, limit: 50, requestId: String(++this.requestSeq) };
    const sameView = this.page?.request.view === request.view && this.page.request.query === request.query && this.page.request.space.id === request.space.id;
    const target = !append && sameView ? Math.max(50, this.registry.sessions.filter(e => e.bindings.every(b => b.browsing)).length) : 50;
    if (this.loading && !append && this.currentRequest?.space.id === request.space.id && this.currentRequest.view === request.view && this.currentRequest.query === request.query) return;
    this.currentRequest = request; this.loading = true; this.error = null;
    cx.spawn(async cx => {
      try {
        let result = await this.call("history-view", request);
        if (!append && target > 50 && acceptHistoryPage(result, request)) {
          const loaded = new Map(result.history.map(row => [sessionIdentityKey(row.session), row]));
          while (loaded.size < target && result.hasMore) {
            if (this.currentRequest?.requestId !== request.requestId || this.query !== request.query) return;
            const nextRequest = { ...request, offset: result.nextOffset };
            const next = await this.call("history-view", nextRequest);
            if (!acceptHistoryPage(next, nextRequest) || next.nextOffset <= nextRequest.offset) throw Error("invalid-history-page");
            for (const row of next.history) loaded.set(sessionIdentityKey(row.session), row);
            result = next;
          }
          result = { ...result, request, history: [...loaded.values()] };
        }
        if (!this.acceptPage(result, request, append) && this.currentRequest?.requestId === request.requestId && this.query === request.query) this.error = "History returned invalid data. Retry after updating the metadata helper.";
      }
      catch { if (this.currentRequest?.requestId === request.requestId) this.error = "History unavailable. Check the metadata helper, then retry."; }
      finally { if (this.currentRequest?.requestId === request.requestId) { this.loading = false; cx.notify(); } }
    });
  }
  acceptPage(response, request, append = false) {
    if (!acceptHistoryPage(response, request) || this.space?.id !== request.space.id
      || this.currentRequest?.requestId !== request.requestId || request.query !== this.query
      || !this.browseSpaces && focused()?.space && focused().space !== request.space.id) return false;
    let registry;
    try {
      const activated = new Set(this.registry.sessions.flatMap(e => e.bindings.filter(b => b.browsing === false).map(b => JSON.stringify([registryBindingKey(b), b.generation]))));
      const preserveActivation = row => ({ ...row, bindings: row.bindings.map(b => activated.has(JSON.stringify([registryBindingKey(b), b.generation])) ? { ...b, browsing: false } : b) });
      const entries = new Map(append ? this.registry.sessions.filter(e => e.bindings.every(b => b.browsing)).map(e => [sessionIdentityKey(e.session), e]) : []);
      for (const row of response.agents) entries.set(sessionIdentityKey(row.session), preserveActivation(row));
      for (const row of response.history) entries.set(sessionIdentityKey(row.session), { ...preserveActivation(row), matchedHistoryQuery: request.query });
      registry = { schema: 1, owner: "herdr-session-metadata", revision: response.revision, updatedAt: Date.now(), sessions: [...entries.values()], sources: response.sources };
      if (!validateRegistry(registry)) return false;
    } catch { return false; }
    this.registry = registry;
    this.page = response; this.space = response.resolvedSpace ?? request.space; this.error = null;
    this.contexts.set(JSON.stringify([this.space.id, this.space.machine ?? null]), this.space);
    return true;
  }
  partition(observations) {
    this.registry = reconcileSessionRegistry(this.registry, { presence: observations, now: Date.now() });
    const partition = partitionSpaceSessions({ registry: this.registry, space: this.space });
    for (const row of [...partition.agents, ...partition.history]) if (row.primaryBinding && row.connection === "confirmed" && this.pending.get(row.key)?.state !== "deleting") this.pending.delete(row.key);
    return partition;
  }
  groups(rows) {
    const needle = this.query.trim().toLowerCase();
    // The helper searches full titles; its matches survive display-only truncation.
    const matching = rows.filter(r => r.matchedHistoryQuery === this.query || !needle || `${r.title}\n${r.directory ?? ""}`.toLowerCase().includes(needle));
    return historyGroups(matching, { mode: historyViewMode(shared("space-agents.history.view")) });
  }
  chooseView(mode, cx) { setShared("space-agents.history.view", mode); this.menuOpen = false; this.refresh(cx); cx.notify(); }
  toggle(section, cx) { const folded = shared("space-agents.sections") ?? (this.browseSpaces ? { history: true } : {}); setShared("space-agents.sections", { ...folded, [section]: !folded[section] }); cx.notify(); }
  requestDelete(row, open, cx) {
    this.confirmDeleteKey = open && !row.bindings.length && !["opening", "deleting"].includes(this.pending.get(row.key)?.state) ? row.key : null;
    if (this.confirmDeleteKey) this.deleteHandle.focus();
    cx.notify();
  }
  deleteSession(row, cx) {
    if (this.confirmDeleteKey !== row.key || row.bindings.length || !this.space || ["opening", "deleting"].includes(this.pending.get(row.key)?.state)) return;
    const space = this.space;
    this.confirmDeleteKey = null; this.pending.set(row.key, { state: "deleting" }); cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.call("delete-session", { session: row.session, space, confirmed: true });
        if (result.error) throw Error(result.error);
        if (result.schema !== 1 || result.owner !== "herdr-session-metadata" || result.deleted !== true || result.sessionKey !== row.key) throw Error("invalid-deletion-result");
        const forget = state => {
          const included = state.registry.sessions.some(e => sessionIdentityKey(e.session) === row.key);
          const registry = { ...state.registry, sessions: state.registry.sessions.filter(e => sessionIdentityKey(e.session) !== row.key) };
          const page = state.page && { ...state.page, total: Math.max(0, state.page.total - Number(included)),
            nextOffset: Math.max(0, state.page.nextOffset - Number(included)),
            history: state.page.history.filter(e => sessionIdentityKey(e.session) !== row.key) };
          return { registry, page };
        };
        Object.assign(this, forget(this));
        for (const [key, cached] of this.cache) this.cache.set(key, forget(cached));
        this.currentRequest = null; this.loading = false; this.pending.delete(row.key);
        this.refresh(cx);
      } catch (error) {
        const messages = { "session-open": "Close this session in Herdr before deleting it.",
          "deletion-unverified": "Deletion could not be verified. Refresh or retry to check the saved session.",
          "authority-unavailable": "Could not delete: the original server is unavailable. Reconnect and retry.",
          "execution-host-unavailable": "Could not delete: the original machine is unavailable. Reconnect and retry.",
          "remote-delete-unavailable": "Could not delete on the original machine. Check its connection and metadata helper, then retry." };
        this.pending.set(row.key, { state: "error", message: messages[error.message] ?? "Could not delete this session. Check its machine and harness, then retry." });
      } finally { cx.notify(); }
    });
  }
  resume(row, cx, expectedSpace = this.space?.id) {
    if (["opening", "deleting"].includes(this.pending.get(row.key)?.state) || !this.space || this.space.id !== expectedSpace) return;
    const space = this.space;
    if (this.browseSpaces && focused()?.space !== space.id) run("space.select", { id: space.id });
    this.pending.set(row.key, { state: "opening" }); cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.call("prepare-resume", { session: row.session, space, browsing: true });
        if (this.space?.id !== space.id || focused()?.space && focused().space !== space.id) { this.pending.delete(row.key); return; }
        if (result.sessionKey !== row.key || result.error) throw Error(result.error ?? "session-unavailable");
        if (result.kind === "focus" && typeof result.terminal === "string") { run("agent.focus", { terminal: result.terminal }); this.pending.delete(row.key); }
        else if (result.kind === "launch" && result.command === "tab.new" && result.args?.space === space.id && result.args.folder === row.directory
          && Array.isArray(result.args.argv) && result.args.argv[0] === (row.session.harness === "claude" ? "claude" : "opencode")) {
          run("tab.new", result.args);
          cx.timer.after(60000, cx => {
            if (this.pending.get(row.key)?.state === "opening") { this.pending.set(row.key, { state: "error", message: "Session not identified. Check the opened tab before retrying." }); cx.notify(); }
          });
        } else throw Error("session-unavailable");
        this.refresh(cx);
      } catch (error) {
        const messages = { "session-missing": "Saved session no longer exists.", "directory-unavailable": "Original folder is unavailable.",
          "harness-unavailable": "Harness is not installed on the original machine.", "authority-unavailable": "Original server is unavailable.",
          "execution-host-unavailable": "Original machine is unavailable.", "connection-unavailable": "Connection unavailable. Reconnect before resuming." };
        this.pending.set(row.key, { state: "error", message: messages[error.message] ?? "Could not reopen this session. Check its machine and harness, then retry." });
      } finally { cx.notify(); }
    });
  }
  close() { this.search.release(); this.listHandle.release(); this.menuHandle.release(); this.deleteHandle.release(); }
}
