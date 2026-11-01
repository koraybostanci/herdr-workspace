# Architecture

herdr-workspace is one installable bundle. Component boundaries stay inside it.

| Part | Where | Runs in | Role |
| --- | --- | --- | --- |
| Layout | `layouts/herdr-workspace.json` | Herdr | Places the three owned mods and the built-in Files, Changes, chrome and status mods. |
| Mods | `mods/{space-agents,compact-spaces,session-tabs}` | Herdr (native, sandboxed JS) | Spaces dropdown, agent cards and session tabs. |
| Helper | `integrations/session-metadata` | Node 26 | Collects session metadata and serves the agent cards. |
| Adapters | `integrations/session-metadata/{opencode,claude}` | The harness | Observe sessions and feed the helper. |
| Installer | `bin/herdr-workspace.mjs`, `src/` | Node 26 | Plans, installs, checks and removes the bundle. |

Native mods cannot run Node or read each other's files. They call the installed helper through a runtime descriptor.
The GitHub parsing files shared between the helper and agent cards remain byte-identical, listed under `parity` in `bundle.json`.

## What the host provides

Herdr supplies the `herdr`, `gpui-kit` and `gpui-base` modules and the built-in mods the layout uses (`workspace-chrome`, `workspace-status`, `files`, `changes`, `pane`, `menu`, `new-menu`).
OpenCode supplies its plugin and UI runtime. `bundle.json` declares each of these. Preflight checks them before any write and nothing is copied from the host.

## `bundle.json`

- `include` lists the source files and folders. `files` holds one SHA-256 per file. Run `node scripts/update-bundle.mjs` after editing a bundled file.
- `host` lists the required built-in mods and assets. `runtimeDependencies` and `harnessModules` list the allowed bare imports.
- `validateBundle` follows static imports, dynamic imports, asset paths in code and overlay mod names. It reports files that are missing, undeclared, changed, symlinked or outside the bundle.

## State

Card metadata uses a JSON store owned by the helper. The installer initialises its owner marker before starting the adapters. The metadata runtime descriptor is `<app-home>/data/space-agents/runtime.json` and points directly at the checked `herdr-session-meta.mjs` release.

Session History adds `<state-root>/history/registry.json` and per-session `history-associations` records. Directories are private (`0700`), and files are `0600`. The live-binding projection remains separate; a historical record cannot satisfy an active binding proof. Native metadata inventory is cached for 60 seconds, while producer events and the 15-second fallback reconcile presence. Only a successful exact native lookup confirms deletion.

`history-opening` holds exact identity-and-Space browsing intents. Verified binding registration consumes the intent; a new user prompt or genuine work-start event clears its browsing flag. OpenCode uses the native pre-open update timestamp to reject old replayed events. Browsing bindings remain in History, while an activated binding wins over browsing copies. Activation cannot be reversed by a stale snapshot of the same generation.

`session-registry` is a pure, byte-identical helper/native model. It partitions identities by host, authority, harness and native ID after Space filtering. `history-model` is also shared byte-for-byte for ordering and grouping. The existing `space-agents` mod renders both sections from one partition; its internal controller owns asynchronous helper requests and rejects stale Space/query responses. History pages contain at most 50 rows and are bounded to 512 KiB.

Discovery uses the pinned Claude SDK and the authenticated OpenCode V2 CLI/API. The helper checks that the default OpenCode service is running before requesting history. It does not start services or read OpenCode's database. Explicit trusted peers reuse the existing transport; unconfigured machines are not contacted.

The former Plan subsystem is removed. Upgrades retire unchanged owned Plan mod files and its runtime descriptor, but preserve edited files and private review data. Old helper releases remain on disk; configured harness entries must be upgraded explicitly. OpenCode reloads the new plugin configuration live and disposes the old observers.

## Behaviour that must not change

- Spaces stays at 44 logical pixels with a non-draggable divider above Agents. Its popup opens down from the `top_left` anchor.
- Files and Changes preferences are remembered per space.
- Naming only observes.
