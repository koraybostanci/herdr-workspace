# Limitations

## Platform and versions

Only macOS with Herdr 0.1.9 and Node 26 has been tested. Preflight warns on any other Herdr version or platform. Nothing here claims Windows or Linux support.

## Native interface

- `herdr-app check` passes for all four mods. It loads a mod once and reports errors. It does not click, type or compare pixels.
- Mouse, keyboard and visual behaviour (the dropdown, right-click, reorder, the Plan panel) were developed against the live app but are not covered by an automated test in this repository. Check them yourself after selecting the layout.
- **Formatted-text selection.** In Herdr 0.1.9 the vendored rich-text painter draws text before the selection highlight, so selected text can look grey. This is not fixed here. The Plan panel's Source/Formatted toggle avoids it. Upstream fix: https://github.com/longbridge/gpui-kit/pull/3439. Rebuilding or relaunching the app is outside this bundle.

## Behaviour that is deliberately limited

- **Naming is observe-only.** The helper records titles but does not rename sessions. No title-sync service is included or installed.
- **Review delivery is copy-only.** Sending a review to an agent needs a delivery check for your exact installation. None ships, so Plan copies the review for you to paste.
- No remote pairing, SSH setup, model configuration or service restart.
- Plan shows one document per selected session. The older multi-document picker was removed on purpose. Saved comments and other document associations are kept.

## Metadata

The remaining metadata audit items from the original development are not part of this package, and this package does not claim they are fixed. Cards only reflect what the adapters observe.

## Licensing

The four mods derive from default Herdr mods. `THIRD_PARTY.md` lists an open item: confirm the Herdr license terms for derived code before this repository leaves private use. The repository's own `LICENSE` grants no rights yet.
