# Architecture

herdr-workspace is one installable bundle. Component boundaries stay inside it.

| Part | Where | Runs in | Role |
| --- | --- | --- | --- |
| Layout | `layouts/herdr-workspace.json` | Herdr | Places the owned header, Spaces tree and tabs, plus the built-in Files, Changes, chrome and status mods. |
| Mods | `mods/{space-agents,compact-spaces,workspace-header,session-tabs}` | Herdr (native, sandboxed JS) | Sidebar header, Spaces tree, agent cards, History and session tabs. The dropdown remains available for other layouts. |
| Helper | `integrations/session-metadata` | Node 26 | Collects session metadata, inventories saved conversations and serves the sidebar. |
| Adapters | `integrations/session-metadata/{opencode,claude}` | The harness | Observe sessions and feed the helper. |
| Installer | `bin/herdr-workspace.mjs`, `src/` | Node 26 | Plans, installs, checks and removes the bundle. |

Native mods cannot run Node or read each other's files. They call the installed helper through a runtime descriptor.
GitHub parsing, history grouping and session registry models have byte-identical helper/native copies, listed under `parity` in `bundle.json`.

## What the host provides

Herdr supplies the `herdr`, `gpui-kit` and `gpui-base` modules and the built-in mods the layout uses (`workspace-chrome`, `workspace-status`, `files`, `changes`, `pane`, `menu`, `new-menu`, `picker`).
OpenCode supplies its plugin and UI runtime. `bundle.json` declares each of these. Preflight checks them before any write and nothing is copied from the host.

## `bundle.json`

- `include` lists the source files and folders. `files` holds one SHA-256 per file. Run `node scripts/update-bundle.mjs` after editing a bundled file.
- `host` lists the required built-in mods and assets. `runtimeDependencies` and `harnessModules` list the allowed bare imports.
- `validateBundle` follows static imports, dynamic imports, asset paths in code and overlay mod names. It reports files that are missing, undeclared, changed, symlinked or outside the bundle.

## State

Card metadata uses a JSON store owned by the helper. The installer initialises its owner marker before starting the adapters. The metadata runtime descriptor is `<app-home>/data/space-agents/runtime.json` and points directly at the checked `herdr-session-meta.mjs` release.

Task scope follows successful project work rather than diagnostic working directories. Incidental edits under the local user's global `.agents` folder do not replace the project; sessions explicitly working there remain supported. Refresh rejects old scopes derived from those incidental edits and replays available project evidence to recover the task directory. Repository metadata stays separate from the session's original launch directory.

Session History adds `<state-root>/history/registry.json` and per-session `history-associations` records. Directories are private (`0700`), and files are `0600`. The live-binding projection remains separate; a historical record cannot satisfy an active binding proof. Native metadata inventory is cached for 60 seconds, while producer events and the 15-second fallback reconcile presence. OpenCode's typed not-found confirms absence; missing Claude summary metadata does not.

`history-opening` holds exact identity-and-Space browsing intents. Preparing a launch rechecks the catalog and publishes its intent under the history lock. Pending intents block deletion for 60 seconds; old intent files use their modification time for this bound. Verified binding registration consumes the intent; a new user prompt or genuine work-start event clears its browsing flag. OpenCode uses the native pre-open update timestamp to reject old replayed events. Browsing bindings remain in History, while an activated binding wins over browsing copies. Activation cannot be reversed by a stale snapshot of the same generation.

`session-registry` is a pure, byte-identical helper/native model. It partitions identities by host, authority, harness and native ID after Space filtering. `history-model` is also shared byte-for-byte for ordering and grouping. With the tree prop, `space-agents` supports multiple opened Agent Spaces and an independent bottom History tree. Both areas share one controller per Space and reconcile the same live observations, preserving exclusive session placement. One global History query dispatches bounded per-Space requests and groups matching results by Space; each controller owns its pages and request tokens. Agent keyboard focus and metadata fingerprints are also per-Space. Hidden responses remain in their own cache, hidden row actions are rejected, and confirmed deletion invalidates all controllers and per-session operation generations. Removed controllers release their retained controls and reject deferred work. Only displayed contexts refresh, including all search contexts during a global History search. Session actions select the owning Space before focus or resume. Without the tree prop, the existing selected-space panel remains. History pages contain at most 50 rows and are bounded to 512 KiB.

Discovery uses the pinned Claude SDK and the authenticated OpenCode V2 CLI/API. The helper checks that the default OpenCode service is running before requesting history. It does not start services or read OpenCode's database. Explicit trusted peers reuse the existing transport; unconfigured machines are not contacted.

Explicit deletion uses the helper's `delete-session` command with the full session identity, selected Space and confirmation flag. It reconciles presence and blocks open or unknown bindings before calling Claude's `deleteSession` or OpenCode's session DELETE API. Local deletion holds the session-mutation lock while it rechecks bindings and calls the harness. Claude requires a successful SDK deletion; metadata absence or an ambiguous SDK not-found error alone cannot confirm deletion. A configured remote peer must acknowledge the exact identity. Paired conversations in local Spaces route through their source's unique trusted peer; forwarded requests require the peer's explicit host and exact saved directory. Confirmed deletion clears catalog entries, session metadata, browsing intents and Space associations. A title-free deletion receipt replaces the association record so lost remote acknowledgements or interrupted catalog cleanup can be retried. Fresh native rediscovery invalidates an old receipt before publishing that conversation again. The controller invalidates pending history pages and removes the identity from cached Spaces after success.

The former Plan subsystem is removed. Upgrades retire unchanged owned Plan mod files and its runtime descriptor, but preserve edited files and private review data. Old helper releases remain on disk; configured harness entries must be upgraded explicitly. OpenCode reloads the new plugin configuration live and disposes the old observers.

## Behaviour that must not change

- Agents owns the upper sidebar area and supports multiple opened Spaces. History starts collapsed above Settings; a native vertical resizer remembers its open height. Its single query searches all Spaces without changing Agent expansion, and chevrons never switch workspaces.
- Files and Changes preferences are remembered per space.
- Naming only observes.
