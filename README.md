<p align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="herdr-workspace logo">
</p>

<h1 align="center">herdr-workspace</h1>

<p align="center">
  A focused Herdr workspace for people who run several coding agents at once:<br>
  a Spaces dropdown, live agent cards, session tabs and a Plan review panel.
</p>

---

## What you get

| Piece | What it does |
| --- | --- |
| **Spaces** (`compact-spaces`) | A 44-pixel dropdown that lists spaces grouped by machine. The popup opens downward. Keyboard highlight stays put, right-click opens actions, and you can reorder spaces on the same machine. |
| **Agents** (`space-agents`) | Compact cards for the sessions in the selected space. A card shows the title, branch and pull request. Successful project work counts toward the card. Diagnostic Git reads and generated reports do not. |
| **Session tabs** (`session-tabs`) | The tab strip, with the Files, Changes and Plan buttons. |
| **Plan** (`plan`) | A Plan/Tasks workspace for the exact selected session. Open the Markdown beside the agent, comment on sections, and collect one review message. Tasks follow the plan's phases when present. |
| **Helper** | A small Node program that collects session metadata and stores drafts and reviews in a private SQLite database. OpenCode and Claude adapters feed it. |

Everything ships as one bundle with one installer. The installer checks your Herdr app first, writes nothing until you ask, and can undo what it did.

## Requirements

- macOS and **Herdr 0.1.9**. Other platforms and versions are untested.
- **Node 26 or newer** (it needs the built-in `node:sqlite`).
- Optional: `git` for branch context, `gh` with your own sign-in for verified pull request links, and OpenCode or Claude Code for the harness adapters.

The UI installs without GitHub credentials. A missing optional tool turns off only its own feature.

## Install

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

- **Preflight first.** A missing Herdr built-in mod or asset, an old Node, or missing SQLite stops the install before any write.
- **No silent overwrites.** A file that already exists with different content blocks the install. `--adopt` replaces it only after saving a backup.
- **Journaled.** Every change is recorded before it is made. An interrupted install resumes when you run the same command again.
- **Minimal settings edits.** With harness opt-in, the installer adds one OpenCode plugin entry and six Claude hooks. Comments, providers, models and credential helpers stay untouched.
- **Reversible.** Uninstall keeps files you edited, settings you added later and all private review data.
- **Private by default.** Install folders are mode `0700`. State, descriptors and journals are `0600`.

## Privacy

Drafts, comments and reviews stay on your machine in the state folder. Naming only *observes* sessions. Sending a review only *copies* it for you to paste. The bundle contains no credentials, session data or logs, and `npm run check:privacy` enforces that on every tracked file.

## Reviewing a plan

Open **Plan** beside Files and Changes. Use **Comment** beside a heading or **Review → General comment** to collect feedback. Comments autosave privately. The Review drawer keeps them out of the reading area until needed; **Copy review** combines them into one message. Verified delivery, when available, previews the recipient and comments before one explicit **Send review** confirmation. Feedback does not approve implementation.

**Open Markdown** opens the registered `.md` file in a read-only source pane beside the agent, in the same session tab. **Tasks** groups task headings and checklists under their phases; phase-free plans stay flat. Explicitly linked agent updates can supply status. Ambiguous, unlinked, or older-revision observations stay separate. See [the Plan guide](mods/plan/README.md) for task syntax and integration details.

## Known limits

- Selecting text in the formatted Plan view can paint grey in Herdr 0.1.9. This comes from the app's own text painter, not from this bundle. The **Source/Formatted** toggle is a workaround. The upstream fix is [longbridge/gpui-kit#3439](https://github.com/longbridge/gpui-kit/pull/3439).
- Native checks (`herdr-app check`) pass for all four mods. They do not test mouse, keyboard or pixels, so on-screen behaviour is not covered by automated tests here.
- Review delivery is copy-only and naming is observe-only until each can be verified for your exact installation.

More in [docs/limitations.md](docs/limitations.md).

## Develop

```sh
npm ci
(cd integrations/session-metadata && npm ci)   # helper dependencies for the source tests
npm test                  # Node tests
npm run test:clean-install  # install, read a plan and uninstall from a clean export
npm run check:privacy     # source allowlist and secret scan
```

Tests use `HERDR_WORKSPACE_TEST_TMPDIR` (default: a private folder under your OS temp directory) and never touch your real Herdr home or state.
After you edit a bundled file, run `node scripts/update-bundle.mjs` to refresh the hashes in `bundle.json`.

```text
bin/                    CLI entry point
src/                    bundle validation, preflight, install plan, journal
layouts/                the herdr-workspace layout
mods/                   space-agents, compact-spaces, session-tabs, plan
integrations/           shared helper and the OpenCode and Claude adapters
docs/                   installation, architecture, limitations
tests/  scripts/        regression tests, privacy scan, clean-install proof
```

Architecture notes: [docs/architecture.md](docs/architecture.md). Third-party notices: [THIRD_PARTY.md](THIRD_PARTY.md).
