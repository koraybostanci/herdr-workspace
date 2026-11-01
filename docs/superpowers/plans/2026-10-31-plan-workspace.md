# Session Plan Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session Plan panel a readable, phase-aware review workspace with one-message feedback.

**Architecture:** Extend the helper's read response with an indexed task outline and private normalized task observations. Reuse the owned Plan mod in a source-only pane for Open Markdown. Keep the existing draft and submission pipeline and move its controls into an on-demand review drawer.

**Tech Stack:** Native Herdr JavaScript mods, Node 26, SQLite, node:test; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-plan-workspace-design.md`

## Global Constraints

- Herdr 0.1.9, macOS, Node >=26, no new dependencies.
- Exact session and live proof for task updates; exact document revision for task overlays.
- Comments never modify Markdown. Feedback never means approval to execute.
- Keep verified-delivery gating and all existing draft and delivery recovery behavior.
- Preserve one-primary-plan behavior, Files/Changes preferences, private request transport, and byte-identical shared modules.
- Work in this checkout on `feat/plan-review-workspace`. Only the controller commits and pushes. Create a draft PR; never merge.

## Review Focus

- Duplicate headings/task titles must not silently acquire another task's status.
- A delayed task event or A-B-A session switch must not replace newer state.
- Code examples, HTML blocks, and nested checklists must not create false phases or completed tasks.
- Opening a mod pane must retain review ownership without borrowing another session's plan.
- Drawer/tab changes during autosave or sending must retain draft text and frozen submission identity.

---

### Task 1: Plan structure and normalized task observations

**Files:** Create `integrations/session-metadata/src/plans/tasks.mjs`; modify `src/plans/{runtime,bridge}.mjs` and `opencode/plans.mjs`, `claude/plans.mjs` beneath the helper; create `tests/plan-tasks.test.mjs`; extend `tests/plan-artifacts.test.mjs` and `tests/plan-bindings.test.mjs`.

**Interfaces:**
- Consumes: `indexSections(text, documentHash)`, `assertPlanOwner(session, deps)`, registered artifact identities, proof lifecycle, SQLite transactions.
- Produces: `indexPlanTasks(text, sections)` returning `{phases,tasks}`; `recordTaskSnapshot(input, deps)` accepting `{session,proof,eventId,observedAt,tasks,plan?}` and rejecting stale/replayed snapshots; `readPlanTasks(artifact, text, sections, deps)` returning `{phases,tasks,unassigned,observedAt,stale}`; `extractTaskSnapshot(event)` returning normalized task evidence or null.
- Each task has `id,title,status,source,headingPath,children`; each phase has `id,title,headingPath,tasks,status,completed,total`. Optional plan reference is `{path,documentHash}`. Snapshots match exact heading path or unique exact title only.

- [x] Write tests for phased and flat plans, nested/task-heading checklists, code/HTML exclusion, duplicate headings, Unicode/CRLF, and empty-phase status.
- [x] Run `node --test tests/plan-tasks.test.mjs`; confirm missing exports fail.
- [x] Implement parser, status aggregation, normalized observation storage, and exact-revision merging in `tasks.mjs`.
- [x] Add `update-tasks` to bridge/runtime. Add `tasks` to ready read responses without changing artifact fields. Observe successful TodoWrite/todowrite calls in both adapters; preserve root/route checks and event idempotency.
- [x] Add tests for foreign proofs, stale/replayed events, changed revisions, invalid snapshots, unassigned evidence, and adapter route changes. Run `node --test tests/plan-tasks.test.mjs tests/plan-artifacts.test.mjs tests/plan-bindings.test.mjs`.

### Task 2: Native plan workspace and file pane

**Files:** Modify `mods/plan/main.js`; create focused `mods/plan/task-view.js` and `mods/plan/file-view.js` as needed; extend `tests/plan-view.test.mjs` and `tests/helpers/herdr-runtime.mjs` only for used native APIs.

**Interfaces:**
- Consumes: Task 1's read response and the existing `PlanClient`, `ReviewDrafts`, `selectPlanOwner`, section anchors, preview/submit/dispatch pipeline.
- Produces: Plan/Tasks tabs, collapsible phase/task lists, section comment actions, on-demand review drawer, review count, native source-only file pane via `pane.split` with `{mod:'plan',props:{file:{session,artifactId,terminal}}}`.
- File panes resolve the registered artifact through verified ownership in the same tab. They create no review drafts or delivery operations and expose no arbitrary-path read.

- [x] Add failing native tests for initial closed drawer, comment actions, retained drafts across tabs, phase grouping/flat tasks, empty state, stale/unassigned evidence, and file opening/ownership.
- [x] Run `node --test tests/plan-view.test.mjs`; confirm the new assertions fail for missing controls/behavior.
- [x] Build the compact header and tabs, readable content, persistent review footer, focused drawer, and task rendering. Keep existing recovery/conflict/receipt controls and explicit confirmation.
- [x] Build Open Markdown using a same-tab source-only Plan pane; add expand/collapse using supported layout commands. Preserve stale-control tokens and native resource lifetimes.
- [x] Extend multi-comment send coverage, source retention, stale controls, and A-B-A/file-pane tests. Run `node --test tests/plan-view.test.mjs tests/plan-delivery.test.mjs tests/plan-reviews.test.mjs`.

### Task 3: Shipping verification and draft PR

**Files:** Update `README.md`, `mods/plan/README.md`, `docs/{architecture,limitations}.md`, `bundle.json`, and the plan checkboxes.

**Interfaces:** Consumes the finished helper/mod behavior. Produces installation-consistent hashes, documented evidence limits, and a draft PR.

- [x] Document Tasks syntax/evidence, file-view behavior, review workflow, and unsupported delivery states. Refresh hashes with `node scripts/update-bundle.mjs`.
- [x] Run `npm test`, `npm run test:clean-install`, and `npm run check:privacy`. All must exit 0.
- [x] Run `herdr-app check` for owned affected mods. After verification, install into local Herdr as authorized at plan review, without switching layouts or restarting sessions. Inspect target rendering if a safe native preview is available; otherwise state that native checks do not verify pixels or interactions.
- [x] Review the scoped diff for regressions and run final verification after fixes. Inspect `git diff --stat` and staged diff; stage only task-owned changes and commit without attribution trailers.
- [x] Check `gh label list`, push the feature branch, and create a draft PR with the required Summary/Changes format and one matching label when available. Leave merging to the user.

## Verification record

- Final regression suite: 357 tests passed after independent code review and four regression fixes (active draft selection, indented code examples, HTML examples, and heartbeat-safe confirmation).
- Clean export/install/uninstall and privacy checks passed. Native Plan and session-tabs load checks passed.
- Scoped local deployment preserves the existing custom layout and unrelated mods, retains legacy helper setup, and backs up changed files. Direct delivery remains gated; no feedback was sent during verification.
- Live pointer/keyboard and visual-state verification remains incomplete: macOS Accessibility/Screen Recording permissions were unavailable. Automated boundary tests do not replace those checks.
- Draft PR: https://github.com/koraybostanci/herdr-workspace/pull/2. No label was applied because none of the repository's labels match the configured PR-label table.

## Follow-up corrections and verification

- Resolve configured GitHub SSH aliases on the checkout's execution host, accepting only the canonical `github.com` hostname. Authentication is intentionally unchanged; an inaccessible private repository still cannot supply a verified PR badge.
- Use a session-scoped task revision instead of the global publication sequence to avoid unrelated heartbeat reads. Load the document and saved review in one request, and retain recent plans in a generation/revision-isolated memory cache while revalidating.
- Independent review found and regression tests fixed stale retained Source text and a task-refresh retry gap.
- A live native sample found rendering stalled in QuickJS JIT maintenance. Replace per-field iteration closures with equivalent loops; repeated proof/artifact validation no longer allocates a fresh set of callbacks on each pass. No ownership, field, or revision checks were removed.
- Follow-up suite: 369 tests passed; clean-install, privacy, and native-load checks passed. The user reproduced the original delay and confirmed the installed workaround made Plan opening and Plan/Tasks switching **much faster**. Other unexercised GUI paths remain subject to the original verification limits.
