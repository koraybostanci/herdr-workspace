<p align="left">
  <img src="assets/logo.svg" width="112" height="112" alt="herdr-workspace logo">
</p>

<h1 align="left">herdr-workspace</h1>

<p align="left">
  A focused Herdr workspace for people who run several coding agents at once:<br>
  a Spaces dropdown, live agent cards, saved Session History and session tabs.
</p>

---

## What you get

| Piece | What it does |
| --- | --- |
| **Header** (`workspace-header`) | Left-aligned branding in fullscreen, with native window-button spacing retained in normal macOS windows. |
| **Spaces** (`compact-spaces`) | A fixed 44-pixel dropdown that lists spaces grouped by machine. Its divider above Agents cannot be dragged. The popup opens downward. Keyboard highlight stays put, right-click opens actions, and you can reorder spaces on the same machine. |
| **Agents and Session History** (`space-agents`) | Open agents and saved conversations in the selected Space, with a harness icon on every row. History offers Recent, By folder and By harness views, search and exact-session resume. |
| **Session tabs** (`session-tabs`) | The tab strip, with the Files and Changes buttons. |
| **Helper** | A small Node program that collects session metadata and catalogs saved Claude Code and OpenCode V2 conversations. The harness adapters report live session identity and activity. |

Everything ships as one bundle with one installer. The installer checks your Herdr app first, writes nothing until you ask, and can undo what it did.

## Requirements

- macOS and **Herdr 0.1.9**. Other platforms and versions are untested.
- **Node 26 or newer**.
- Optional: `git` for branch context, `gh` with your own sign-in for verified pull request links, and OpenCode or Claude Code for the harness adapters.

The UI installs without GitHub credentials. A missing optional tool turns off only its own feature.
A different Herdr version, such as 0.1.11, produces an unverified-version warning, not an installation blocker.

## Fresh install

Install Herdr and Node first. The clone command needs Git and access to this repository. Run these commands one at a time; **stop if `plan` reports any `blocked:` lines**.

```sh
git clone git@github.com:koraybostanci/herdr-workspace.git
cd herdr-workspace
npm ci                              # installer dependency only; runs no scripts

node bin/herdr-workspace.mjs plan   # preview. Writes nothing.
node bin/herdr-workspace.mjs install
node bin/herdr-workspace.mjs doctor
```

The installer does not switch your layout or restart anything. Select the layout when you are ready:

```sh
herdr-app do layout.switch '{"name":"herdr-workspace"}'
```

### Four separate steps

1. `npm ci` installs the installer's own dependency. It changes nothing else.
2. `install` copies the layout, the four mods and a checked helper release into your Herdr app home. It then runs `npm ci --ignore-scripts` inside that release to install the pinned Claude SDK and `jsonc-parser`.
3. Harness setup is **opt-in**: add `--configure-harnesses opencode,claude`. Without it, no OpenCode or Claude file is read or written.
4. Selecting the layout is always manual.

### Enable harness integrations (optional)

To identify live sessions and track when a conversation opened from History starts new work, install or update the adapters explicitly:

```sh
node bin/herdr-workspace.mjs plan --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs install --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs doctor
```

List only the harnesses you use. Without this opt-in, saved history can still be discovered, but exact live-session reconciliation and browsing-to-Agents tracking need the matching adapters. See [Session History setup](docs/installation.md#session-history) for source profiles, additional OpenCode services and remote requirements.

## Upgrade an installer-managed installation

From your repository checkout:

```sh
git switch main
git pull --ff-only
npm ci
node bin/herdr-workspace.mjs plan --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs install --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs doctor
```

Use only the harnesses you configured, or omit `--configure-harnesses` if you did not configure any. Keep the original app, state and harness settings paths if you customized them. Use the same options for `plan` and `install`, and stop on blockers. Normal managed upgrades do not need `--adopt`.

## Migrate a manual or development installation

Existing files or integrations without an installer ownership record can report `foreign-file` or `harness-adoption-required`. Review those differences before opting in:

```sh
node bin/herdr-workspace.mjs plan --adopt --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs install --adopt --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs doctor
```

`--adopt` backs up conflicting files and records recognized existing metadata integrations before replacing them, rather than adding duplicate plugins or hooks. It still reads only the harnesses you select. Duplicate, customized or unsupported integration entries remain blocked; do not delete them or reset your settings to bypass that check. See [migration details](docs/installation.md#unmanaged-installations).

## Commands

| Command | Writes? | Purpose |
| --- | --- | --- |
| `plan` (default) | No | Run the host checks and show what `install` would do. |
| `install` | Yes | Apply the plan. Repeating it changes nothing. |
| `doctor` | No | Check the host, the install record, the runtime descriptor and that the installed helper starts. |
| `uninstall` | Yes | Remove files and settings entries that are still exactly as installed. |

Options: `--app-home`, `--state-root`, `--opencode-path`, `--claude-path`, `--configure-harnesses opencode,claude`, `--adopt`.
Defaults are `~/.config/herdr-app` and `~/.local/state/herdr-agent-metadata`.

See [docs/installation.md](docs/installation.md) for the full list of what changes.

## Safety

- **Preflight first.** A missing Herdr built-in mod or asset, or an old Node stops the install before any write.
- **No silent overwrites.** A file that already exists with different content blocks the install. `--adopt` replaces it only after saving a backup.
- **Journaled.** Every change is recorded before it is made. An interrupted install resumes when you run the same command again.
- **Minimal settings edits.** With harness opt-in, the installer adds or updates one OpenCode plugin entry and six Claude hooks. Comments, providers, models and credential helpers stay untouched.
- **Reversible.** Uninstall keeps files you edited, settings you added later and all private review data.
- **Private by default.** Install folders are mode `0700`. State, descriptors and journals are `0600`.

## Privacy

Naming only *observes* sessions. The bundle contains no credentials, session data or logs, and `npm run check:privacy` enforces that on every tracked file.

Session History reads native Claude Code and OpenCode V2 metadata, including saved conversations created outside Herdr. It keeps a private local catalog, not a copy of transcripts. A native session title can itself contain private prompt text. Uninstall preserves the catalog.

## Session placement

The selected Space filters both sections before view selection, search or counts. A resolved conversation appears once. Clicking a History row opens it for browsing without moving it to Agents. A new message or actual work activates it; it then stays in **Agents** even when idle or done, until closed. Working, blocked, done and idle remain activity badges, not placement rules. Disconnects retain the last confirmed placement.

Verified Space associations take priority. External conversations without one match the exact directory and machine; Spaces sharing a directory can discover the same history. Subdirectories and worktrees are not silently combined. History also holds sessions opened only for viewing; it does not claim that a conversation is stopped everywhere, and external activity can be unknown.

History uses dense single-line rows with a harness icon, title and age—no Resume button or second line. Clicking a row checks the exact saved ID, original folder, harness and execution context, then focuses an existing binding or opens a new tab for browsing. It never silently starts a replacement conversation or changes permissions. See [the sidebar guide](mods/space-agents/README.md#session-history) for states and limits.

In the expanded sidebar, each history row also has a trash control. Confirming it permanently deletes the conversation from its original OpenCode or Claude source, including child sessions or subagent transcripts. Close the session in Herdr first. Failed deletion keeps the row; confirmed deletion removes its local metadata and does not change project files.

## Plan feature removed

The Plan/Tasks panel, review system and Plan observers are no longer included. Existing plan Markdown files and saved review data are left untouched. To upgrade an installation that configured the harnesses, run `install --configure-harnesses opencode,claude`. OpenCode reloads its plugin configuration live; use `/reload` if an old plugin remains loaded. See [upgrade instructions](docs/installation.md#upgrade-and-removal).

## Known limits

- Native checks (`herdr-app check`) pass for all four mods. They do not test mouse, keyboard or pixels, so on-screen behaviour is not covered by automated tests here.
- Naming is observe-only until it can be verified for your exact installation.

More in [docs/limitations.md](docs/limitations.md).

## Develop

```sh
npm ci
(cd integrations/session-metadata && npm ci)   # helper dependencies for the source tests
npm test                  # Node tests
npm run test:clean-install  # install, read metadata and uninstall from a clean export
npm run check:privacy     # source allowlist and secret scan
```

Tests use `HERDR_WORKSPACE_TEST_TMPDIR` (default: a private folder under your OS temp directory) and never touch your real Herdr home or state.
After you edit a bundled file, run `node scripts/update-bundle.mjs` to refresh the hashes in `bundle.json`.

```text
bin/                    CLI entry point
src/                    bundle validation, preflight, install plan, journal
layouts/                the herdr-workspace layout
mods/                   space-agents, compact-spaces, workspace-header, session-tabs
integrations/           shared helper and the OpenCode and Claude adapters
docs/                   installation, architecture, limitations
tests/  scripts/        regression tests, privacy scan, clean-install proof
```

Architecture notes: [docs/architecture.md](docs/architecture.md). Third-party notices: [THIRD_PARTY.md](THIRD_PARTY.md).
