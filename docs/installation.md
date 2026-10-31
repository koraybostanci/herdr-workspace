# Installation

Supported: macOS, Herdr 0.1.9, Node 26 or newer (with `node:sqlite`). Other platforms and versions are unverified.

## Four separate steps

1. **Dependencies.** `npm ci` in the repository root installs the installer's one dependency. It runs no lifecycle scripts and changes nothing else.
2. **Install.** `node bin/herdr-workspace.mjs install` copies the layout, the four mods and a checked helper release into your Herdr app home. It runs `npm ci --ignore-scripts` inside the release folder to install the pinned Claude SDK and `jsonc-parser`.
3. **Harness setup (optional, opt-in).** Add `--configure-harnesses opencode,claude`. Without it, no harness file is read or written.
4. **Select the layout (manual).** The installer never switches your layout:
   `herdr-app do layout.switch '{"name":"herdr-workspace"}'`

## Commands

| Command | Writes? | What it does |
| --- | --- | --- |
| `plan` (default) | no | Checks the host and prints what `install` would do. |
| `install` | yes | Applies the plan. Safe to repeat. |
| `doctor` | no | Checks the host, the install record, the runtime descriptor and that the installed helper runs. |
| `uninstall` | yes | Removes unchanged owned files and settings entries. |

Options: `--app-home` (default `~/.config/herdr-app`), `--state-root` (default `~/.local/state/herdr-agent-metadata`), `--opencode-path`, `--claude-path`, `--adopt`.

## What changes

- Files under `<app-home>/mods`, `<app-home>/layouts` and `<app-home>/integrations/session-metadata/releases/<id>`.
- `<app-home>/data/session-plans/runtime.json`, the descriptor the mods use to find the helper.
- `<app-home>/data/herdr-workspace/install-journal.json`, the install record (mode 0600). Backups of replaced files and settings go beside it.
- With `--configure-harnesses`: one OpenCode plugin entry and six Claude hooks. Nothing else in those files changes, including comments, providers, models and credential helpers.

Preflight runs before any write. It fails on a missing built-in mod or asset, an old Node, or missing SQLite. A missing `git` or `gh` only turns off its feature. `gh` sign-in is not needed to install.

## Safety

- A file that already exists with different content is a collision and blocks the install. `--adopt` replaces it after saving a backup.
- Every change is written to the journal first. If an install stops part-way, run the same command again to resume. A different install is refused until the pending one finishes.
- Uninstall removes only what is still exactly as installed. Files and settings you changed are kept and listed. Reviews, drafts and metadata under the state root are always kept.
- The installer does not restart Herdr, agents or services.

## Upgrade and removal

Pull the new version, run `install` again. Owned settings entries are replaced, not duplicated. Run `uninstall` to remove.
