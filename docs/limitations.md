# Limitations

## Platform and versions

Only macOS with Herdr 0.1.9 and Node 26 has been tested. Preflight warns on any other Herdr version or platform. Nothing here claims Windows or Linux support.

## Native interface

- `herdr-app check` passes for all four mods. It loads a mod once and reports errors. It does not click, type or compare pixels.
- Mouse, keyboard and visual behaviour (the dropdown, right-click and reorder) were developed against the live app but are not covered by an automated test in this repository. Check them yourself after selecting the layout.

## Behaviour that is deliberately limited

- **Naming is observe-only.** The helper records titles but does not rename sessions. No title-sync service is included or installed.
- No remote pairing, SSH setup, model configuration or service restart.
- The Plan/Tasks panel and review integration are removed. Saved reviews are retained, but this package no longer reads or edits them. OpenCode reloads plugin configuration live; use `/reload` if an old plugin remains loaded after upgrading.
- Automated native-mod tests exercise event handlers through a boundary fixture. `herdr-app check` verifies loading, not layout, pixels, or pointer behavior; those still need live inspection.
- Repository detection resolves SCP-style SSH aliases with `ssh -G` on the checkout's execution host and accepts them only when the configured hostname is `github.com`. GitHub authentication is unchanged: an inherited `GH_TOKEN` still takes precedence over the CLI's saved accounts, so an account that cannot access a private repository cannot supply its verified PR badge.

## Metadata

The remaining metadata audit items from the original development are not part of this package, and this package does not claim they are fixed. Cards only reflect what the adapters observe.

- Saved history supports root conversations from Claude Code and OpenCode V2. Other live harnesses retain their agent cards but do not gain native history adapters here.
- Exact live/history reconciliation needs a verified native session identity. Without the opt-in harness integration, program recognition alone cannot prove which saved conversation is open. The agent entry exposes that limitation rather than guessing from a title or folder.
- History includes saved sessions and sessions opened only for browsing. A new message or work start promotes a browsing session; viewing and scrolling do not. Activity outside Herdr may still be unknown.
- Native inventory can lag by up to its 60-second cache. Space associations captured at bind time keep short-lived sessions discoverable while availability is checked. Missing native timestamps are shown as unavailable, not fabricated.
- External history matches exact host/directory identities. A renamed/deleted Space or moved folder may leave sessions unmapped. There is no global history view, recursive-folder matching or inferred worktree family.
- Claude discovery uses the helper's configuration profile. Alternate Claude profiles are not automatically enumerated. OpenCode services must be explicitly mapped to their authority when they are not the default local service.
- Missing Claude summary metadata does not prove that a transcript is gone. Such cached rows are retained. Explicit deletion calls the native SDK even without summary metadata; an SDK not-found error without a previous deletion receipt remains unverified, because empty transcripts can produce the same error.
- Browsing/activation tracking requires the matching updated harness integrations. Older integrations cannot report the new interaction contract; update them with the existing explicit setup opt-in.
- Remote Resume requires the matching configured remote Space and helper. A remotely executing conversation in a local SSH pane is not silently relaunched in a local shell.
- `herdr-app check` validates initial loading, not all populated rows or mouse behaviour. Rendered and interaction checks require a native window; no automatic live installation is part of this change.

## Licensing

The four mods derive from default Herdr mods. `THIRD_PARTY.md` lists an open item: confirm the Herdr license terms for derived code before this repository leaves private use. The repository's own `LICENSE` grants no rights yet.
