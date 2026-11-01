# Space-filtered Session History

## Intent and acceptance criteria

Help a person running several coding agents find and reopen saved conversations without mixing browsing with activated agent work. The selected Space scopes the entire sidebar before sorting, grouping, searching, or counting.

The user confirmed these requirements:

- Add Session History below Agents. Keep previously activated idle agents in Agents.
- Discover saved Claude Code and OpenCode V2 conversations, including conversations created outside Herdr.
- Filter both sections by the selected Space. Do not offer an All workspaces scope.
- Offer newest-first, directory grouping, and another useful view.
- Always show the harness icon, including in the narrow sidebar.
- A session belongs to exactly one section, never both or neither.
- Clicking a History row opens the normal harness session for browsing. It remains in History until a new message or actual work starts; viewing and scrolling do not activate it. An activated session remains in Agents when it later becomes idle or done.
- History uses 28-pixel single-line rows, with a harness icon, title and compact age. It has no Resume button, link or second metadata line. Its heading aligns with Agents.

For every resolved session identity included in the selected Space's snapshot:

```text
Agents intersection Session History = empty
Agents union Session History = all included sessions
```

This is a guarantee about discovered records, not a claim that an unavailable machine or an unsupported harness has been fully inventoried. Loading and discovery failures must be visible.

## Observed platform and code

- The installed Herdr App is 0.1.11. Its generated AGENTS.md and herdr.d.ts are the version-matched reference. The repository currently documents testing against 0.1.9.
- Herdr agents() exposes live agent activity: working, blocked, done, and idle. Done means a turn finished unseen; viewing it makes it idle. Neither means the conversation closed.
- Core terminal state is live or finished. A live shell can outlast an agent; a kept terminal can recover to a new shell without resuming the old agent.
- Closing or hiding the Herdr window does not stop agents. Settling a tab does not stop its agent either.
- mods/space-agents/model.js currently builds cards by terminal address. It has a useful program-detection fallback before the first status report, but program detection does not identify a saved conversation.
- The helper's current session-view.json is deliberately a projection of verified live bindings, not a history catalog. Its binding generation and terminal creation checks protect against stale terminal identity.
- The OpenCode adapter releases its binding on conversation changes and disposal. The Claude adapter invalidates a matching binding on SessionEnd and reopens records on SessionStart.
- Claude's pinned SDK already provides listSessions and getSessionInfo. OpenCode V2 provides paginated session listing and session lookup.
- OpenCode /api/session/active reports executing foreground drains. It is not an inventory of every idle client with a conversation open.
- The currently displayed personal layout is space-focus. The repository owns herdr-workspace; both reference space-agents.

Sources:

- https://herdr.dev/guide/
- https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md
- https://github.com/herdrdev/herdr-core/blob/master/schema/README.md
- https://opencode.ai/v2/docs/api
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/cli-reference

## Design choice

Render Agents and Session History within the existing space-agents mod. A pure shared model makes one partition, and one render draws both sections. Do not create two independently populated lists or two independent classifiers.

Extend the existing metadata helper with a read-only catalog of saved session summaries and their known Herdr associations. Keep this separate from the current verified-binding projection so that historical records cannot accidentally satisfy a live-binding proof.

Use harness APIs rather than a finished-terminal list or direct database/transcript parsing. A terminal-only implementation misses agents that exit into a surviving shell. A Herdr-observed-only implementation misses saved external conversations.

## Identity, associations, and Space filtering

Conversation identity is the existing tuple:

```text
execution host + authority/server/profile + harness + native session ID
```

Never deduplicate by title, cwd, branch, or terminal address. Preserve separate authority namespaces even when native IDs match. A conversation may have multiple open terminal bindings but has one session row; its row can expose the other locations.

Resolve inclusion in the selected Space before constructing rows:

1. A verified current Herdr binding supplies the authoritative Space association while the conversation is open. A session activated in a different Space must not also appear as history here merely because its folder matches.
2. When the last binding closes, preserve the last verified Space association. Do not make a historical record follow a shell's later cd command.
3. For a conversation never associated with Herdr, propose matching its host and normalized native session directory to the selected Space's folder. Match exact directories initially, not arbitrary string prefixes, repository names, or inferred worktree families.
4. If several Spaces use the same exact folder, the proposed external-history rule lets that saved record be discoverable under each matching Space. It remains one row in any selected-Space view. A verified Herdr association takes precedence over folder discovery.
5. Sessions without a matching Space association stay in the catalog but outside the selected Space's lists. Surface unmapped/discovery information without introducing a global history view.

Rules 3 and 4 are explicit proposals for review, not previously confirmed user requirements. They avoid guessing ownership from a shared repository name. A later directory-association feature can expand a Space's scope; it is not part of this feature.

## State model

Keep these independent facts:

- **Placement:** Agents or Session History.
- **Activity:** working, blocked, done, idle, or unavailable.
- **Connection quality:** confirmed, reconnecting, or unavailable.
- **Open action:** none, opening, or failed.
- **Saved-record availability:** available, checking, or unavailable.
- **Binding intent:** browsing or activated. A History click records an exact identity-and-Space browsing intent before launch. Verified binding registration consumes it; a new user prompt or work event activates that binding. Historical message replay, startup metadata, viewing and scrolling do not activate it.

Placement rules:

| Evidence | Placement | Display |
| --- | --- | --- |
| Exact conversation has at least one activated open Herdr binding | Agents | Current activity, even idle or done |
| Activated binding is open but has not reported activity | Agents | Activity unavailable |
| Exact conversation is open only for browsing | Session History | Open for viewing; no new work requested here |
| Saved conversation has no open Herdr binding after successful reconciliation | Session History | Saved, not open in Herdr |
| Previously confirmed open binding cannot currently be checked | Retain Agents | Connection unavailable; do not claim closure |
| Previously historical source cannot currently be checked | Retain Session History | Last known data; availability unavailable |
| Newly discovered external record has no known Herdr binding | Session History | External activity unknown unless a reliable source establishes it |

Unknown connection or activity is a badge, not a third section. Absence from one failed or incomplete response never proves closure. The ended field is an observation, not the sole source of truth, and ending one binding must not close another binding to the same conversation.

If an activated binding and browsing bindings coexist, the identity appears once in Agents. A late browsing snapshot cannot undo confirmed activation for the same binding generation. Newly launched agents outside the History-opening flow retain normal Agents placement.

A detected harness without a resolved native session ID can show a distinct **Identifying session** placeholder in Agents. It is not a second identified conversation. Do not suppress an arbitrary history entry by matching its title or directory. Report unavailable identity integration rather than claiming exact live/history reconciliation for that terminal.

### Transitions

- Working, blocked, done, and idle changes update an Agents row in place.
- Viewing a done agent changes its badge to idle, not its section.
- A confirmed agent exit releases that binding. The session moves to History only when no open binding remains.
- Returning to a shell or recovering a terminal as a shell is not agent resumption.
- Switching conversation A to B releases A's binding and claims B by its exact identity. A moves to History unless another binding still holds A.
- Opening a History row keeps it in History while launching and after its browsing binding is confirmed. A new Claude user-prompt/tool-work hook or new OpenCode user-inbox/work-start event promotes it to Agents in one classified snapshot.
- A failed resume leaves the original History row and shows an actionable error. Never create an empty replacement conversation when lookup fails.
- A connection loss preserves last confirmed placement. Reconnection reconciles an authoritative snapshot before applying inferred removals.
- A confirmed deletion removes the saved-record availability. If the conversation remains open, retain its Agents row with a warning. If it is neither saved nor open, it is no longer a member of the session inventory.

## Sidebar interaction

Preserve the current visual language and the fixed 44-pixel Spaces selector. Keep its divider non-draggable.

Below it, the existing mod draws two independently collapsible sections in one scrollable sidebar body:

1. **Agents:** current session cards and their activity indicators.
2. **Session History:** dense single-line rows, a count, search, and a view-options menu.

History views:

- **Recent** (default): last updated descending, with Today, Yesterday, and Older headings. Resolve ties deterministically by session identity. Metadata refresh or sidebar viewing must not bump the activity timestamp.
- **By folder:** group the already Space-filtered sessions by execution host and full normalized directory. Keep distinct worktrees distinct. Sort groups by most recently updated member, then path; sort members newest first.
- **By harness:** group by harness name, then newest first within each group.

Do not add By workspace: the selected Space already supplies that scope. Search title and path within the selected Space. Remember the History view and section collapse preferences; keep search and keyboard selection local to the current interaction.

Every session row has a non-shrinking leading harness icon. Use the saved harness identity to resolve Herdr's current program icon, respecting tint versus full-color images. Never substitute the surviving shell's icon for a known Claude or OpenCode conversation. An unavailable custom asset gets a visible generic agent fallback and a harness-name tooltip, not an empty slot.

Expanded History rows are 28 pixels high and show only the harness icon, title and compact age. The entire row is the Open action; Enter/Space uses the same action. Folder, machine, availability and errors stay in the tooltip and accessible description, not a second line or action label. Opening uses an inline spinner. The narrow sidebar keeps the harness icon and a descriptive tooltip. Loading, no matching sessions, no search matches, partial source failure, stale data, and failed opening remain distinguishable. Counts must not imply complete discovery while a source is incomplete. Periodic refresh preserves already-loaded pages for the current view/query.

Only live Agents contribute to setAgentOrder. History navigation must not change agent.next/agent.prev semantics.

## Discovery, publication, and resumption

The helper normalizes native metadata into a versioned history snapshot containing identities, titles, native last-updated timestamps, directories, harness keys, associations, pagination/completeness, and source errors. Do not include transcript bodies or raw prompts as separate metadata fields. A native display title may itself have originated from a prompt and must be treated as private local data.

- Claude: use the pinned SDK listSessions API with pagination. Discover all supported local saved root conversations; do not silently exclude programmatic conversations under an all-saved requirement.
- OpenCode: use the configured V2 server and its authentication/discovery context. Request root sessions and traverse pagination. Preserve archive metadata; archive is not a live/closed signal. Do not query or edit its database directly.
- Merge cached records without interpreting a partial page or source failure as deletion. Publish owned files atomically with existing private directory/file permissions.
- Bound rendered output through paging or virtualization. Keep the complete filtered count honest about whether catalog discovery is complete. Do not perform a full harness-history scan during render or for every row.
- Reuse the existing explicit producer and remote trust configuration. Do not set up SSH, pair remote agents, start an unconfigured server, restart services, or read arbitrary remote histories automatically.

Opening is user initiated. Recheck native session existence and current bindings before launching. Focus an existing binding, including a browsing binding, when available. Otherwise record the browsing intent and start the exact native ID in a new tab of the associated Space, on its execution machine, using the original valid directory and authority. Claude uses its exact-ID resume option; OpenCode uses its session option only after successful lookup because that option can create a new ID when missing. Preserve normal permissions and authentication; do not invent or replay bypass flags.

If the folder, harness, execution host, or authority is unavailable, keep the row and explain the blocker. Do not silently resume locally, create a new Space, change directory, or fork the conversation. Duplicate activation while Opening must not launch another terminal.

## Scope and delivery

Expected code areas, after approval:

- A small pure session registry/classifier and tests, consumed by space-agents.
- Helper catalog discovery, normalized metadata contracts, and snapshot publication, separate from the live-binding proof.
- OpenCode and Claude lifecycle reconciliation where needed to preserve exact identities and multiple bindings.
- space-agents rendering, view preferences, keyboard interaction, and harness icon resolution.
- Installer/bundle declarations and hashes only where the new files require them; focused architecture and usage documentation.

No changes to built-in Herdr mods, existing harness permissions, naming authority, Plan/Tasks features, or unrelated UI. Do not edit the personal space-focus layout or switch the user's active layout without explicit deployment authorization. The shipped layout keeps referencing space-agents, so no new sidebar block is required.

Implementation uses an isolated feature worktree. The controller owns commits and pushes; workers, if later selected, leave changes uncommitted. Keep the eventual task PR draft. Only the user merges.

## Verification

Automated acceptance must prove:

- Exhaustive and disjoint partitioning for all resolved identities after Space filtering.
- Activated bindings remain Agents through working, blocked, done, idle, and missing activity. Activity words alone do not activate a browsing binding.
- A History-opened browsing binding stays in History until genuine new interaction; startup replay and old server events cannot activate it. Repeated row clicks focus its existing terminal, and activation is monotonic within a binding generation.
- Exit into a surviving shell, shell recovery, A-to-B conversation switching, and same-session resume.
- Multiple bindings, delayed end events, stale generations, reused terminal addresses, and identical titles/IDs across different authorities.
- Successful empty reads versus partial pages, failed reads, disconnects, and reconnects; no disappearance on an error.
- External-directory matching, different hosts with identical paths, same-folder Spaces, and authoritative Herdr associations.
- Stable updated-time sorting, grouping, search, counts, and persisted view selection.
- Failed lookup never creates a conversation; missing directory/host/harness does not fall back elsewhere; repeated Resume launches once.
- Harness icons in all views and sidebar widths; keyboard and pointer activation target the same session.
- Existing agent navigation, Spaces height, and Files/Changes behaviour remain unchanged.

Run focused tests, npm test, the clean-install proof, privacy checks, and bundle validation after code changes. Run herdr-app check on changed native mods. Then inspect the rendered app and exercise mouse and keyboard interactions: native check does not lay out the UI or execute all deferred states. Live installation or layout switching requires the separate deployment authorization described above.

## Review decisions

The exact-directory fallback and same-folder Space behaviour were approved. During native execution, the user also approved left-aligned headings, single-line History rows with row-click opening, and promotion only on new interaction/work. This revision records those refinements and supersedes the earlier open-only placement boundary and Resume-button presentation.
