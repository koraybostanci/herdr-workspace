# Licensing and third-party provenance

## Owner material and distribution scope

The owner selected **Apache-2.0** for owner-authored material and modifications.
The full standard text is in [`LICENSE`](LICENSE); owner attribution is in
[`NOTICE`](NOTICE). Third-party rights and terms remain separate. This license
choice does not change repository visibility or publish a prerelease. The
repository remains private; access control is not an additional license term.

This inventory covers the source/release archive and the four installed mods.
Each installed mod carries its own full Apache `LICENSE` and `NOTICE`, so a
recipient need not retain the original checkout to read the applicable notices.
The `space-agents/NOTICE` also contains the retained icon attribution and full
ISC/MIT texts. Root legal documents and `licenses/` accompany the full archive.

## Herdr default mod adaptations — Apache-2.0

Primary source: [`herdrdev/herdr-app`, v0.1.9](https://github.com/herdrdev/herdr-app/tree/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2),
commit **`3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2`**.
Its [exact `LICENSE`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/LICENSE)
is Apache-2.0, not AGPL. A byte-identical copy is retained as
[`licenses/Herdr-Apache-2.0.txt`](licenses/Herdr-Apache-2.0.txt).
The installed Herdr application's resource `LICENSE` was also byte-identical
when inspected on 2026-11-02. These are source observations, not legal advice.

| Shipped file | Pinned upstream source | Modifications by koraybostanci, 2026 |
| --- | --- | --- |
| `mods/compact-spaces/main.js` | [`defaults/mods/spaces/main.js`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/spaces/main.js) | Compact space selector, menu behavior and presentation; retains substantial space/Git tracking logic. |
| `mods/space-agents/main.js` | [`defaults/mods/agents/main.js`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/agents/main.js) | Substantial adaptation into selected-space agent cards, repository grouping, session metadata and history. Not an unchanged clone. |
| `mods/session-tabs/main.js` | [`defaults/mods/tabs/main.js`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/tabs/main.js) | Owned mod identity, migration of legacy panel preferences and recording explicit panel choices; retains most upstream tab rendering and panel synchronization. |
| `mods/workspace-header/main.js` | [`defaults/mods/workspace-chrome/main.js`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/workspace-chrome/main.js) | Dedicated sidebar header; removes footer mode and adjusts titlebar/traffic-light spacing. |

The mod descriptors reuse or adapt the corresponding upstream `mod.json`
metadata. Only `workspace-header/mod.json` currently records `cloned_from`;
that field is not a complete provenance inventory. Supporting workspace
modules were added in this repository, not copied wholesale from other default
mods. This does not establish entirely independent implementation:
`mods/space-agents/space-tree.js` also shares the exact Spaces color palette
and adapts its machine-refresh pattern from the pinned
[`defaults/mods/spaces/main.js`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/mods/spaces/main.js).
That ancillary reuse is covered by the upstream Apache license and recorded
in the installed `space-agents/NOTICE`. `space-tree.js` now carries a prominent
pinned provenance and modification header as well. Its runtime behavior is
unchanged by the legal-header addition.

All four inspected upstream `main.js` files and descriptors have no copyright,
patent, trademark or license notice headers to reproduce. The pinned upstream
tree has **no root `NOTICE`**. It does have a generated
[`THIRD-PARTY-NOTICES`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/THIRD-PARTY-NOTICES)
covering the desktop app's compiled dependencies and assets. That inventory
does not mean this extension ships those dependencies. Relevant icon license
texts are retained below; unrelated host/vendor notices are not copied here.
Prominent headers identify modifications in each derived `main.js` and in
`space-tree.js`.

### Host-supplied, not bundled

Herdr supplies the `herdr`, `gpui-kit` and `gpui-base` runtime modules, other
default mods, runtime binaries, fonts, agent/brand icons, workspace-chrome
glyphs and `frame/welcome/herdr.png`. This bundle only references them at run
time. It does not redistribute the Herdr application or relicense these
host-supplied assets. Product and brand names remain their owners' marks;
Apache-2.0 does not grant trademark rights or imply endorsement.

## Bundled SVG asset audit

All three current SVG assets use canonical glyphs from **Lucide 0.468.0**,
immutable commit **`f12b0de177fbc2a6795e99be065887e72b237123`**. Source files
were retrieved from that commit, not identified by visual similarity. The
[license from the same revision](https://raw.githubusercontent.com/lucide-icons/lucide/f12b0de177fbc2a6795e99be065887e72b237123/LICENSE)
is retained byte-for-byte in
[`licenses/Lucide-0.468.0.txt`](licenses/Lucide-0.468.0.txt).

| Current asset | Verified source and changes |
| --- | --- |
| `mods/space-agents/pull-request.svg` | Exact, unmodified bytes of [`icons/git-pull-request.svg`](https://raw.githubusercontent.com/lucide-icons/lucide/f12b0de177fbc2a6795e99be065887e72b237123/icons/git-pull-request.svg). No path, stroke or sizing edits. |
| `mods/space-agents/trash.svg` | Exact, unmodified bytes of [`icons/trash-2.svg`](https://raw.githubusercontent.com/lucide-icons/lucide/f12b0de177fbc2a6795e99be065887e72b237123/icons/trash-2.svg). No path, stroke or sizing edits. |
| `assets/logo.svg` | [`icons/panels-top-left.svg`](https://raw.githubusercontent.com/lucide-icons/lucide/f12b0de177fbc2a6795e99be065887e72b237123/icons/panels-top-left.svg), with unchanged glyph geometry, inset at 80x80 in a 128x128 document mark. Added a newly composed navy rounded rectangular background, project title and provenance comment; set the glyph color. Owner additions are Apache-2.0; the Lucide glyph retains its original terms. |

Both native control assets retain `viewBox="0 0 24 24"` and `currentColor`.
The existing controls continue to set their displayed sizes to 11 and 14;
no control or runtime logic changed. The document mark retains the workspace
concept and 128x128 dimensions. It is not the Herdr brand/cow icon and is not
installed as a mod asset. The native app header still uses the host image.

[`licenses/assets.json`](licenses/assets.json) records each pinned source URL,
the pristine source SHA-256, shipped SHA-256, changes and superseded asset hash.
The canonical control assets match their pristine hashes exactly. The logo
carries a prominent modification/provenance comment; its shipped hash differs
from the canonical glyph because of the documented composition changes.

The current Lucide license and the pre-existing repository attribution are
retained in the installed `space-agents/NOTICE`. The earlier full ISC/Feather
MIT license copy is also preserved in [`licenses/Lucide.txt`](licenses/Lucide.txt)
and that installed notice, as historical attribution, from the pinned Herdr
[`defaults/icons/LICENSE-Lucide.txt`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/icons/LICENSE-Lucide.txt).
The current icons' source evidence is the Lucide commit above, not an inference
from that older Herdr notice. No third-party glyph is relicensed as owner code.

### Superseded asset history

During beta hardening on **2026-11-02**, all three previous asset files were
replaced with the known-source assets above. The earlier pull-request glyph
and workspace illustration were introduced in repository commit
`d6cd933809978bf4bc3b550331ea8dc595f670c1`; the earlier trash glyph was
introduced in `da535d232c9c8aa8b218d470b4969de8c63fc749`. Those changes did not
record exact external origins. The earlier pull-request notice described a
Lucide-style glyph, not a verified upstream match. This history is preserved
without inventing authorship confirmation. The superseded blobs remain in
private Git history, not in current-checkout source/release archives. This
inventory establishes the current assets' sources, not rights clearance for
redistributing those historical blobs or the Git metadata.

## Dependencies downloaded separately

`node_modules` and SDK/native binaries are not part of the source/release
archive. Installation downloads dependencies under their own terms. Lockfiles
pin versions and npm tarball integrity; they are not license grants. The two
package `LICENSE.md` files below were checked against the exact npm tarballs
and the lockfile SHA-512 integrity on 2026-11-02.

| Dependency | Applicable terms and primary evidence |
| --- | --- |
| `jsonc-parser` **3.3.1** | MIT, Copyright (c) Microsoft. Used by the installer and metadata helper. Full package license: [`licenses/jsonc-parser-MIT.txt`](licenses/jsonc-parser-MIT.txt). Primary package: [`jsonc-parser-3.3.1.tgz`](https://registry.npmjs.org/jsonc-parser/-/jsonc-parser-3.3.1.tgz), `package/LICENSE.md`. |
| `@anthropic-ai/claude-agent-sdk` **0.3.314** | **Not Apache-2.0.** Its `LICENSE.md` says: “© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.” Exact notice: [`licenses/claude-agent-sdk-NOTICE.txt`](licenses/claude-agent-sdk-NOTICE.txt). Primary package: [`claude-agent-sdk-0.3.314.tgz`](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.314.tgz), `package/LICENSE.md`. The lockfile's generic `SEE LICENSE IN README.md` marker is not the license text. |

The metadata helper's lockfile also lists platform-specific optional Anthropic
SDK packages at **0.3.314**. npm selects them for the recipient's platform;
they are downloaded, not vendored or relicensed here. The SDK's package notice
links to external legal agreements rather than embedding their full terms.
Recipients must check the applicable Anthropic agreements and account/use
requirements before using the integration. No conclusion about eligibility,
SDK redistribution or legal approval is implied by this inventory.

`@opencode/plugin/tui` and `solid-js` imports are provided by the recipient's
OpenCode harness, not copied into this bundle. Their installation and use stay
subject to the harness and packages' own terms.

See [`licenses/README.md`](licenses/README.md) for retained text hashes and scope.
