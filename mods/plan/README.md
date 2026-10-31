# Session Plan review

Plan appears beside Files and Changes only for an independently verified session with registered planning documents. It does not infer ownership from a title, repository, PR or neighboring agent.

The panel shows one active document for the selected session: its explicitly primary plan, or the latest registered plan when no primary is set. It has no document-list picker. Other registered documents and their comments remain stored. An old remembered picker choice cannot override the current primary plan.

The **Plan** and **Tasks** tabs share one session-bound review. Plan gives the document the available height. **Comment** beside a heading opens the Review drawer with that section attached. **General comment** starts whole-document feedback. The drawer's count includes pending feedback, and closing it preserves the draft. Comments autosave privately; Saved means the helper acknowledged persistence. Comments never modify the source Markdown.

**Copy review** creates one combined message, not one message per comment. **Send review** previews the recipient, comments, and revision before a separate confirmation. It remains disabled until the exact runtime/provider/authority passes an owned no-generation probe. Claude is Copy-only. Feedback never approves implementation.

**Open Markdown** opens the actual registered file in a read-only native source pane beside the agent in the same session tab. The pane reads through the verified helper, does not create a temporary copy, and has no independent review composer. It cannot load an arbitrary path or borrow another session's plan. **Expand** widens the side panel; **Collapse** restores its previous width.

If saving fails, keep Herdr open. Use Retry saving or Copy draft. The tab bar's Unsaved review control recovers an outgoing draft after selecting another agent. Closing Herdr with an unacknowledged draft can lose that draft. Unknown delivery is never automatically resent; Check status is read-only. Retry review warns about duplicates and needs a new confirmation.

Image or HTML markers use a selectable native source reader. Other documents use native Markdown. Only HTTPS links can open. A changed symlink target requires explicit registration again.

If formatted text selection obscures the letters in the installed native renderer, use Source to select/copy from the read-only editor, then Formatted to return. This is a local workaround; it does not change the app theme or claim to fix the native rich-text painter.

The `herdr-workspace` layout references owned `session-tabs` and `plan` mods. Files/Changes preferences are preserved. The private installation journal restores only unchanged owned fields and retains the review database. The retained execution ledger documents the exact journal path and release. Do not edit app-owned storage or remove review state to recover the UI.

## Tasks

Tasks follows the Markdown structure rather than imposing phases:

```markdown
# Implementation plan
## Phase 1: Prepare
### Task 1: Database
- [x] Design the tables
- [ ] Add the indexes
## Phase 2: Ship
- [!] Deploy the service
```

Phase headings start with `Phase N`; task headings start with `Task N` (case-insensitive). Checklists can be nested. A task heading owns its checklist, and its phase shows the completed/total task count. Phase-free plans use a flat list. Tasks outside a phase stay Unassigned. Empty phases have No status, not Done.

Checklist markers are `[ ]` (Not started), `[-]` (In progress), `[!]` (Blocked), and `[x]` (Done). A task/phase can also have an explicit `Status: blocked` line or a trailing heading marker such as `[in_progress]`. Otherwise parent status is derived from children: Blocked first, then In progress for active or partially completed work, then Done only when all tasks are done. Code fences and HTML examples do not create tasks. **View section** opens a phase's corresponding plan section; **Show full plan** returns to the document.

### Agent observations

The adapters observe successful structured `TodoWrite`/`todowrite` snapshots when those tools exist. OpenCode V2 has no documented built-in task-list API, so this integration never guesses one. Markdown updates work independently of task-tool support.

For a status to update a plan task, the snapshot must name the registered plan path and exact document hash, then match an unambiguous exact title (or heading path and title). Unlinked observations are shown under **Unassigned agent tasks**. Earlier-revision observations show a recheck warning and do not overwrite current plan status. The UI shows the source and last observation time. Agent activity or prose never implies completion.

Integrators can use the private helper RPC, sending JSON on stdin:

```json
{
  "op": "update-tasks",
  "payload": {
    "session": "<existing session identity object>",
    "proof": "<existing live owner proof object>",
    "eventId": "task-update-1",
    "observedAt": 1000,
    "plan": { "path": "/workspace/plan.md", "documentHash": "<current SHA-256>" },
    "tasks": [{ "id": "database", "title": "Task 1: Database", "status": "in_progress" }]
  }
}
```

Replace the illustrative session/proof strings with the actual objects and use the observation's epoch-millisecond timestamp. `plan` is optional for unassigned snapshots. Supported statuses are `pending`, `in_progress`, `blocked`, `completed`, and `unknown`. Raw tool bodies are not stored. Old timestamps and replayed event IDs cannot replace newer snapshots.
