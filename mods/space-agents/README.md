# Space agents

A native Herdr sidebar. The `herdr-workspace` layout enables its Agents tree
with `{ "tree": true }` and puts History in a separate area above Settings.
It reuses shipped assets without requiring edits to shipped files. Layouts that
omit the tree prop retain the selected-space Agents/History panel.

## Agents and History trees

All Space names remain visible in one scrollable list, grouped by machine.
Several Agent Spaces can stay open. Each chevron only expands or collapses its
own branch; clicking its Space name also switches your workspace.
Flat agent rows sit directly beneath the Space, without a nested Agents
heading. Its view options and count live beside the top Agents heading.

History starts collapsed above the native Settings footer. Expanding it reveals
its own Space tree. Drag the native divider above History to adjust its height;
the height is remembered in `space-agents.history.height`. Collapsing History
returns that space to Agents.
History Space names and chevrons only browse: they do not switch the active
workspace or change the Agents branch. The open preference is saved separately
in `space-agents.history.open`; old nested History fold preferences do not open
the new area by default. The History title is left aligned with Agents.

One search field beneath History searches saved sessions across all Spaces.
Results remain grouped by Space and matching groups open temporarily. Clearing
the query restores normal History browsing. Several History Spaces can stay
open independently. Its global view menu offers Recent, By folder and By harness;
load-more controls remain inside their matching Space.

Clicking an agent or saved conversation first selects its owning Space, then
focuses or opens that exact session. The two areas share one controller and
session partition per Space, so browsing sessions cannot duplicate activated
agents. Open Agent Spaces and normal History browsing load their displayed
contexts; a global History search queries every available Space. A collapsed
History area does not load an additional Space. Late responses stay in their own Space cache, and
hidden History rows cannot open or delete a session. Confirmed deletion also
invalidates other Space controllers, their pending pages and in-flight resume
operations. Removed Spaces dispose their retained controls and deferred work.

Opened-Space sets are remembered in `space-agents.tree` and
`space-agents.history.tree`. Old single-Space state migrates without losing its
open branch. Switching workspaces through another control reveals
the new active Agents Space without changing the History branch. Collapsing a
branch does not close any session.

With the Space list focused, Up/Down and Home/End move the highlight, Right
expands, Left collapses, and Enter/Space selects (or browses, in History).
Right-click in Agents retains the native Space menu. Drag names to reorder within
a machine. The plus controls in Agents create on
their labelled machine; unavailable machines cannot fall back to local creation.
A narrow sidebar shows all Agent Space avatars, an Expand sidebar control and a
History control that expands the sidebar and opens History.

## Use

Activate:

```sh
herdr-app do layout.switch '{"name":"herdr-workspace"}'
```

Return to the shipped layout:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Cards show the canonical bound session title, otherwise the reported session
title or harness name; the harness icon; the verified repo/subdirectory (or
folder basename); agent status; and an optional
GitHub PR number. Cards use two rows; status is an indicator with a tooltip,
with explicit “Needs you” and “No status” cues when relevant. In the Spaces tree,
agents use dense two-line rows, center harness icons under Space dots, align
titles and metadata with Space names, and show directory
plus branch on the second line. The full working path stays in the tooltip. Click a card to
focus its pane. With the list focused, use
Up/Down to choose a card and Enter/Space to focus it. A narrow sidebar shows
icons with tooltips instead of full cards.

Only the verified PR button opens its canonical URL in the browser; it also
focuses the associated pane. Title-only numbers are not links. Tab names are
neither a title source nor a synchronization target. See the
[installation guide](../../docs/installation.md) for opt-in harness setup and upgrades,
and [architecture notes](../../docs/architecture.md) for the shared helper and observe-only naming.

The list updates automatically when the expanded space changes or Herdr detects
an agent program running in a pane. A newly launched agent appears before its
first live status report (OSC 7501), with “No status” until it reports.
Starting a terminal alone does not make it an agent. New agent cards do **not**
wait for the one-minute PR refresh.

If a terminal returns to a shell prompt, the sidebar checks its process tree on
that machine before removing a stale agent row. Live child processes keep the
row visible, even with shell job control disabled. Failed checks and paired
remote sessions retain their existing placement; a local shell is not proof
that a remote agent stopped.

## View options

The layers button beside the agent count opens **View options**:

- **List (default)** keeps the existing card order and directory metadata.
- **Group by repository** combines agents in clones and worktrees of the same
  logical repository. Headings use repository names, sorted alphabetically.
  Tree cards show the directory and branch on their second row; layouts without
  the tree show only the branch. The tooltip retains the actual
  working/worktree path. Detached checkouts are identified explicitly.

Grouped cards also show **C** (Checkout) or **W** (Worktree) before the branch, when
Git confirms the type. These are independent of the branch: a primary checkout
can use a feature branch, and a linked worktree can use `main`. Detection uses
Git's private/common metadata directories, not temporary-folder names. Hover
the indicator for the full meaning, branch and physical path. Unknown types have no indicator; List
view keeps its existing repository line.

The choice is saved in the owned `space-agents.view` shared setting. Both modes
show only the expanded space (the selected space in layouts without the tree).
Keyboard navigation follows the displayed order.
In the grouped view, click a directory/repository heading, or focus it and press
Enter/Space, to collapse or expand its cards. Headings keep their total agent
count. Groups start expanded and remember their state per Space in
`space-agents.groups`. Keyboard navigation skips collapsed cards; List view and
the narrow icon sidebar still show all agents.
Non-Git folders group by their actual path and execution host, not basename alone.
Unbound agents discover repository identity independently of PRs, so clones and
worktrees still group together when they have no open PR. Unpaired SSH/remote-server
panes do not authorize local filesystem probes from their reported paths.

## History

History is a separate bottom area with its own scrollable Space tree. Its expanded Space is the outer filter; there is no All workspaces option. Every visible session keeps its harness icon. Layouts without the tree retain the selected-Space Agents/History panel and compact session rows in the narrow sidebar.

- **Recent**: newest native update first. Tree History omits redundant date headings; legacy panels retain Today, Yesterday and Older.
- **By folder**: separate full directory/machine groups, including separate worktrees.
- **By harness**: Claude Code and OpenCode, newest first within each group.

The History view is remembered independently of the Agents view. The single search matches titles and paths across Spaces; legacy non-tree layouts retain their selected-Space search. Load more reveals another bounded page in its Space. Incomplete discovery is noted in the Space tooltip instead of a repeated banner; actual request errors and Retry remain visible.

History rows are a dense 28px single-line list: harness icon, title, compact age and a small trash control in the expanded sidebar. Folder/machine details and errors are in the tooltip. There are no Resume buttons or second metadata lines.

Tree History uses the same icon-center and text columns as its Space headers.
Agent rows have a small gap beneath the Space header, so the selected fills do
not run into each other.

Space hover covers the full row in both areas. Selection uses a soft tint of
the Space dot's color on the native sidebar surface; unselected hover stays
neutral. Light and dark surfaces use separate tint strengths.

The trash control asks for confirmation before permanently deleting the saved conversation from its original harness, server and machine. Cancel has initial keyboard focus. OpenCode also deletes child sessions; Claude deletes the session's subagent transcripts. Close any Herdr bindings first, including sessions opened only for viewing. An unavailable connection or failed deletion keeps the row with an error in its tooltip. Only confirmed native deletion removes the local catalog entry, metadata and Space association; it does not return after refresh. Deletion does not remove project files or undo code changes.

The section boundary distinguishes browsing from activated work:

| Condition | Section |
| --- | --- |
| Activated in Herdr, including later idle/done or no status | Agents |
| Opened from History for viewing, without a new message/work start | Session History |
| Saved with no open Herdr binding | Session History |
| Connection unavailable | Last confirmed section, with a warning |

Verified Space associations win over folder discovery. Conversations created outside Herdr match the exact directory and machine. A single conversation with several bindings has one row; closing one binding does not close the others. Session switches and last-binding exits move the identity between sections. External activity can remain unknown.

Click a History row, or focus the list and use Up/Down then Enter/Space. The helper rechecks the exact native ID, original folder and harness before preparing a launch. Already-open sessions are focused. Merely opening, viewing or scrolling keeps the session in History; sending a new message or starting work moves it to Agents. Startup metadata and historical replay do not count as interaction. Repeated clicks while opening do not create another tab. Failed lookup never creates an empty replacement conversation; the compact row retains a reason in its tooltip and can be clicked again to retry. Periodic refresh preserves the number of rows already loaded.

History metadata is private local state. Native titles can contain private content. No transcript bodies are copied and no sessions are automatically renamed, archived, deleted or forked. Uninstall preserves the catalog. See [Session History setup](../../docs/installation.md#session-history) for integration opt-in and explicit source mappings.

## GitHub PR discovery

- For unbound cards, runs `gh pr list --head <branch> --state open --limit 1 --json number,state,url,title,headRefName,headRepository,headRepositoryOwner`
  in the agent's working directory on its target machine. Without pane branch
  metadata, `gh pr view` with the same fields resolves the checkout's current
  branch. Only an **open**, GitHub-confirmed PR gets a verified badge.
- When that directory is not a GitHub checkout, reads the last 250 lines of
  that agent's terminal with `hc read`. Finds the most recent complete
  `https://github.com/<owner>/<repo>/pull/<number>` link and verifies it with
  `gh pr view <url>` with the same fields. No session rename is required.
  Terminal output is not executed or uploaded; only the PR URL is queried.
- A known checkout with no open PR, or a closed/merged discovered PR, does not
  fall back to older links or title numbers. Recent output can lack a PR link;
  this discovery is best-effort, not a direct session-to-repository integration.
- Results, including errors and missing PRs, are cached for one minute per
  machine/terminal/working-directory/branch. Repeated requests for the same
  agent share a pending lookup. Agents sharing a folder keep separate PRs.
- Bound sessions keep verified PR associations independently of their title.
  Renaming a session does not remove its link. Fork checkouts discover branch
  PRs in the upstream repository; known canonical URLs are reverified directly.
  A PR represents the current verified branch, not a claim that this session
  created it. Two agents using the same branch can therefore share its PR.
- GitHub failures retain a last-verified association only while repo and branch
  still match, with a tooltip indicating the unavailable refresh. Confirmed
  closure, a changed repo/branch or a detached checkout removes stale active
  associations and does not revive them from an old title number.
- Known PR numbers stay in a non-truncating badge while verification is pending
  or unavailable. Without a known PR, that area stays empty: no loading/error
  placeholders. Lookups are retried after cache expiry.
- Install GitHub CLI (`gh`) and authenticate it on the **target machine**, not
  just the computer showing Herdr. Use `gh auth status` there to check access.
- The working directory must be an actual Git checkout with a GitHub remote.
  A folder or session merely named after a repository is not enough. Non-repo
  folders use recent terminal output instead.
- While GitHub lookup is pending or unavailable, one explicit `#NNNN` in the session title can
  supply a fallback badge. Its tooltip and accessible label identify it as
  **not verified on GitHub**. Ambiguous references are ignored. Verified PRs
  take priority. A displayed badge replaces the repeated number in the card's
  short heading; the full canonical title remains in its tooltip.

## Native styling

`main.js` uses `theme()` colors and inherits the UI font. Tree cards are about
42 px high with a 3 px hover/selection radius, 4 px vertical padding, and 4 px list gaps. Resting rows blend into the sidebar without a visible border. Active and hovered rows use native fills; an outline is reserved for keyboard focus. Their
16 px title row and 14 px metadata row are separated by 2 px; text is 10.5–12.5 px.
Layouts without the tree retain 58 px cards, 8 px padding and 6 px list gaps.
The cloned layout
retains native pane frames with a 10 px radius and 8 px gaps. No separate theme,
global design files, or design system is needed.

## Checks

Run tests from the repository root, then the one-render mod check. Installed copies do not include the test suite:

```sh
npm test
herdr-app check mods/space-agents
```

These checks do not replace a live check of space switching, newly reported
agents, click-to-focus, or PR discovery on each target machine.
