# Space agents

A native Herdr sidebar for the currently selected space. The
`herdr-workspace` layout is cloned from `main` and places spaces above agent cards
on the left. It reuses shipped mods without requiring edits to shipped files.

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
with explicit “Needs you” and “No status” cues when relevant. Click a card to
focus its pane. With the list focused, use
Up/Down to choose a card and Enter/Space to focus it. A narrow sidebar shows
icons with tooltips instead of full cards.

Only the verified PR button opens its canonical URL in the browser; it also
focuses the associated pane. Title-only numbers are not links. Tab names are
neither a title source nor a synchronization target. See
`integrations/session-metadata/README.md` for observe-only setup, naming
ownership, remote pairing and gated migration/rollback.

The list updates automatically when the selected space changes or Herdr detects
an agent program running in a pane. A newly launched agent appears before its
first live status report (OSC 7501), with “No status” until it reports.
Starting a terminal alone does not make it an agent. New agent cards do **not**
wait for the one-minute PR refresh.

## View options

The layers button beside the agent count opens **View options**:

- **List (default)** keeps the existing card order and repository line.
- **Group by repository** combines agents in clones and worktrees of the same
  logical repository. Headings use repository names, sorted alphabetically.
  Cards show the branch on their second row; the tooltip retains the actual
  working/worktree path. Detached checkouts are identified explicitly.

Grouped cards also show **C** (Checkout) or **W** (Worktree) before the branch, when
Git confirms the type. These are independent of the branch: a primary checkout
can use a feature branch, and a linked worktree can use `main`. Detection uses
Git's private/common metadata directories, not temporary-folder names. Hover
the indicator for the full meaning, branch and physical path. Unknown types have no indicator; List
view keeps its existing repository line.

The choice is saved in the owned `space-agents.view` shared setting. Both modes
show only the selected space. Keyboard navigation follows the displayed order.
Non-Git folders group by their actual path and execution host, not basename alone.
Unbound agents discover repository identity independently of PRs, so clones and
worktrees still group together when they have no open PR. Unpaired SSH/remote-server
panes do not authorize local filesystem probes from their reported paths.

## Session History

Session History sits below Agents in the same scrollable sidebar. Each section folds independently. Both use the selected Space as their outer filter; there is no All workspaces option. Every visible session keeps its harness icon, even in the narrow sidebar.

- **Recent**: newest native update first, under Today, Yesterday and Older.
- **By folder**: separate full directory/machine groups, including separate worktrees.
- **By harness**: Claude Code and OpenCode, newest first within each group.

The History view is remembered independently of the Agents view. Search matches titles and paths inside the selected Space. Load more reveals another bounded page. Incomplete discovery shows a warning and a known-count indicator rather than claiming the list is complete.

History rows are a dense 28px single-line list: harness icon, title and compact age. Folder/machine details and errors are in the tooltip. There are no Resume buttons, action links or second metadata lines.

The section boundary distinguishes browsing from activated work:

| Condition | Section |
| --- | --- |
| Activated in Herdr, including later idle/done or no status | Agents |
| Opened from History for viewing, without a new message/work start | Session History |
| Saved with no open Herdr binding | Session History |
| Connection unavailable | Last confirmed section, with a warning |

Verified Space associations win over folder discovery. Conversations created outside Herdr match the exact directory and machine. A single conversation with several bindings has one row; closing one binding does not close the others. Session switches and last-binding exits move the identity between sections. External activity can remain unknown.

Click a History row, or focus the list and use Up/Down then Enter/Space. The helper rechecks the exact native ID, original folder and harness before preparing a launch. Already-open sessions are focused. Merely opening, viewing or scrolling keeps the session in History; sending a new message or starting work moves it to Agents. Startup metadata and historical replay do not count as interaction. Repeated clicks while opening do not create another tab. Failed lookup never creates an empty replacement conversation; the compact row retains a reason in its tooltip and can be clicked again to retry. Periodic refresh preserves the number of rows already loaded.

History metadata is private local state. Native titles can contain private content. No transcript bodies are copied and no sessions are automatically renamed, archived, deleted or forked. Uninstall preserves the catalog. See `docs/installation.md` for integration opt-in and explicit source mappings.

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

`main.js` uses `theme()` colors and inherits the UI font. Cards are about 58 px
high with a 7 px radius, 8 px padding, and 6 px list gaps; text is 10.5–13 px.
The two content rows are 18 px high, separated by 4 px. The cloned layout
retains native pane frames with a 10 px radius and 8 px gaps. No separate theme,
global design files, or design system is needed.

## Checks

Run the tests from Herdr's config folder, then its one-render mod check:

```sh
cd ~/.config/herdr-app
node --test
herdr-app check ~/.config/herdr-app/mods/space-agents
```

These checks do not replace a live check of space switching, newly reported
agents, click-to-focus, or PR discovery on each target machine.
