import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, InputState } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, layout, shared, setShared, setAgentOrder, exec, knownAgents, appHome, readTextFile, watchFolder, props as modProps } from "herdr";
import { agentCards, agentGroups, agentViewMode, WorkingDirectories, PullRequests, cardPullRequest, repositoryLabel } from "./model.js";
import { readSessionView, projectSessionCard, readLiveSessionBindings } from "./session-metadata.js";
import { HistoryController } from "./history-controller.js";
import { renderSessionHistory, renderHistoryViewOptions } from "./history-ui.js";
import { historyProgram, historyViewMode } from "./history-model.js";
import { AgentPresence } from "./agent-presence.js";
import { SpaceTree } from "./space-tree.js";
import { renderSidebarAreas } from "./sidebar-layout.js";

const STATUS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

function sidebar(node) {
  if (node?.id === "sidebar") return node;
  for (const child of node?.children ?? []) {
    const found = sidebar(child);
    if (found) return found;
  }
  return null;
}

function harness(program, color, size = 18) {
  const path = program?.icon ?? "mods/workspace-chrome/terminal.svg";
  return program?.icon && !program.tint
    ? image(path).w(size).h(size).flex_none()
    : svg(path).size(size).flex_none().text_color(color);
}

function showsAgents(node = layout()) {
  return node?.content?.mod === "space-agents" || (node?.children ?? []).some(showsAgents);
}

export default class SpaceAgents extends View {
  init(props, cx) {
    this.closed = false;
    if ((modProps() ?? props)?.tree) { this.tree = new SpaceTree(); this.tree.init(cx, { multiple: true }); }
    this.prs = new PullRequests();
    this.workingDirs = new WorkingDirectories();
    this.agentPresence = new AgentPresence();
    this.handle = cx.focus_handle();
    this.menuHandle = cx.focus_handle();
    this.viewMenuOpen = false;
    this.viewMenuIndex = 0;
    this.keyboardAddress = null;
    this.knownAgentKeys = [];
    this.knownPrograms = [];
    this.history = new HistoryController();
    this.history.init(cx);
    this.history.browseSpaces = Boolean(this.tree);
    this.defaultHistory = this.history;
    if (this.tree) {
      this.historyTree = new SpaceTree();
      this.historyTree.init(cx, { stateKey: "space-agents.history.tree", prefix: "history-space-tree", title: "History", manageSpaces: false, followActive: false, multiple: true });
      this.controllers = new Map(); this.preparingControllers = new Set(); this.visibleControllers = new Set();
      this.historyQuery = ""; this.historyQueryVersion = 0; this.searchExpandedIds = new Set(); this.searchKnownIds = new Set();
      this.historySearch = InputState.new({ placeholder: "Search all history…" });
      this.historySearch.on("change", (_event, cx) => {
        const query = this.historySearch.value().slice(0, 512), version = ++this.historyQueryVersion;
        cx.timer.after(250, cx => {
          if (this.closed || version !== this.historyQueryVersion) return;
          this.historyQuery = query; this.searchExpandedIds = new Set(spaces().map(s => s.id)); this.searchKnownIds = new Set(this.searchExpandedIds);
          for (const controller of this.controllers.values()) { controller.query = query; controller.selectedKey = null; controller.currentRequest = null; }
          cx.notify();
        });
      });
      this.historyOptions = { menuHandle: cx.focus_handle(), menuOpen: false, menuIndex: 0,
        chooseView: (mode, cx) => {
          setShared("space-agents.history.view", mode); this.historyOptions.menuOpen = false;
          for (const controller of this.visibleControllers) controller.refresh(cx);
          cx.notify();
        } };
      this.history.agentHandle = cx.focus_handle();
      this.history.onDeleted = key => this.forgetOtherControllers(this.defaultHistory, key);
      const allSpaces = spaces(), active = focused()?.space ?? allSpaces.find(s => s.active)?.id ?? allSpaces[0]?.id;
      for (const space of allSpaces) {
        const controller = space.id === active ? this.history : this.newController(cx);
        this.controllers.set(space.id, controller);
      }
    }
    this.sessionView = null;
    this.refreshingMetadata = false;
    this.metadataFingerprint = "";
    const directory = `${appHome()}/data/space-agents`;
    cx.spawn(async cx => {
      for (;;) {
        try { this.sessionView = JSON.parse(await readTextFile(`${directory}/session-view.json`) ?? "null"); } catch { this.sessionView = null; }
        cx.notify();
        try {
          const changed = await watchFolder(directory);
          if (showsAgents() && changed.some(path => path.endsWith("producer-changed.json"))) this.refreshMetadata(cx);
        } catch { break; }
      }
    });
    cx.timer.every(15000, cx => {
      if (showsAgents()) this.refreshMetadata(cx);
    });
    cx.spawn(async (cx) => {
      this.knownPrograms = await knownAgents();
      this.knownAgentKeys = this.knownPrograms.map(program => program.key);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => {
      if (showsAgents()) cx.notify();
    });
  }

  refreshMetadata(cx) {
    if (this.refreshingMetadata) return;
    this.refreshingMetadata = true;
    cx.spawn(async cx => {
      try {
        const home = appHome(), raw = await readTextFile(`${home}/data/space-agents/runtime.json`);
        if (raw) {
          const runtime = JSON.parse(raw), prefix = `${home}/integrations/session-metadata/releases/`;
          const absolute = value => typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/])/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
          if (runtime?.owner !== "herdr-session-metadata" || runtime.schema !== 1 || !absolute(runtime.node) || !absolute(runtime.stateRoot)
            || typeof runtime.helperPath !== "string" || !runtime.helperPath.startsWith(prefix)
            || !/^[a-f0-9-]{36}\/bin\/herdr-session-meta\.mjs$/.test(runtime.helperPath.slice(prefix.length))) throw Error("Metadata runtime unavailable");
          await exec(runtime.node, [runtime.helperPath, "refresh-view", "--json",
            "--app-home", home, "--state-root", runtime.stateRoot]);
        } else await exec("node", [`${home}/integrations/session-metadata/bin/herdr-session-meta.mjs`, "refresh-view", "--json"]);
        this.sessionView = JSON.parse(await readTextFile(`${appHome()}/data/space-agents/session-view.json`) ?? "null");
      } catch {} finally {
        this.refreshingMetadata = false;
        for (const controller of this.tree ? this.visibleControllers : [this.history]) controller.refresh(cx);
        cx.notify();
      }
    });
  }

  focusCard(card) {
    if (card.connection === "unavailable") return;
    if (this.tree) {
      const owner = card.space;
      if (!this.tree.live(owner)) return;
      if (focused()?.space !== owner) run("space.select", { id: owner });
    }
    if (card.pane) run("pane.focus", { pane: card.pane });
    else run("agent.focus", { terminal: card.address });
  }

  newController(cx) {
    const controller = new HistoryController(); controller.init(cx); controller.browseSpaces = Boolean(this.tree);
    if (this.tree) { controller.onDeleted = key => this.forgetOtherControllers(controller, key); controller.agentHandle = cx.focus_handle(); controller.query = this.historyQuery; }
    return controller;
  }

  forgetOtherControllers(source, key) {
    for (const controller of this.controllers.values()) if (controller !== source) controller.forgetSession(key);
  }

  controllerFor(space, cx) {
    if (!space) return null;
    const controller = this.controllers.get(space.id);
    if (controller) { this.visibleControllers.add(controller); return controller; }
    if (!this.preparingControllers.has(space.id)) {
      this.preparingControllers.add(space.id);
      cx.spawn(cx => {
        if (!this.closed && spaces().some(s => s.id === space.id)) this.controllers.set(space.id, this.newController(cx));
        this.preparingControllers.delete(space.id); if (!this.closed) cx.notify();
      });
    }
    return null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.tree?.close(); this.historyTree?.close();
    this.historySearch?.release(); this.historyOptions?.menuHandle.release(); this.historyQueryVersion++;
    for (const controller of new Set([this.defaultHistory, ...(this.controllers?.values() ?? [])])) controller.close();
    this.handle.release(); this.menuHandle.release();
  }

  viewOptions(t, mode) {
    const options = [{ value: "list", label: "List (default)" }, { value: "repository", label: "Group by repository" }];
    const choose = (value, cx) => {
      this.viewMenuOpen = false;
      setShared("space-agents.view", value);
      cx.notify();
    };
    return Popover.new("space-agent-view-options").open(this.viewMenuOpen).anchor("top_right").track_focus(this.menuHandle)
      .on_open_change((open, cx) => { this.viewMenuOpen = open; this.viewMenuIndex = mode === "repository" ? 1 : 0; cx.notify(); })
      .trigger(Button.new("space-agent-view-trigger").h(24).px(5).rounded(4).cursor_pointer().text_color(t.muted)
        .hover(el => el.bg(t.hover).text_color(t.foreground)).accessibility_label("View options").tooltip("View options")
        .child(svg("mods/workspace-chrome/layers.svg").size(14)))
      .content(v_flex().id("space-agent-view-menu").w(216).p(5).gap(2).rounded(7).bg(t.popover).text_color(t.foreground).role("menu")
        .accessibility_label("Agent view options")
        .on_key_down((event, cx) => {
          const key = event.key ?? event.keystroke;
          if (key === "up" || key === "down") this.viewMenuIndex = (this.viewMenuIndex + 1) % options.length;
          else if (key === "enter" || key === "space") choose(options[this.viewMenuIndex].value, cx);
          else return;
          cx.stop_propagation(); cx.notify();
        })
        .children(options.map((option, index) => Button.new(`space-agent-view-${option.value}`).h(31).px(8).gap(8).rounded(5).items_center()
          .bg(this.viewMenuIndex === index ? t.selected : t.popover).hover(el => el.bg(t.hover)).cursor_pointer().role("menu_item")
          .accessibility_label(`${option.label}${mode === option.value ? ", selected" : ""}`)
          .on_click((_event, cx) => choose(option.value, cx))
          .child(div().flex_1().text_size(12).child(option.label))
          .child(div().size(14).when(mode === option.value, el => el.child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.accent)))))));
  }

  card(card, compact, t, grouped = false, selection = { handle: this.handle, address: this.keyboardAddress }) {
    const lookup = this.prs.peek(card);
    const pr = cardPullRequest(card, lookup);
    const dense = Boolean(this.tree) && !compact;
    const directory = dense ? [repositoryLabel(card, pr), card.branch || (card.detached ? "Detached HEAD" : null)].filter(Boolean).join(" · ")
      : grouped ? card.branch || (card.detached ? "Detached HEAD" : repositoryLabel(card, pr)) : repositoryLabel(card, pr);
    const checkout = grouped && ["checkout", "worktree"].includes(card.checkoutType) ? card.checkoutType === "worktree" ? "Worktree" : "Checkout" : null;
    const status = STATUS[card.status] ?? "Status unavailable";
    const description = `${card.title}, ${card.program?.name ?? "Agent"}, ${checkout ? `${checkout}, ` : ""}${directory}, ${status}${pr ? `, PR #${pr.number}${pr.source === "title" ? ", unverified from session title" : ", verified on GitHub"}` : ""}`;
    const title = pr ? card.title.replace(new RegExp(`(^|\\s)#${pr.number}\\b`), "$1").replace(/\s{2,}/g, " ").trim() || card.title : card.title;
    const keyboardFocus = selection.handle.is_focused() && selection.address === card.address;
    const selected = card.focused || keyboardFocus;
    const prHint = !pr ? "" : pr.source === "title"
      ? `PR #${pr.number} from session title; not verified on GitHub${lookup.message ? `. ${lookup.message}` : ""}`
      : pr.source === "terminal"
        ? `PR #${pr.number} · Verified on GitHub; found in recent terminal output`
        : `PR #${pr.number} · Verified on GitHub · ${card.branch ?? "current branch"}`;
    const mark = () => card.status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
      : card.status === "idle" || !card.status
        ? div().size(6).flex_none().rounded(3).border(1).border_color(t[card.status] ?? t.dim)
        : div().size(6).flex_none().rounded(3).bg(t[card.status] ?? t.dim);
    const root = v_flex().id(`space-agent-${card.address}`).w_full().min_w(0).flex_none()
      .p(8).gap(4).rounded(7).border(1).border_color(selected ? t.accent : t.border)
      .when(dense, el => el.px(6).py(4).gap(2).rounded(3).border_color(keyboardFocus ? t.accent : "#00000000"))
      .bg(card.focused ? t.selected : dense ? t.chrome : t.surface).text_color(t.foreground)
      .cursor_pointer().hover(el => el.bg(card.focused ? t.selected : t.hover).border_color(dense ? keyboardFocus ? t.accent : "#00000000" : selected ? t.accent : t.input))
      .role("list_box_option").accessibility_label(description).aria_selected(card.focused)
      .when(selection.address === card.address, el => el.aria_active_descendant())
      .on_click(() => this.focusCard(card));

    if (compact) return root.p(8).tooltip(description)
      .child(h_flex().items_center().justify_center().gap(5).child(harness(card.program, t.foreground)).child(mark()));

    return root
      .child(h_flex().h(dense ? 16 : 18).flex_none().min_w(0).items_center().gap(dense ? 4 : 8)
        .child(h_flex().flex_none().tooltip(card.program?.name ?? "Agent").child(harness(card.program, t.foreground, dense ? 14 : 16)))
        .child(div().id(`space-agent-title-${card.address}`).flex_1().min_w(0).text_size(dense ? 12.5 : 13).font_medium().truncate().tooltip(card.title).child(title))
        .child(h_flex().id(`space-agent-status-${card.address}`).flex_none().items_center().gap(4)
          .tooltip(status).role("image").accessibility_label(status).child(mark())
          .when(card.status === "blocked", el => el.child(div().text_size(10.5).font_medium().text_color(t.blocked).child("Needs you")))
          .when(!card.status, el => el.child(div().text_size(10.5).text_color(t.muted).child("No status")))))
      .child(h_flex().h(dense ? 14 : 18).flex_none().pl(dense ? 18 : 24).min_w(0).items_center().gap(6).text_size(dense ? 11 : 11.5).text_color(t.muted)
        .when(Boolean(checkout), el => el.child(h_flex().id(`space-agent-checkout-${card.address}`).flex_none().h(dense ? 14 : 16).px(4).rounded(3)
          .items_center().bg(t.raised).text_color(t.muted).text_size(9.5).font_medium()
          .accessibility_label(checkout)
          .tooltip(`${checkout} — ${checkout === "Worktree" ? "Linked working directory" : "Primary working directory of this clone"}${card.branch ? ` · ${card.branch}` : ""} · ${card.cwd ?? "Directory unavailable"}`)
          .child(checkout === "Worktree" ? "W" : "C")))
        .child(div().flex_1().min_w(0).truncate().tooltip(card.metadataHint ?? `${card.cwd ?? "Directory unavailable"}${pr?.repo ? ` · ${pr.repo.owner}/${pr.repo.name}` : ""}`).child(directory))
        .when(Boolean(pr), el => el.child((pr?.url ? Button.new(`space-agent-pr-${card.address}`) : h_flex().id(`space-agent-pr-${card.address}`)).flex().flex_none().h(dense ? 14 : 18).px(5).rounded(4)
          .bg(t.raised).items_center().gap(4).text_size(10.5).font_medium().text_color(pr?.source === "title" ? t.muted : t.accent)
          .tooltip(prHint + (card.prStale ? " · GitHub unavailable; last verified association" : ""))
          .when(Boolean(pr?.url), badge => badge.accessibility_label(`Open PR #${pr.number} in browser`).cursor_pointer()
            .on_click((_event, cx) => {
              cx.stop_propagation();
              run("pane.focus", { pane: card.pane });
              cx.open_url(pr.url);
            }))
          .child(svg("mods/space-agents/pull-request.svg").size(11))
           .child(`#${pr.number}`))))
      .when(card.connection === "unavailable", el => el.child(div().pl(24).text_size(11).text_color(t.muted).child("Connection unavailable")))
      .when(Boolean(card.identityPending), el => el.tooltip("Session identity is unavailable. Enable the harness metadata integration to reconcile history."));
  }

  render(cx) {
    if (!this.tree) return this.renderSpace(cx);
    const t = theme(), allSpaces = spaces(), active = focused()?.space ?? allSpaces.find(s => s.active)?.id;
    const liveIds = new Set(allSpaces.map(space => space.id));
    for (const [id, controller] of this.controllers) if (!liveIds.has(id)) { this.controllers.delete(id); controller.close(); }
    const compact = (sidebar(layout())?.size?.px ?? 320) < 160;
    this.tree.sync(allSpaces, active);
    this.historyTree.sync(allSpaces, active);
    const historyOpen = shared("space-agents.history.open") === true;
    const searching = Boolean(this.historyQuery.trim());
    this.visibleControllers = new Set(); this.agentCount = 0; this.agentOrder = [];
    this.historyVisibleIds = new Set();
    const agentsContent = new Map(), historyContent = new Map(), historyGroups = new Set(), historyControllers = new Set(), historyHints = new Map();
    if (!compact) {
      for (const space of this.tree.groups().flatMap(group => group.spaces).filter(space => this.tree.expandedIds.has(space.id))) {
        const controller = this.controllerFor(space, cx);
        if (controller) { this.history = controller; agentsContent.set(space.id, this.renderSpace(cx, { space, controller, part: "agents" })); }
      }
      if (historyOpen) {
        for (const space of searching ? allSpaces : allSpaces.filter(space => this.historyTree.expandedIds.has(space.id))) {
          if (searching && !this.searchKnownIds.has(space.id)) { this.searchKnownIds.add(space.id); this.searchExpandedIds.add(space.id); }
          if (!this.historyTree.ready(space.machine)) { historyGroups.add(space.id); continue; }
          const controller = this.controllerFor(space, cx);
          if (!controller) { historyGroups.add(space.id); continue; }
          const content = this.renderSpace(cx, { space, controller, part: "history" });
          if (controller.page && !controller.page.complete) historyHints.set(space.id, "Some history sources are unavailable. Showing known sessions.");
          const visible = !searching || controller.historyMatchCount || controller.loading || controller.error || !controller.page || !controller.page.complete;
          if (visible) {
            historyGroups.add(space.id); historyContent.set(space.id, content);
            if (!searching || this.searchExpandedIds.has(space.id)) { this.historyVisibleIds.add(space.id); historyControllers.add(controller); }
          }
        }
      }
    }
    setAgentOrder(this.agentOrder);
    for (const controller of this.visibleHistoryControllers ?? []) if (!historyControllers.has(controller)) { controller.confirmDeleteKey = null; controller.menuOpen = false; }
    this.visibleHistoryControllers = historyControllers;
    const tools = h_flex().gap(8).items_center()
      .child(div().text_size(12).text_color(t.muted).tooltip("Agents in expanded Spaces").child(String(this.agentCount)))
      .child(this.viewOptions(t, agentViewMode(shared("space-agents.view"))));
    this.historyOptions.mode = historyViewMode(shared("space-agents.history.view"));
    const savedTree = this.historyTree.render(historyContent, false, t, { heading: false,
      expanded: searching ? this.searchExpandedIds : null, visible: searching ? historyGroups : null, hints: historyHints });
    const savedContent = searching && !historyGroups.size
      ? v_flex().p(14).child(div().text_size(12).text_color(t.muted).child("No matching sessions across Spaces.")) : savedTree;
    return renderSidebarAreas({ theme: t, compact, height: this.sidebarHeight ?? 600, historyOpen,
      historyHeight: shared("space-agents.history.height"), agents: this.tree.render(agentsContent, compact, t, { tools }),
      history: savedContent, search: this.historySearch, historyMenu: renderHistoryViewOptions(this.historyOptions, t),
      onSize: (size, cx) => { if (this.sidebarHeight !== size.height) { this.sidebarHeight = size.height; cx.notify(); } },
      onHeight: (height, cx) => { setShared("space-agents.history.height", height); cx.notify(); },
      onToggle: (_e, cx) => {
        setShared("space-agents.history.open", compact || !historyOpen);
        if (compact) run("layout.resize", { id: "sidebar", px: 320 });
        cx.notify();
      } });
  }

  renderSpace(cx, { space: requestedSpace, controller: history = this.history, part = "combined" } = {}) {
    const t = theme();
    const allSpaces = spaces();
    const activeSpace = focused()?.space ?? allSpaces.find(s => s.active)?.id;
    const selectedSpace = requestedSpace?.id ?? activeSpace;
    const space = allSpaces.find(s => s.id === selectedSpace);
    const compact = (sidebar(layout())?.size?.px ?? 320) < 160;
    const liveTerminals = terminals();
    const allPanes = panes();
    const records = readSessionView(this.sessionView, liveTerminals);
    const mode = agentViewMode(shared("space-agents.view"));
    const grouped = mode === "repository";
    const allAgents = agents();
    const candidates = agentCards({ allAgents, allSpaces, allPanes, allTerminals: liveTerminals, selectedSpace, knownAgentKeys: this.knownAgentKeys });
    const terminalByAddress = new Map(liveTerminals.map(t => [t.address, t]));
    const bound = readLiveSessionBindings(this.sessionView, liveTerminals), presence = [];
    const paired = new Set([...bound].filter(([, entry]) => entry.binding.mode === "paired").map(([address]) => address)
      .concat(history.registry.sessions.flatMap(row => row.bindings.filter(b => b.mode === "paired").map(b => b.address))));
    const closed = new Set(candidates.filter(card => !paired.has(card.address)
      && this.agentPresence.peek(card, terminalByAddress.get(card.address)) === "closed").map(card => card.address));
    const observed = candidates.filter(card => !closed.has(card.address));
    const projected = observed.map(card => records.has(card.address) ? projectSessionCard(card, records.get(card.address)) : { ...card, ...this.workingDirs.peek(card) })
      .map(card => ({ ...card, projectRepo: card.projectRepo ?? cardPullRequest(card, this.prs.peek(card))?.repo ?? null }));
    const mapped = history.registry.sources.find(s => s.machine === space?.machine && s.machine != null);
    const remembered = history.space?.id === space?.id ? history.space : history.contexts.get(JSON.stringify([space?.id, space?.machine ?? null]));
    const coreSession = [...bound.values()].find(e => observed.some(c => c.address === (e.binding.viewTerminal ?? e.binding.terminal)))?.binding.coreSession ?? remembered?.coreSession ?? "default";
    history.setSpace(space ? { id: space.id, machine: space.machine ?? null, host: mapped?.host ?? space.machine ?? "local", coreSession, folder: space.folder } : null);
    for (const [address, entry] of bound) {
      if (closed.has(address)) { presence.push({ state: "closed", binding: entry.binding }); continue; }
      const pane = allPanes.find(p => p.terminal === address), agent = allAgents.find(a => a.address === address);
      const owner = allSpaces.find(s => s.id === agent?.space || s.tabs.some(tab => tab.id === pane?.tab));
      const program = agent?.program ?? pane?.program, expected = entry.binding.session.harness === "claude" ? "claude" : "opencode";
      if (!owner || program?.key !== expected) continue;
      presence.push({ state: "open", binding: { ...entry.binding, address, title: entry.record.canonicalTitle || agent?.title || program.name,
        space: { host: owner.machine ? entry.binding.session.host : "local", coreSession: entry.binding.coreSession, id: owner.id },
        tab: agent?.tab ?? pane?.tab, pane: pane?.pane ?? agent?.pane ?? null, focused: agent?.focused ?? pane?.focused ?? false,
        activity: agent?.status ?? pane?.status ?? null, directory: entry.binding.lookupDir } });
    }
    for (const row of history.registry.sessions) for (const binding of row.bindings) {
      if (closed.has(binding.address) && binding.createdMs === terminalByAddress.get(binding.address)?.created_ms) presence.push({ state: "closed", binding });
    }
    const partition = history.partition(presence);
    history.mode = historyViewMode(shared("space-agents.history.view"));
    if (space && (!history.currentRequest || this.tree && history.currentRequest.view !== history.mode)) history.refresh(cx);
    const historyGroups = history.groups(partition.history), historyRows = historyGroups.flatMap(g => g.rows), renderedQuery = history.query;
    history.historyMatchCount = historyRows.length;
    if (part === "history") return renderSessionHistory({ rows: historyRows, groups: historyGroups, controller: history, compact, theme: t,
      knownPrograms: this.knownPrograms, folded: false, heading: false, controls: false,
      isCurrent: () => shared("space-agents.history.open") === true && history.query === renderedQuery && this.historyVisibleIds.has(selectedSpace)
        && (this.historyQuery.trim() ? this.searchExpandedIds : this.historyTree.expandedIds).has(selectedSpace) && Boolean(this.historyTree.live(selectedSpace)) });
    const covered = new Set([...partition.agents, ...partition.history].flatMap(row => row.bindings.map(b => b.address)).concat(presence.map(o => o.binding.address)));
    const resolved = partition.agents.map(row => {
      const card = projected.find(c => c.address === row.primaryBinding.address);
      return { ...card, address: row.primaryBinding.address, pane: card?.pane ?? row.primaryBinding.pane, title: card?.title ?? row.title,
        cwd: card?.cwd ?? row.directory, directory: card?.directory ?? row.directory?.split(/[\\/]/).pop() ?? "Directory unavailable",
        program: historyProgram(row.session, this.knownPrograms), status: row.activity, connection: row.connection, focused: row.primaryBinding.focused,
        space: selectedSpace, machine: space?.machine ?? null, sessionBound: true, sessionKey: row.key, session: row.session };
    });
    const displayCards = [...resolved, ...projected.filter(c => !covered.has(c.address)).map(c => ({ ...c, identityPending: true }))];
    const groups = grouped ? agentGroups(displayCards) : [];
    const cards = grouped ? groups.flatMap(group => group.cards) : displayCards;
    const fingerprint = JSON.stringify(cards.map(c => [c.address, c.title, c.status, c.cwd, c.branch]));
    const fingerprintOwner = this.tree ? history : this;
    if (fingerprint !== fingerprintOwner.metadataFingerprint && showsAgents()) {
      fingerprintOwner.metadataFingerprint = fingerprint;
      this.refreshMetadata(cx);
    }
    const collapsedGroups = shared("space-agents.groups") ?? {};
    const groupStateKey = group => JSON.stringify([selectedSpace, space?.machine ?? null, group.key]);
    const groupCollapsed = group => !compact && Boolean(collapsedGroups[groupStateKey(group)]);
    const visibleCards = grouped ? groups.filter(group => !groupCollapsed(group)).flatMap(group => group.cards) : cards;
    const keyboard = this.tree ? history : this, handle = this.tree ? history.agentHandle : this.handle;
    const addressKey = this.tree ? "agentAddress" : "keyboardAddress";
    if (!visibleCards.some(c => c.address === keyboard[addressKey])) keyboard[addressKey] = (visibleCards.find(c => c.focused) ?? visibleCards[0])?.address ?? null;
    const order = visibleCards.filter(c => c.connection !== "unavailable").map(c => c.address);
    if (this.tree) this.agentOrder.push(...order); else setAgentOrder(order);
    const selection = { handle, address: keyboard[addressKey] };
    for (const card of candidates) {
      const terminal = terminalByAddress.get(card.address);
      if (paired.has(card.address) || !this.agentPresence.needs(card, terminal)) continue;
      cx.spawn(async cx => { await this.agentPresence.refresh(card, terminal, exec); cx.notify(); });
    }
    for (const card of observed) {
      if (records.has(card.address) || !this.workingDirs.needs(card)) continue;
      cx.spawn(async cx => { await this.workingDirs.refresh(card, exec); cx.notify(); });
    }
    for (const card of cards) {
      if (!this.prs.needs(card)) continue;
      cx.spawn(async (cx) => {
        await this.prs.refresh(card, exec);
        cx.notify();
      });
    }

    const folded = part === "agents" ? {} : shared("space-agents.sections") ?? {};
    if (part === "agents") this.agentCount += cards.length;
    const sections = v_flex().id(part === "agents" ? `space-agent-sections-${selectedSpace}` : "space-agent-sections").w_full().min_w(0).flex_none()
      .when(!compact && part === "combined", el => el.child(h_flex().h(48).px(14).gap(8).flex_none().items_center()
        .child(Button.new("agents-section-toggle").h(28).gap(6).items_center().cursor_pointer().accessibility_label(folded.agents ? "Expand Agents" : "Collapse Agents")
          .on_click((_e, cx) => history.toggle("agents", cx)).child(svg(`mods/workspace-chrome/chevron-${folded.agents ? "right" : "down"}.svg`).size(12).text_color(t.muted))
          .child(div().text_size(13).font_medium().text_color(t.foreground).child("Agents")))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).truncate().child(this.tree ? "" : space?.name ?? "No space selected"))
        .child(div().text_size(12).text_color(t.muted).child(String(cards.length)))
        .child(this.viewOptions(t, mode))))
      .when(cards.length === 0 && !compact && !folded.agents, el => el.child(v_flex().px(14).pb(16).gap(6)
        .child(div().text_size(13).text_color(t.foreground).child(space ? "No agents in this space" : "Select a space"))
        .child(div().text_size(12).text_color(t.muted).child(space ? "Start an agent in a tab to see it here." : "Its agents will appear here."))))
      .child(v_flex().id(`space-agent-list-${selectedSpace ?? "none"}`).flex_none().min_h(0)
        .pl(compact ? 4 : this.tree ? 6 : 10).pr(compact ? 4 : 10).pt(compact ? 8 : 0).pb(10).gap(this.tree ? 4 : 6)
        .role("list_box").accessibility_label(`Agents in ${space?.name ?? "selected space"}`)
        .track_focus(handle).tab_stop(true)
        .on_key_down((event, cx) => {
          if (!visibleCards.length) return;
          const index = Math.max(0, visibleCards.findIndex(c => c.address === keyboard[addressKey]));
          if (event.keystroke === "enter" || event.keystroke === "space") {
            cx.stop_propagation();
            this.focusCard(visibleCards[index]);
          } else if (event.keystroke === "up" || event.keystroke === "down") {
            cx.stop_propagation();
            keyboard[addressKey] = visibleCards[(index + (event.keystroke === "down" ? 1 : visibleCards.length - 1)) % visibleCards.length].address;
            cx.notify();
          }
        })
        .children(folded.agents ? [] : grouped ? groups.map(group => {
          const collapsed = groupCollapsed(group), key = groupStateKey(group);
          const toggle = (_event, cx) => {
            const saved = shared("space-agents.groups") ?? {};
            setShared("space-agents.groups", { ...saved, [key]: !saved[key] });
            cx.stop_propagation(); cx.notify();
          };
          return v_flex().id(`space-agent-group-${key}`).w_full().flex_none().gap(this.tree ? 4 : 6).role("group")
            .accessibility_label(`${group.name}, ${group.cards.length} agents`)
            .when(!compact, el => el.child(Button.new(`space-agent-group-toggle-${key}`).w_full().h(28).px(8).gap(6).rounded(4)
              .items_center().text_size(11.5).text_color(t.muted).cursor_pointer().tab_stop(true)
              .hover(el => el.bg(t.hover).text_color(t.foreground)).tooltip(group.tooltip)
              .accessibility_label(`${collapsed ? "Expand" : "Collapse"} ${group.name}`).on_click(toggle)
              .on_key_down((event, cx) => { if (event.keystroke === "enter" || event.keystroke === "space") cx.stop_propagation(); })
              .child(svg(`mods/workspace-chrome/chevron-${collapsed ? "right" : "down"}.svg`).size(12).flex_none())
              .child(div().flex_1().min_w(0).truncate().font_medium().child(group.name))
              .child(div().flex_none().child(String(group.cards.length)))))
            .children(collapsed ? [] : group.cards.map(card => this.card(card, compact, t, true, selection)));
        }) : cards.map(card => this.card(card, compact, t, false, selection))))
      .when(part === "combined", el => el.child(renderSessionHistory({ rows: historyRows, groups: historyGroups, controller: history, compact, theme: t, knownPrograms: this.knownPrograms, folded: Boolean(folded.history) })));
    if (part === "agents") return sections;
    return v_flex().id("space-agents").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .role("region").accessibility_label(`Agents in ${space?.name ?? "selected space"}`)
      .child(v_flex().id("space-agent-scroll").flex_1().min_h(0).overflow_y_scrollbar().mode("always").child(sections))
      .when(compact, el => el.child(h_flex().h(32).flex_none().justify_center().items_center()
        .child(Button.new("expand-space-sidebar").p(6).rounded(5).cursor_pointer().text_color(t.muted)
          .accessibility_label("Expand sidebar")
          .hover(el => el.bg(t.hover).text_color(t.foreground)).tooltip("Expand sidebar")
          .on_click(() => run("layout.resize", { id: "sidebar", px: 320 }))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(14)))));
  }
}
