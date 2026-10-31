# Architecture

herdr-workspace is one installable bundle. Component boundaries stay inside it.

| Part | Where | Runs in | Role |
| --- | --- | --- | --- |
| Layout | `layouts/herdr-workspace.json` | Herdr | Places the four owned mods and the built-in Files, Changes, chrome and status mods. |
| Mods | `mods/{space-agents,compact-spaces,session-tabs,plan}` | Herdr (native, sandboxed JS) | Spaces dropdown, agent cards, session tabs and the Plan panel. |
| Helper | `integrations/session-metadata` | Node 26 | Collects session metadata, stores Plan drafts and reviews (SQLite), serves the mods. |
| Adapters | `integrations/session-metadata/{opencode,claude}` | The harness | Observe sessions and feed the helper. |
| Installer | `bin/herdr-workspace.mjs`, `src/` | Node 26 | Plans, installs, checks and removes the bundle. |

Native mods cannot run Node or read each other's files. They call the installed helper through a runtime descriptor.
The protocol, client and model files that cross that boundary exist as byte-identical copies, listed under `parity` in `bundle.json`.

## What the host provides

Herdr supplies the `herdr`, `gpui-kit` and `gpui-base` modules and the built-in mods the layout uses (`workspace-chrome`, `workspace-status`, `files`, `changes`, `pane`, `menu`, `new-menu`).
OpenCode supplies its plugin and UI runtime. `bundle.json` declares each of these. Preflight checks them before any write and nothing is copied from the host.

## `bundle.json`

- `include` lists the source files and folders. `files` holds one SHA-256 per file. Run `node scripts/update-bundle.mjs` after editing a bundled file.
- `host` lists the required built-in mods and assets. `runtimeDependencies` and `harnessModules` list the allowed bare imports.
- `validateBundle` follows static imports, dynamic imports, asset paths in code and overlay mod names. It reports files that are missing, undeclared, changed, symlinked or outside the bundle.

## State

Card metadata uses a legacy JSON store owned by the helper. Plan uses a separate SQLite database below it.
The helper's store root must be initialised before Plan creates its files, or the store's owner guard refuses the folder. The installer does this in that order.
Reviews, drafts and comments are private state. Uninstall keeps them.

## Behaviour that must not change

- Spaces is 44 logical pixels. Its popup opens down from the `top_left` anchor.
- Plan shows one primary document for the selected session.
- Naming only observes. Review delivery only copies.
