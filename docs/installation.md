# Installation

Tested baseline: macOS, Herdr 0.1.12, Node 26 or newer.
Older Herdr versions, an unreadable/missing host, unsupported platforms, missing required host files and an old Node version block installation. Newer hosts warn as unverified; the warning is not a compatibility guarantee.

Install and launch [Herdr desktop](https://github.com/herdrdev/herdr-app) once, then confirm `herdr-app --version` prints `herdr-app 0.1.12`. If the command is missing, fix the desktop CLI setup/PATH before installing this bundle. Install [Node.js](https://nodejs.org/) 26 or newer and check `node --version`. Installation downloads dependencies from the public npm registry. The Claude SDK has [separate terms](../THIRD_PARTY.md); verify that you can use it before installation.

This repository remains private. Use your own authorized GitHub account to [download and verify the beta](private-beta.md), or clone its exact release tag. Repository access and optional runtime PR badges are separate: downloading needs GitHub access; the installed UI does not need GitHub credentials.

Choose the path that matches your system: [fresh install](../README.md#fresh-install), [managed upgrade](#upgrade-and-removal), or [unmanaged migration](#unmanaged-installations). Run `plan` and `install` with the same options. Stop if the preview reports any `blocked:` lines.

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

Options: `--app-home` (default `~/.config/herdr-app`), `--state-root` (default `~/.local/state/herdr-agent-metadata`), `--opencode-path`, `--claude-path`, `--configure-harnesses opencode,claude`, `--adopt`.

## What changes

- Files under `<app-home>/mods`, `<app-home>/layouts` and `<app-home>/integrations/session-metadata/releases/<id>`.
- `<app-home>/data/space-agents/runtime.json`, the descriptor the agent cards use to find the metadata helper.
- `<app-home>/data/herdr-workspace/install-journal.json`, the install record (mode 0600). Backups of replaced files and settings go beside it.
- With `--configure-harnesses`: one OpenCode plugin entry and six Claude hooks are added or updated. Unrelated entries, comments, providers, models and credential helpers are preserved.

Preflight runs before any write. It fails on unsupported platforms, old/unavailable hosts, missing built-in mods/assets or old Node. A missing `git` or `gh` only turns off its feature. `gh` sign-in is not needed to install files you already downloaded.

## Safety

- A file that already exists with different content is a collision and blocks the install. `--adopt` replaces it after saving a backup.
- Every change is written to the journal first. If an install stops part-way, run the same command again to resume. A different install is refused until the pending one finishes.
- Uninstall removes only what is still exactly as installed. Files and settings you changed are kept and listed. Reviews, drafts and metadata under the state root are always kept.
- The installer does not restart Herdr, agents or services.

## Session History

The existing `space-agents` mod supplies both sections; History needs no separate mod or layout block. Install the updated checked release normally. To associate active conversations with saved IDs, update the existing harness integrations using the same explicit `--configure-harnesses opencode,claude` opt-in. A recognized process without session identity remains an unidentified agent entry; its title is never used to hide a saved conversation.

History defaults to the helper's current Claude profile and running local OpenCode V2 service. It reads saved metadata only when the mod requests it. No account, permission or service settings change. Custom layouts that already use `space-agents` do not need structural edits; selecting or deploying a personal layout is still manual.

Extra OpenCode authorities require an explicit `<state-root>/history-sources.json` mapping. The file replaces the default source list, so include default sources you want to keep:

```json
{
  "schema": 1,
  "owner": "herdr-session-metadata",
  "sources": [
    { "host": "local", "authority": "claude", "harness": "claude" },
    { "host": "local", "authority": "local", "harness": "opencode-v2" },
    { "host": "local", "authority": "other-service", "harness": "opencode-v2", "server": "http://127.0.0.1:4096" }
  ]
}
```

Use a distinct authority for a distinct service. Authentication stays with OpenCode; credentials must not appear in this file or a URL. Remote history requires an already configured trusted metadata peer and compatible helper; this feature does not configure SSH or pairing. An unavailable original context blocks Resume instead of falling back locally. Private history and association records remain after uninstall.

## Upgrade and removal

For a managed installation, download and verify the next private prerelease in a new folder, then run its installer against the same app/state paths. Alternatively fetch its exact published tag in your checkout. Preview the upgrade before applying it:

```sh
npm ci --ignore-scripts
node bin/herdr-workspace.mjs plan --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs install --configure-harnesses opencode,claude
node bin/herdr-workspace.mjs doctor
```

Select only the harnesses you use, and keep any original `--app-home`, `--state-root`, `--opencode-path` and `--claude-path` overrides. Omit the harness flag if you did not configure integrations. Run `install` only when `plan` has no blockers. Owned settings entries are replaced, not duplicated; a normal managed upgrade does not need `--adopt`. Run `uninstall` to remove the installed bundle.

Before removal, select another installed layout in Herdr. From the retained release folder run `node bin/herdr-workspace.mjs uninstall`, with the same path overrides. Removal does not need a working Herdr executable. It keeps changed files, unrelated settings and private history/state. Keep the journal/backups if you may need to inspect an adopted installation. Downgrades are not separately certified; preview an older release and stop on any blocker rather than deleting files or state.

When upgrading from the removed Plan feature, include `--configure-harnesses opencode,claude` for the harnesses you previously configured, using their original settings paths. Without that opt-in, an old Plan-enabled harness entry blocks the upgrade rather than leaving the integration active. Edited entries that would retain a Plan observer also block the upgrade; they are never silently overwritten. Only the requested harness files are read or changed. OpenCode reloads plugin configuration live; if an old plugin remains loaded, use `/reload`. No service restart is required. Claude's updated hooks apply to subsequent hook events.

Unchanged owned Plan mod files, the tabs' Plan-only modules and the old `data/session-plans/runtime.json` descriptor are retired. Modified files are kept with a warning; adopted files restore their original backup. Existing Markdown plans, private SQLite review data and old helper release folders are not deleted. The new release contains no Plan code.

## Unmanaged installations

Files copied manually or deployed by an earlier development workflow may have no `data/herdr-workspace/install-journal.json`. The installer cannot assume it owns those files or their harness settings. A changed managed file can also be reported as `foreign-file`; review it rather than blindly replacing it.

1. Review each conflicting file and any existing metadata integrations. Do not delete your settings or private state.
2. Preview explicit adoption, selecting only the harnesses you use:

   ```sh
   node bin/herdr-workspace.mjs plan --adopt --configure-harnesses opencode,claude
   ```

3. If the preview has no blockers and the proposed replacements are intended, apply the same options:

   ```sh
   node bin/herdr-workspace.mjs install --adopt --configure-harnesses opencode,claude
   node bin/herdr-workspace.mjs doctor
   ```

`config adopt` means the installer will record the original integration, back up its settings file and manage that entry for future upgrades. This also records an unmanaged entry that already matches the current version. Conflicting files are backed up before replacement. The journal and private backups are under `<app-home>/data/herdr-workspace/`; uninstall can restore unchanged adopted settings from those backups.

Recognition is deliberately narrow: an OpenCode plugin must reference a versioned metadata release under the selected app home, with the matching app/state paths and only published options. A Claude metadata group must contain just the published Node hook, with its expected arguments and defaults. Duplicate entries, mixed hook groups, customized options or other unsupported shapes report `ambiguous-harness-entry` even with `--adopt`; inspect and reconcile them manually rather than accepting an overwrite or an extra observer.

File adoption alone never opts you into harness setup. Without `--configure-harnesses`, no harness settings file is read or changed. Custom layouts, unrelated hooks/settings, sessions and private review/history data are retained. Adoption does not switch layouts, restart services or remove old helper releases.
