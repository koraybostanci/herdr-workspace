# Space-filtered Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Only the controller commits and pushes; implementers leave scoped changes uncommitted.

**Goal:** Add Space-filtered Session History while assigning each resolved conversation to exactly one of Agents or History and always showing its harness icon.

**Architecture:** A pure registry model supplies one exhaustive, disjoint partition to the existing space-agents mod. The Node helper separately inventories native saved-session metadata, reconciles exact Herdr bindings, and serves bounded history pages. Activity, connection quality, and resume progress never independently determine placement.

**Tech Stack:** Node >=26, ESM JavaScript, node:test, Herdr GPUI mods, existing pinned Claude Agent SDK, OpenCode V2 CLI/API. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-session-history-design.md` (approved).

## Global Constraints

- The selected Space scopes the entire sidebar before sorting, grouping, searching, or counting.
- A session belongs to exactly one section, never both or neither.
- Use the boundary **open in Herdr** versus **saved but not open in Herdr**. External activity is separate from this placement.
- Always show the harness icon, including in the narrow sidebar.
- Do not offer an All workspaces scope. Do not add By workspace.
- Preserve the current visual language and the fixed 44-pixel Spaces selector. Keep its divider non-draggable.
- Never deduplicate by title, cwd, branch, or terminal address.
- Absence from one failed or incomplete response never proves closure.
- Do not include transcript bodies or raw prompts as separate metadata fields.
- Do not set up SSH, pair remote agents, start an unconfigured server, restart services, or read arbitrary remote histories automatically.
- Do not edit the personal space-focus layout or switch the user's active layout without explicit deployment authorization.
- Preserve Node >=26, the existing dependency pins, normal harness permissions, observe-only naming, and installer opt-in behaviour. Do not change the declared tested Herdr version without corresponding evidence.
- Use the existing native-created worktree and `feat/session-history` branch. Only the controller commits/pushes; keep the eventual PR draft and leave merging to the user.

## Review Focus

- Two conversations with identical titles/native IDs but different hosts or authorities remain distinct; test in Task 1.
- A disconnect, partial scan, or delayed old end-event never moves or drops a newer binding; test in Tasks 2 and 3.
- Same-folder Spaces and external conversations never bypass authoritative live associations; test in Tasks 1 and 4.
- A missing saved session, wrong authority, or double-click on Resume never creates an empty/duplicate conversation; test in Task 4.
- Large catalogs and rapid Space switches cannot exceed native file limits, leak another Space's results, or hide harness icons; test in Tasks 4 and 5.

## File and interface map

- `integrations/session-metadata/src/session-registry.mjs` and byte-identical `mods/space-agents/session-registry.js`: pure identity, validation, reconciliation, and Space partitioning. Add their pair to `bundle.json.parity`.
- `integrations/session-metadata/src/session-presence.mjs`: typed open/closed/unknown binding probes and association capture, not saved-session discovery.
- `integrations/session-metadata/src/history-catalog.mjs`: paginated harness metadata adapters and persisted registry refresh.
- `integrations/session-metadata/src/history-view.mjs`: Space-scoped sorting/search/paging and validated resume preparation.
- `integrations/session-metadata/src/history-model.mjs` and byte-identical `mods/space-agents/history-model.js`: history groups, preferences, timestamps, icon resolution, and response acceptance; no processes or persistence. Add this pair to `bundle.json.parity` too so server paging and native presentation use the same ordering.
- `mods/space-agents/history-ui.js`: native history controls/rows. `main.js` still owns both sections, one partition, async refresh, and selection.
- Existing `store.mjs`, `collector.mjs`, CLI, adapters, UI tests, bundle/install proof, and focused docs change only where these interfaces need integration.

### Registry contract (shared by every task)

Use JSDoc types in the pure registry file, with no Node or Herdr imports:

- `SessionIdentity = {host, authority, harness, id}`; supported harness values remain `claude` and `opencode-v2`.
- `SpaceRef = {host, coreSession, id}` and `SpaceContext = {...SpaceRef, folder, machine}`; app machine aliases must map explicitly to execution hosts, never by directory alone. `machine` is Herdr's machine alias or null; `folder` is its normalized exact directory.
- `SessionEntry = {session, title, directory, updatedAt, sourceId, saved, associations, bindings}`. `saved` is `available|checking|unavailable|missing`; `updatedAt` is the native content timestamp, never refresh time. `directory` can be null.
- `associations` contains `SpaceRef` values with an `associatedAt` timestamp. Retain the latest verified association after the last binding closes; native discovery never overwrites it.
- A binding retains the existing terminal identity, creation time, generation and process evidence, plus `{space: SpaceRef, tab, pane, address, focused, activity, connection, presence}`. `presence` is `open|unknown`; retain unknown bindings only when previously confirmed open. A closure is an input event, not a persisted open binding.
- `Registry = {schema: 1, owner: 'herdr-session-metadata', revision, updatedAt, sessions, sources}`. Sources record `{id, host, authority, harness, state, complete, errorCode}`; `state` is `ready|partial|unavailable`. Persist error codes, not credential-bearing stderr.
- `SessionRow` retains its full `SessionEntry` and adds `{key, placement, primaryBinding, activity, connection}`. `placement` is `agents|history`; choose a focused binding first, then the lexically smallest address. Aggregate activity with Herdr's `blocked > done > working > idle` priority.
- `Partition = {agents, history}`. Lists contain each included identity once. Unidentified harness-terminal placeholders stay separate from resolved session lists.

Use existing `atomicJson`, owned state directories, revision locking and generation checks. Keep the registry separate from naming records and `session-view.json`. Do not weaken the latter's live-binding proof.

---

### Task 1: Exact identity and exhaustive Space partition

**Files:** Create the two registry copies above and `tests/session-registry.test.mjs`; modify `bundle.json` for parity and generated hashes.

**Interfaces:** Produce `sessionIdentityKey(session): string`, `validateRegistry(value): Registry|null`, `partitionSpaceSessions({registry: Registry, space: SpaceContext|null}): Partition`, and `reconcileSessionRegistry(previous, {discoveries, presence, sources, now}): Registry`. Discovery inputs are arrays of `DiscoveryPage` values from Task 3. Presence inputs carry `{state: 'open'|'closed'|'unknown', binding, reason}` results with generation-qualified bindings. Missing source results do not erase prior data.

- [ ] **Write failing tests** using synthetic host/authority/path fixtures. For each `working`, `blocked`, `done`, `idle`, and null activity, assert a bound identity is in Agents and absent from History. For every fixture snapshot assert:

  ```js
  const ids = [...result.agents, ...result.history].map(row => row.key);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), new Set(expectedIncludedKeys));
  ```

  Add identical-title/different-authority cases; two bindings for one session; unknown connectivity retention; no Space selected; invalid schema/foreign owner; exact-folder matching without prefix matching; identical paths on different hosts; and same-folder Spaces with a verified association taking precedence. Normalize trailing separators lexically, preserve roots and case, and never access a filesystem from this module.
- [ ] **Run red:** `node --test tests/session-registry.test.mjs`. Expect missing-module/export failure before implementation.
- [ ] **Implement** the named interfaces. Space selection follows spec rules 1–5; an open session elsewhere cannot reappear as folder-matched history. Closed sessions retain their last verified association. Keep sessions with unknown native availability; remove only explicit confirmed-missing sessions without remaining bindings. Reject malformed entries rather than inventing identities.
- [ ] **Run green:** `node --test tests/session-registry.test.mjs`. Add parity to `bundle.json`, run `node scripts/update-bundle.mjs`, then `node --test tests/bundle.test.mjs`.
- [ ] **Controller checkpoint:** inspect scoped diff and tests; commit `feat: model exclusive session placement by Space`.

### Task 2: Lifecycle evidence and multiple-binding safety

**Files:** Create `src/session-presence.mjs` under the helper and `tests/session-presence.test.mjs`; modify helper `store.mjs`, `contracts.mjs`, `collector.mjs`, `claude/adapter.mjs`, `opencode/adapter.mjs`, `opencode/tui.js`, and corresponding existing lifecycle tests.

**Interfaces:** Consume Task 1 types. Produce `probeSessionBinding(binding, {run, env}): Promise<{state: 'open'|'closed'|'unknown', binding, reason}>` and `collectSessionPresence(runtime, peers): Promise<{presence, sources}>`. Add `store.releaseSessionBinding(binding): Promise<boolean>` for generation-qualified release serialized with session mutation; preserve other bindings. Carry optional process-start evidence on new bindings and resolve Space/tab/pane from matching terminal labels/app snapshots.

- [ ] **Write failing tests:** live idle agent is open; agent exits while shell remains; kept terminal recovers as shell; producer/terminal identity is replaced; missing status does not close; a typed core not-found result closes; timeout/auth/unreachable/malformed response returns unknown. Add concurrent two-binding SessionEnd and delayed old SessionEnd after A→B switch; assert the remaining/new binding and metadata are intact. Simulate reconnect with an authoritative empty snapshot separately from an unavailable snapshot.
- [ ] **Run red:** `node --test tests/session-presence.test.mjs tests/session-metadata-claude.test.mjs tests/session-metadata-opencode.test.mjs tests/session-metadata-core.test.mjs`.
- [ ] **Implement** explicit evidence distinctions instead of treating `bindingIsLive() === false` as closure. Reuse its identity checks for positive proof. Probe process existence/start identity where available; permission or transport failures stay unknown. Adapter releases must not set the whole conversation ended while another binding remains, and stale generations cannot release their replacements. Preserve naming guards and observe-only behaviour. Do not classify by activity or terminal title.
- [ ] **Run green** with the command above plus `node --test tests/session-metadata-view.test.mjs tests/session-metadata-transport.test.mjs`. Preserve the existing live metadata view behaviour; use the separate registry for offline placement retention.
- [ ] **Controller checkpoint:** regenerate hashes, inspect scoped diff; commit `feat: reconcile session presence across agent lifecycles`.

### Task 3: Native saved-session catalog

**Files:** Create helper `src/history-catalog.mjs` and `tests/session-history-catalog.test.mjs`; modify `src/store.mjs`, `bin/herdr-session-meta.mjs`, and `tests/helpers/session-metadata-fixtures.mjs` only for owned catalog storage/runtime injection.

**Interfaces:** Consume registry reconciliation and presence collection. Produce `discoverClaudeSessions({sdk, source, limit, offset}): Promise<DiscoveryPage>`, `discoverOpenCodeSessions({run, source, limit, cursor}): Promise<DiscoveryPage>`, and `refreshSessionCatalog(runtime, {force = false} = {}): Promise<Registry>`. `DiscoveryPage = {entries: SessionEntry[], next: string|number|null, complete: boolean, source}`; source has the registry source-health shape. Use owned `<stateRoot>/history/registry.json` plus owner-checked runtime methods `readHistory()` and `writeHistory(registry, expectedRevision)`.

- [ ] **Write failing tests:** all native pages are visited, roots only, native timestamps retained, archived OpenCode sessions are not mistaken for closed agents, Claude programmatic root sessions are not silently omitted, and no messages/transcripts are requested. Inject repeated/invalid cursors, malformed metadata, optional directory/title, missing harness, page failure after page one, and a successful empty inventory. Assert partial failure retains previous entries and associations, and confirmed removal requires successful exact lookup before deletion.
- [ ] **Run red:** `node --test tests/session-history-catalog.test.mjs`.
- [ ] **Implement** Claude discovery with the pinned SDK's `listSessions({limit, offset, includeProgrammatic: true})`. Use `customTitle` then native display summary then harness name; do not persist a separate firstPrompt. OpenCode uses the configured V2 authority and authenticated `opencode api get /api/session --param parentID=null --param limit=100` with native cursors, not direct database access. Verify the existing configured service is available before a CLI request that could auto-start it; report unavailable rather than start one. Preserve source host/authority and explicit profile environment. Trusted peers use paginated helper calls through existing `callPeer`; never auto-enrol a machine. Cache inventory for 60 seconds, coalesce refreshes across callers under the existing lock mechanism, and reconcile presence independently on producer events.
- [ ] **Run green:** `node --test tests/session-history-catalog.test.mjs tests/session-registry.test.mjs tests/session-presence.test.mjs`. Verify private state modes `0700` directories / `0600` files, owner rejection, and no native prompt/body fields in serialized records.
- [ ] **Controller checkpoint:** regenerate hashes, inspect scoped diff; commit `feat: discover saved Claude and OpenCode sessions`.

### Task 4: Bounded views and safe resume preparation

**Files:** Create helper `src/history-view.mjs`, the two history-model copies above, `tests/session-history-model.test.mjs`, and `tests/session-history-actions.test.mjs`; modify helper CLI and `bundle.json` parity. Modify the shared pure registry file only if the named contract needs an additive field.

**Interfaces:** Produce `historyGroups(rows, {mode, query, now}): Group[]`, `historyProgram(session, knownPrograms): Program`, and `acceptHistoryPage(response, request): boolean` in the mod model. `Group = {key, label, rows: SessionRow[]}`. Produce `createHistoryView(registry, request): HistoryPage` and `prepareSessionResume(runtime, {session, space: SpaceContext}): Promise<ResumeResult>` in the helper. Request shape is `{space: SpaceContext, view: 'recent'|'folder'|'harness', query, offset, limit: 50, requestId}`. `HistoryPage = {request, revision, agents, history, groups, total, hasMore, nextOffset, sources, complete}`; agents/history contain scoped SessionRows, history has at most 50 rows, total is the filtered history count, and completeness describes the source inventory rather than the visible page.

`ResumeResult` is `{kind: 'focus', terminal, pane}` or `{kind: 'launch', sessionKey, command: 'tab.new', args: {space, name, folder, argv}}`; blocked preparations return an error code with no launch descriptor. Add CLI `history-view --request <JSON> --json` and `prepare-resume --request <JSON> --json`. CLI output must contain no credentials. Resolve execution contexts from owned configuration, not user-supplied arbitrary command text.

- [ ] **Write failing tests:** newest-first ordering and deterministic ties; Today/Yesterday/Older boundaries using local calendar dates; folder identity includes host/full path; mode fallback is recent; harness grouping; scoped search/counts before paging; missing and non-tinted icons. Test 10,000 synthetic summaries, byte-size bounds, and out-of-order results for different Spaces/queries. Test native exact lookup failure, missing directory/binary/machine/authority, already-open binding, duplicate activation, and shell-special characters in titles/paths.
- [ ] **Run red:** `node --test tests/session-history-model.test.mjs tests/session-history-actions.test.mjs`.
- [ ] **Implement** page sizing with a 512 KiB serialized-response budget. Bound display titles to 512 Unicode code points while retaining the full native title in the private catalog; never truncate identity, paths used for execution, or counts. Return fewer than 50 history rows if necessary and advance by actual returned count. If required identity/binding data alone exceeds the budget, return `view-too-large`, not a falsely complete result. Folder groups order by latest member then path; members are newest-first. Resolve `opencode-v2` to program key `opencode`, and Claude to `claude`, respecting the program table's tint flag. Resume rechecks the catalog, exact session, directory and current bindings on the original host/authority. Return a focus action if already open; otherwise return an argument-array launch for Claude `--resume <id>` or OpenCode `--session <id>` only after successful lookup. No shell command interpolation, bypass flags, implicit local fallback, or new Space.
- [ ] **Run green** with the red command. Ensure `prepareSessionResume` never itself starts a model turn or edits transcripts. Test configured remote dispatch without reading real machines or credentials.
- [ ] **Controller checkpoint:** regenerate hashes, inspect scoped diff; commit `feat: prepare scoped history views and exact-session resume`.

### Task 5: One-render sidebar integration

**Files:** Create `mods/space-agents/history-ui.js` and `tests/session-history-view.test.mjs`; modify `mods/space-agents/main.js`, `session-metadata.js`, `model.js`, `tests/helpers/herdr-runtime.mjs`, `tests/space-agents-view.test.mjs`, and `tests/space-agents-grouping.test.mjs` only for this integration.

**Interfaces:** Consume Tasks 1–4. Produce `renderSessionHistory({rows, groups, sourceState, compact, theme, handles, actions}): Element` from history-ui. `main.js` owns one registry, request identity, current Space, pending resume map, history keyboard selection and one synchronous partition used by both sections. It must merge exact live binding updates before rendering a previously fetched history page so a newly open identity cannot appear twice.

- [ ] **Write failing boundary tests:** session transitions render once; idle/done stay Agents; agent exit into shell shows the same identity in History; multiple bindings dedupe with correct focus; stale peer remains Agents with connection warning. Cover source/empty/search/loading/error copy, fast Space switching, independent collapse, view persistence, load more, keyboard/click parity, and repeated Resume while Opening. Iterate views `recent|folder|harness` and sidebar widths `76|180|320|480`; assert a non-shrinking icon is present on every row and no history address enters `setAgentOrder`.
- [ ] **Run red:** `node --test tests/session-history-view.test.mjs tests/space-agents-view.test.mjs tests/space-agents-grouping.test.mjs tests/compact-spaces.test.mjs`.
- [ ] **Read** Impeccable's `reference/craft-floor.md` immediately before editing UI. **Implement** the existing native style with compact history rows, explicit Resume, `shared('space-agents.history.view')`, and `shared('space-agents.sections')` collapse state. Keep current Agents list/repository modes and PR presentation. Use existing checked-runtime descriptor validation for helper calls. Allocate focus/Input state in init, not render; extend the boundary fixture only for APIs the real installed type files support.
- [ ] **Wire refresh and transitions:** load catalog data through bounded async helper requests, retain last-good data on errors, and reject responses whose Space/request ID differs. Coalesce producer-triggered refresh and use the existing 15-second fallback, without a full history scan per render; Task 3's 60-second catalog cache bounds work. Replace layout-name-only refresh guards with detection that the current layout contains this mod so personal `space-focus` also works without editing that layout. Keep resume progress on the History row until exact binding confirmation; only one launch attempt per identity may be pending. Missing identity integration uses a visibly unidentified terminal placeholder, never title-based dedupe.
- [ ] **Run green** with the red command plus `node --test tests/session-metadata-view.test.mjs tests/session-tabs.test.mjs`. Regenerate hashes. Run `herdr-app check mods/space-agents` and one mechanical Impeccable detector pass over changed UI files. Native check cannot substitute for visual/interaction inspection.
- [ ] **Controller checkpoint:** inspect scoped diff and tests; commit `feat: add Space-filtered Session History to the sidebar`.

### Task 6: Packaging, clean-install proof, and user-facing evidence

**Files:** Modify `bundle.json`, `README.md`, `docs/architecture.md`, `docs/installation.md`, `docs/limitations.md`, `mods/space-agents/README.md`, `scripts/test-clean-install.mjs`, and existing bundle/install/privacy tests only as needed. Add `tests/session-history-install.test.mjs` for the new exported/runtime boundary.

**Interfaces:** The same installer still deploys three mods and the checked helper release. All new helper/mod files are declared and their shared registry copies are byte-identical. Uninstall preserves private catalog data, as it already preserves private metadata/review data.

- [ ] **Write failing proof tests:** clean export contains all new imports; installed `history-view` reads only fixture histories and returns a Space-scoped page; helper invocation uses the checked release; repeat installation is unchanged; harness configuration remains opt-in; uninstall preserves private registry state. Extend the hermetic OpenCode/Claude fixtures rather than using the person's service, HOME, or credentials.
- [ ] **Run red:** `node --test tests/session-history-install.test.mjs tests/bundle.test.mjs tests/install-plan.test.mjs tests/clean-install.test.mjs`.
- [ ] **Implement** only necessary declarations and fixture changes. Document the placement boundary, Space-directory rules, source completeness/unknown external activity, supported harnesses, resume errors, and deployment steps. Keep the personal layout untouched. Explain that icon/native checks do not prove mouse or pixels.
- [ ] **Run green/full verification:** `node scripts/update-bundle.mjs`, `npm test`, `npm run test:clean-install`, `npm run check:privacy`, and `herdr-app check mods/space-agents`. Set `HERDR_WORKSPACE_TEST_TMPDIR` to an owned folder beneath the approved OpenCode temp directory. Every command must exit 0. If any baseline or full-suite failure occurs, investigate before claiming completion.
- [ ] **Inspect a rendered native instance** with synthetic data in a private test app home if the host supports it. First check `herdr-app --help` for isolated-window options; do not assume them. Exercise both themes, wide/narrow sidebar, all views, Space changes, and keyboard/pointer Resume with stub harnesses. If isolated rendering is unavailable, ask for live deployment authorization and clearly report the pending visual checks rather than installing into the person's home silently. One batched defect scan, one fix batch, at most one confirmation pass.
- [ ] **Controller publication checkpoint:** review `git diff --stat` and staged diff; commit only task-owned changes. Run one fresh whole-branch code review using the selected execution workflow, address findings with focused tests, and re-run affected checks. Run `gh label list`, choose exactly one matching existing label (`major` for this behaviour change), verify any existing task PR is draft, push the feature branch, and create/update a draft PR. Use Summary prose and Changes bullets; omit Ticket when none was supplied. Never merge.

## Execution preparation and checkpoints

After the user approves this plan and selects an execution method:

1. Load the selected execution skill and test-driven-development. Existing worktree: use it, do not create another.
2. Run `npm ci --ignore-scripts` at the repository root and at `integrations/session-metadata`, using their lockfiles without changing dependency versions. Run `npm test` for the clean baseline. Stop and ask if the baseline fails.
3. Execute Tasks 1–6 in order. Run each red test before implementation and green tests after it. Only the controller creates commits.
4. Before completion/publication, load verification-before-completion and requesting-code-review. Keep deployment and visual limitations explicit.

## Plan self-review

- [x] Every spec section maps to a task: identity/Space partition (1), lifecycle/connectivity (2), native inventory/privacy (3), views/resume (4), native interaction/icons (5), packaging/evidence (6).
- [x] Later tasks use the interface names and data fields defined above; implementation signatures belong to their producing task.
- [x] All five Review Focus cases have named acceptance tests in their owning tasks.
- [x] No implementation code is prescribed beyond the partition assertion; bodies remain the implementer's work.
- [x] No product code, dependency setup, or live deployment starts before plan review and execution-method selection.
