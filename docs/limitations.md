# Limitations

## Platform and versions

Only macOS with Herdr 0.1.9 and Node 26 has been tested. Preflight warns on any other Herdr version or platform. Nothing here claims Windows or Linux support.

## Native interface

- `herdr-app check` passes for all three mods. It loads a mod once and reports errors. It does not click, type or compare pixels.
- Mouse, keyboard and visual behaviour (the dropdown, right-click and reorder) were developed against the live app but are not covered by an automated test in this repository. Check them yourself after selecting the layout.

## Behaviour that is deliberately limited

- **Naming is observe-only.** The helper records titles but does not rename sessions. No title-sync service is included or installed.
- No remote pairing, SSH setup, model configuration or service restart.
- The Plan/Tasks panel and review integration are removed. Saved reviews are retained, but this package no longer reads or edits them. OpenCode reloads plugin configuration live; use `/reload` if an old plugin remains loaded after upgrading.
- Automated native-mod tests exercise event handlers through a boundary fixture. `herdr-app check` verifies loading, not layout, pixels, or pointer behavior; those still need live inspection.
- Repository detection resolves SCP-style SSH aliases with `ssh -G` on the checkout's execution host and accepts them only when the configured hostname is `github.com`. GitHub authentication is unchanged: an inherited `GH_TOKEN` still takes precedence over the CLI's saved accounts, so an account that cannot access a private repository cannot supply its verified PR badge.

## Metadata

The remaining metadata audit items from the original development are not part of this package, and this package does not claim they are fixed. Cards only reflect what the adapters observe.

## Licensing

The three mods derive from default Herdr mods. `THIRD_PARTY.md` lists an open item: confirm the Herdr license terms for derived code before this repository leaves private use. The repository's own `LICENSE` grants no rights yet.
