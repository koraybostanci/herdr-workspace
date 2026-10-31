# Session plan workspace

## Intent and scope

People supervising coding agents need to read the selected session's plan, collect feedback without interrupting reading, send one review message, and inspect execution progress. Keep the existing native Herdr theme and exact-session ownership checks. Change only Plan, its task observations, and the related tests and documentation.

## Experience

- The Plan panel has **Plan** and **Tasks** tabs. Its header identifies the file and session and offers **Open Markdown** and expand/collapse.
- Plan gives the document the available height. Section comment actions open the review drawer with that section attached. A general comment applies to the whole document.
- A persistent **Review (N)** footer opens a collapsible drawer. Comments autosave privately, are editable and resolvable, and never modify the source file. The drawer can hold a general review note as a whole-document comment.
- Copy review creates one combined message. Send review previews the comments, recipient, and revision before explicit confirmation. Preserve verified-delivery gating, immutable submissions, receipts, duplicate warnings, conflicts, and draft recovery. Feedback never means approval to execute.
- Open Markdown opens a read-only native Markdown source pane beside the agent in the same session tab. It reads the registered file through the helper, not an arbitrary path or a copied temporary file. The review stays attached to its session. A file pane cannot borrow another session's plan.
- Tasks follows the Markdown structure. If phases exist, tasks appear under the relevant collapsible phase, with status and completed/total counts. Without phases, use a flat list. Tasks with no clear phase or plan association appear under Unassigned. A phase action opens its plan section for reading/commenting.

## Task evidence and contracts

- Parse phase headings (`Phase N`, case-insensitive), task headings (`Task N`), Markdown checklists, and explicit status markers. Ignore fenced code, HTML blocks, and examples excluded by the existing section index. Nested task checklists determine the parent task's aggregate status.
- Status values are `pending`, `in_progress`, `blocked`, `completed`, and `unknown`; present them as Not started, In progress, Blocked, Done, and No status. Do not claim an empty phase is complete. Blocked takes priority, then active/partially completed, then all completed, then pending.
- Accept explicit task snapshots from successful structured `TodoWrite`/`todowrite` tool observations or the helper's `update-tasks` RPC. Store only normalized task fields, event identity, time, and optional plan reference. Never save raw tool bodies.
- A snapshot is exact-session scoped. To overlay a plan task it must include this artifact's ID/path and reviewed document hash and match one unique task title or explicit heading path. Otherwise show the task as Unassigned, with its source. No fuzzy matching, chat interpretation, or invented OpenCode task API.
- Older events cannot replace newer snapshots. Replayed event IDs cannot become new updates. A snapshot for an older document hash never changes current Markdown task statuses. Show that it needs rechecking.
- Return the task outline and normalized observations with the helper's existing `read` response. Keep the artifact contract unchanged. Task update operations require the owning live proof and use the existing private request transport.

## States and constraints

Keep loading, unavailable-file, changed-target, superseded-read, expired-owner, unsafe-markup, autosave-failure, conflict, old-comment, and uncertain-delivery states. Preserve drafts when switching tabs or sessions. Show a clear empty Tasks state instead of fabricated progress. Keep HTTPS-only document links and read-only source fallback.

Herdr 0.1.9, macOS, Node >=26, no new dependencies. Existing Files/Changes preferences and one-primary-plan behavior remain unchanged. The installed host has no direct file-open command, so reuse the owned Plan mod in a source-only pane rather than modifying Herdr's built-in Files mod.

## Direction contract

**THESIS:** One session-bound workspace for reading, reviewing, and checking progress; the document is not squeezed above a permanently open form.

**OWN-WORLD:** Use Herdr's existing semantic colors, native controls, typography, rounded container, and focus treatment. Color communicates task and persistence state, never decoration.

**STORY:** Read the plan, attach comments to its sections, inspect the combined review, send once. Switch to Tasks to see the same plan's progress.

**FIRST VIEWPORT:** Compact identity/action header, two-tab strip, a large scrolling content region, and a small persistent review footer. The review editor appears only on request or draft recovery.

**FORM:** Native document workspace, based on the direction approved in conversation; seed: none (user-pinned structure).

**FINISH:** Verify behavior with parser/helper/adapter/native-mod tests and Herdr checks. Report visual and delivery verification limits honestly. Leave a draft PR for the user to merge.

## Acceptance checks

1. Phased, phase-free, nested, empty, malformed, duplicate-title, Unicode, CRLF, fenced-code, and HTML-containing plans have deterministic task outlines.
2. Only exact-session, exact-revision, unambiguous task evidence updates a plan task. Stale, replayed, foreign, and unlinked evidence is isolated.
3. Opening Markdown and switching Plan/Tasks preserve comments and session ownership. Source mode retains its editor.
4. Multiple comments produce one confirmed submission. Copying, resolving, autosaving, and changing tabs never send feedback.
5. Existing draft, conflict, revision, delivery, Files/Changes, installation, bundle-parity, and privacy tests still pass.
