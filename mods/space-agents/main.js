import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, layout, shared, setShared, setAgentOrder, exec, knownAgents, appHome, readTextFile, watchFolder } from "herdr";
import { agentCards, agentGroups, agentViewMode, WorkingDirectories, PullRequests, cardPullRequest, repositoryLabel } from "./model.js";
import { readSessionView, projectSessionCard } from "./session-metadata.js";

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

export default class SpaceAgents extends View {
  init(_props, cx) {
    this.prs = new PullRequests();
    this.workingDirs = new WorkingDirectories();
    this.handle = cx.focus_handle();
    this.menuHandle = cx.focus_handle();
    this.viewMenuOpen = false;
    this.viewMenuIndex = 0;
    this.keyboardAddress = null;
    this.knownAgentKeys = [];
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
          if (shared("layout") === "herdr-workspace" && changed.some(path => path.endsWith("producer-changed.json"))) this.refreshMetadata(cx);
        } catch { break; }
      }
    });
    cx.timer.every(15000, cx => {
      if (shared("layout") === "herdr-workspace") this.refreshMetadata(cx);
    });
    cx.spawn(async (cx) => {
      this.knownAgentKeys = (await knownAgents()).map(program => program.key);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => {
      if (shared("layout") === "herdr-workspace") cx.notify();
    });
  }

  refreshMetadata(cx) {
    if (this.refreshingMetadata) return;
    this.refreshingMetadata = true;
    cx.spawn(async cx => {
      try {
        const home = appHome(), raw = await readTextFile(`${home}/data/session-plans/runtime.json`);
        if (raw) {
          const runtime = JSON.parse(raw), prefix = `${home}/integrations/session-metadata/releases/`;
          const absolute = value => typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/])/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
          if (runtime?.owner !== "herdr-session-metadata" || runtime.schema !== 1 || !absolute(runtime.node) || !absolute(runtime.stateRoot)
            || typeof runtime.helperPath !== "string" || !runtime.helperPath.startsWith(prefix)
            || !/^[a-f0-9-]{36}\/bin\/herdr-plan\.mjs$/.test(runtime.helperPath.slice(prefix.length))) throw Error("Metadata runtime unavailable");
          await exec(runtime.node, [runtime.helperPath.replace(/herdr-plan\.mjs$/, "herdr-session-meta.mjs"), "refresh-view", "--json",
            "--app-home", home, "--state-root", runtime.stateRoot]);
        } else await exec("node", [`${home}/integrations/session-metadata/bin/herdr-session-meta.mjs`, "refresh-view", "--json"]);
        this.sessionView = JSON.parse(await readTextFile(`${appHome()}/data/space-agents/session-view.json`) ?? "null");
      } catch {} finally { this.refreshingMetadata = false; cx.notify(); }
    });
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

  card(card, compact, t, grouped = false) {
    const lookup = this.prs.peek(card);
    const pr = cardPullRequest(card, lookup);
    const directory = grouped ? card.branch || (card.detached ? "Detached HEAD" : repositoryLabel(card, pr)) : repositoryLabel(card, pr);
    const checkout = grouped && ["checkout", "worktree"].includes(card.checkoutType) ? card.checkoutType === "worktree" ? "Worktree" : "Checkout" : null;
    const status = STATUS[card.status] ?? "Status unavailable";
    const description = `${card.title}, ${card.program?.name ?? "Agent"}, ${checkout ? `${checkout}, ` : ""}${directory}, ${status}${pr ? `, PR #${pr.number}${pr.source === "title" ? ", unverified from session title" : ", verified on GitHub"}` : ""}`;
    const title = pr ? card.title.replace(new RegExp(`(^|\\s)#${pr.number}\\b`), "$1").replace(/\s{2,}/g, " ").trim() || card.title : card.title;
    const selected = card.focused || (this.handle.is_focused() && this.keyboardAddress === card.address);
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
      .bg(card.focused ? t.selected : t.surface).text_color(t.foreground)
      .cursor_pointer().hover(el => el.bg(card.focused ? t.selected : t.hover).border_color(selected ? t.accent : t.input))
      .role("list_box_option").accessibility_label(description).aria_selected(card.focused)
      .when(this.keyboardAddress === card.address, el => el.aria_active_descendant())
      .on_click(() => run("pane.focus", { pane: card.pane }));

    if (compact) return root.p(8).tooltip(description)
      .child(h_flex().items_center().justify_center().gap(5).child(harness(card.program, t.foreground)).child(mark()));

    return root
      .child(h_flex().h(18).flex_none().min_w(0).items_center().gap(8)
        .child(h_flex().flex_none().tooltip(card.program?.name ?? "Agent").child(harness(card.program, t.foreground, 16)))
        .child(div().id(`space-agent-title-${card.address}`).flex_1().min_w(0).text_size(13).font_medium().truncate().tooltip(card.title).child(title))
        .child(h_flex().id(`space-agent-status-${card.address}`).flex_none().items_center().gap(4)
          .tooltip(status).role("image").accessibility_label(status).child(mark())
          .when(card.status === "blocked", el => el.child(div().text_size(10.5).font_medium().text_color(t.blocked).child("Needs you")))
          .when(!card.status, el => el.child(div().text_size(10.5).text_color(t.muted).child("No status")))))
      .child(h_flex().h(18).flex_none().pl(24).min_w(0).items_center().gap(6).text_size(11.5).text_color(t.muted)
        .when(Boolean(checkout), el => el.child(h_flex().id(`space-agent-checkout-${card.address}`).flex_none().h(16).px(4).rounded(3)
          .items_center().bg(t.raised).text_color(t.muted).text_size(9.5).font_medium()
          .accessibility_label(checkout)
          .tooltip(`${checkout} — ${checkout === "Worktree" ? "Linked working directory" : "Primary working directory of this clone"}${card.branch ? ` · ${card.branch}` : ""} · ${card.cwd ?? "Directory unavailable"}`)
          .child(checkout === "Worktree" ? "W" : "C")))
        .child(div().flex_1().min_w(0).truncate().tooltip(card.metadataHint ?? `${card.cwd ?? "Directory unavailable"}${pr?.repo ? ` · ${pr.repo.owner}/${pr.repo.name}` : ""}`).child(directory))
        .when(Boolean(pr), el => el.child((pr?.url ? Button.new(`space-agent-pr-${card.address}`) : h_flex().id(`space-agent-pr-${card.address}`)).flex().flex_none().h(18).px(5).rounded(4)
          .bg(t.raised).items_center().gap(4).text_size(10.5).font_medium().text_color(pr?.source === "title" ? t.muted : t.accent)
          .tooltip(prHint + (card.prStale ? " · GitHub unavailable; last verified association" : ""))
          .when(Boolean(pr?.url), badge => badge.accessibility_label(`Open PR #${pr.number} in browser`).cursor_pointer()
            .on_click((_event, cx) => {
              cx.stop_propagation();
              run("pane.focus", { pane: card.pane });
              cx.open_url(pr.url);
            }))
          .child(svg("mods/space-agents/pull-request.svg").size(11))
          .child(`#${pr.number}`))));
  }

  render(cx) {
    const t = theme();
    const allSpaces = spaces();
    const selectedSpace = focused()?.space ?? allSpaces.find(s => s.active)?.id;
    const space = allSpaces.find(s => s.id === selectedSpace);
    const liveTerminals = terminals();
    const records = readSessionView(this.sessionView, liveTerminals);
    const mode = agentViewMode(shared("space-agents.view"));
    const grouped = mode === "repository";
    const observed = agentCards({ allAgents: agents(), allSpaces, allPanes: panes(), allTerminals: liveTerminals, selectedSpace, knownAgentKeys: this.knownAgentKeys });
    const projected = observed.map(card => records.has(card.address) ? projectSessionCard(card, records.get(card.address)) : { ...card, ...this.workingDirs.peek(card) })
      .map(card => ({ ...card, projectRepo: card.projectRepo ?? cardPullRequest(card, this.prs.peek(card))?.repo ?? null }));
    const groups = grouped ? agentGroups(projected) : [];
    const cards = grouped ? groups.flatMap(group => group.cards) : projected;
    const fingerprint = JSON.stringify(cards.map(c => [c.address, c.title, c.status, c.cwd, c.branch]));
    if (fingerprint !== this.metadataFingerprint && shared("layout") === "herdr-workspace") {
      this.metadataFingerprint = fingerprint;
      this.refreshMetadata(cx);
    }
    const compact = (sidebar(layout())?.size?.px ?? 320) < 160;
    if (!cards.some(c => c.address === this.keyboardAddress)) this.keyboardAddress = (cards.find(c => c.focused) ?? cards[0])?.address ?? null;
    setAgentOrder(cards.map(c => c.address));
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

    return v_flex().id("space-agents").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .role("region").accessibility_label(`Agents in ${space?.name ?? "selected space"}`)
      .when(!compact, el => el.child(h_flex().h(48).px(14).gap(8).flex_none().items_center()
        .child(div().text_size(13).font_medium().text_color(t.foreground).child("Agents"))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).truncate().child(space?.name ?? "No space selected"))
        .child(div().text_size(12).text_color(t.muted).child(String(cards.length)))
        .child(this.viewOptions(t, mode))))
      .when(cards.length === 0 && !compact, el => el.child(v_flex().px(14).pb(16).gap(6)
        .child(div().text_size(13).text_color(t.foreground).child(space ? "No agents in this space" : "Select a space"))
        .child(div().text_size(12).text_color(t.muted).child(space ? "Start an agent in a tab to see it here." : "Its agents will appear here."))))
      .child(v_flex().id(`space-agent-list-${selectedSpace ?? "none"}`).flex_1().min_h(0)
        .px(compact ? 4 : 10).pt(compact ? 8 : 0).pb(10).gap(6).overflow_y_scrollbar().mode("always")
        .role("list_box").accessibility_label(`Agents in ${space?.name ?? "selected space"}`)
        .track_focus(this.handle).tab_stop(true)
        .on_key_down((event, cx) => {
          if (!cards.length) return;
          const index = Math.max(0, cards.findIndex(c => c.address === this.keyboardAddress));
          if (event.keystroke === "enter" || event.keystroke === "space") {
            cx.stop_propagation();
            run("pane.focus", { pane: cards[index].pane });
          } else if (event.keystroke === "up" || event.keystroke === "down") {
            cx.stop_propagation();
            this.keyboardAddress = cards[(index + (event.keystroke === "down" ? 1 : cards.length - 1)) % cards.length].address;
            cx.notify();
          }
        })
        .children(grouped ? groups.map((group, index) => v_flex().id(`space-agent-group-${index}`).w_full().flex_none().gap(6).role("group")
          .accessibility_label(`${group.name}, ${group.cards.length} agents`)
          .when(!compact, el => el.child(h_flex().px(8).pt(8).pb(3).gap(6).items_center().text_size(11.5).text_color(t.muted)
            .child(div().flex_1().min_w(0).truncate().font_medium().tooltip(group.tooltip).child(group.name))
            .child(div().flex_none().child(String(group.cards.length)))))
          .children(group.cards.map(card => this.card(card, compact, t, true)))) : cards.map(card => this.card(card, compact, t))))
      .when(compact, el => el.child(h_flex().h(32).flex_none().justify_center().items_center()
        .child(Button.new("expand-space-sidebar").p(6).rounded(5).cursor_pointer().text_color(t.muted)
          .accessibility_label("Expand sidebar")
          .hover(el => el.bg(t.hover).text_color(t.foreground)).tooltip("Expand sidebar")
          .on_click(() => run("layout.resize", { id: "sidebar", px: 320 }))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(14)))));
  }
}
