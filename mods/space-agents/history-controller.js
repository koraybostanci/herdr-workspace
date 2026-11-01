import { InputState } from "gpui-base";
import { appHome, readTextFile, exec, focused, run, shared, setShared } from "herdr";
import { reconcileSessionRegistry, partitionSpaceSessions, sessionIdentityKey, validateRegistry } from "./session-registry.js";
import { historyGroups, historyViewMode, acceptHistoryPage } from "./history-model.js";

const empty = () => ({ schema: 1, owner: "herdr-session-metadata", revision: 0, updatedAt: 0, sessions: [], sources: [] });
export class HistoryController {
  init(cx) {
    this.registry = empty(); this.cache = new Map(); this.pending = new Map(); this.requestSeq = 0; this.loading = false;
    this.query = ""; this.selectedKey = null; this.menuOpen = false; this.menuIndex = 0;
    this.listHandle = cx.focus_handle(); this.menuHandle = cx.focus_handle();
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
      this.currentRequest = null; this.error = null; this.selectedKey = null; this.contextKey = contextKey;
    }
    this.space = space;
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
    if (this.loading && !append && this.currentRequest?.space.id === request.space.id && this.currentRequest.view === request.view && this.currentRequest.query === request.query) return;
    this.currentRequest = request; this.loading = true; this.error = null;
    cx.spawn(async cx => {
      try {
        const result = await this.call("history-view", request);
        if (!this.acceptPage(result, request, append) && this.currentRequest?.requestId === request.requestId && this.query === request.query) this.error = "History returned invalid data. Retry after updating the metadata helper.";
      }
      catch { if (this.currentRequest?.requestId === request.requestId) this.error = "History unavailable. Check the metadata helper, then retry."; }
      finally { if (this.currentRequest?.requestId === request.requestId) { this.loading = false; cx.notify(); } }
    });
  }
  acceptPage(response, request, append = false) {
    if (!acceptHistoryPage(response, request) || this.space?.id !== request.space.id
      || this.currentRequest?.requestId !== request.requestId || request.query !== this.query
      || focused()?.space && focused().space !== request.space.id) return false;
    let registry;
    try {
      const entries = new Map(append ? this.registry.sessions.filter(e => !e.bindings.length).map(e => [sessionIdentityKey(e.session), e]) : []);
      for (const row of [...response.agents, ...response.history]) entries.set(sessionIdentityKey(row.session), row);
      registry = { schema: 1, owner: "herdr-session-metadata", revision: response.revision, updatedAt: Date.now(), sessions: [...entries.values()], sources: response.sources };
      if (!validateRegistry(registry)) return false;
    } catch { return false; }
    this.registry = registry;
    this.page = response; this.space = response.resolvedSpace ?? request.space; this.error = null;
    return true;
  }
  partition(observations) {
    this.registry = reconcileSessionRegistry(this.registry, { presence: observations, now: Date.now() });
    const partition = partitionSpaceSessions({ registry: this.registry, space: this.space });
    for (const row of partition.agents) this.pending.delete(row.key);
    return partition;
  }
  groups(rows) { return historyGroups(rows, { mode: historyViewMode(shared("space-agents.history.view")), query: this.query }); }
  chooseView(mode, cx) { setShared("space-agents.history.view", mode); this.menuOpen = false; this.refresh(cx); cx.notify(); }
  toggle(section, cx) { const folded = shared("space-agents.sections") ?? {}; setShared("space-agents.sections", { ...folded, [section]: !folded[section] }); cx.notify(); }
  resume(row, cx) {
    if (this.pending.get(row.key)?.state === "opening" || !this.space) return;
    const space = this.space;
    this.pending.set(row.key, { state: "opening" }); cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.call("prepare-resume", { session: row.session, space });
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
  close() { this.search.release(); this.listHandle.release(); this.menuHandle.release(); }
}
