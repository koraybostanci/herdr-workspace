# Retained license texts

These files are legal texts, notices and asset provenance metadata, not
vendored SDK implementations.
`THIRD_PARTY.md` defines which material is actually shipped. Do not interpret
this directory as licensing separately installed SDKs under Apache-2.0.

Verified on 2026-11-02:

| File | Source and scope | SHA-256 of retained bytes |
| --- | --- | --- |
| `Herdr-Apache-2.0.txt` | [Herdr v0.1.9 `LICENSE`](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/LICENSE). Full Apache-2.0 text; byte-identical to root and per-mod `LICENSE` files and the inspected installed host license. | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `Lucide-0.468.0.txt` | [Lucide 0.468.0 `LICENSE`](https://raw.githubusercontent.com/lucide-icons/lucide/f12b0de177fbc2a6795e99be065887e72b237123/LICENSE), from the same immutable revision as all three current SVG glyphs. Full ISC notice with Feather MIT attribution; also reproduced in installed `space-agents/NOTICE`. | `1e7290b35280a048667bbf0ebabac1c7fd52a75300e8b2946ac165715997f2bc` |
| `Lucide.txt` | [Earlier pinned Herdr icon notice](https://raw.githubusercontent.com/herdrdev/herdr-app/3e32d75e7aa2327d7b1f89caf3d5dafd1f44f1b2/defaults/icons/LICENSE-Lucide.txt). Full ISC and Feather MIT text retained as historical attribution, including in installed `space-agents/NOTICE`. It is not the source evidence for the current glyphs. | `b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57` |
| `jsonc-parser-MIT.txt` | `package/LICENSE.md` from [jsonc-parser 3.3.1](https://registry.npmjs.org/jsonc-parser/-/jsonc-parser-3.3.1.tgz); archive integrity verified against the lockfile. MIT notice for a separately installed dependency. Original line endings retained. | `c3a24c02d678e5f0711623dcf3ab3f243b273c2633f638a1fa8e35fb7c7f8e4d` |
| `claude-agent-sdk-NOTICE.txt` | `package/LICENSE.md` from [Anthropic Claude Agent SDK 0.3.314](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.314.tgz); archive integrity verified against the lockfile. Package notice only: rights reserved, with an external agreements link. Not a copy of those agreements or a redistribution grant. | `8ce94b9478bb9868f9641f818e06cd722fbe55d4c22e2d2ed11971b20146173a` |

## SVG source and shipped hashes

[`assets.json`](assets.json) is the machine-readable source inventory. All
sources are pinned to Lucide commit `f12b0de177fbc2a6795e99be065887e72b237123`
(tag `0.468.0`). The canonical controls are byte-identical to that revision;
only the document mark is composed/modified. No runtime or native header
branding was changed. The newly added logo background and composition are
owner additions under Apache-2.0, not a claim of authorship of the glyph.

| Shipped path | Pristine source SHA-256 | Shipped SHA-256 |
| --- | --- | --- |
| `mods/space-agents/pull-request.svg` | `6dbc18c42d08f225e3fc0a34fe5bf62d8b2abae83ada8163f3bbb649f2b8d25f` | `6dbc18c42d08f225e3fc0a34fe5bf62d8b2abae83ada8163f3bbb649f2b8d25f` |
| `mods/space-agents/trash.svg` | `e63698acf757d3043fcb4a9ea6ffceff9dd84708707eafc879c86b34a6ff2786` | `e63698acf757d3043fcb4a9ea6ffceff9dd84708707eafc879c86b34a6ff2786` |
| `assets/logo.svg` | `321a2a5500f2b814a2e62eb73c4b01dc65c7334fe2e6f7d77517239383e26bb1` | `5019e19076f2091fb3c7d142724e9085fec5a49de4b9a9ab046663154e48a234` |

The inventory records the modifications and replaced hashes. The earlier
assets' origins remain unverified historical facts; those blobs are no longer
shipped in current-checkout archives. Their historical notices are retained,
not treated as proof of their original source or as clearance to redistribute
private Git history.

The pinned Herdr tree has no root `NOTICE`. Its generated desktop
`THIRD-PARTY-NOTICES` was inspected, not copied wholesale: the extension does
not ship the desktop runtime, fonts or compiled/vendor dependencies to which
those unrelated notices apply. That upstream notice file's SHA-256 is
`4f219329e4f694cb1462eb300487decb60f9bcff39189c731227ca2930ca969e`.

Preserve root `LICENSE`, `NOTICE`, `THIRD_PARTY.md` and this directory in full
source/release archives. Preserve each mod's `LICENSE`, `NOTICE` and derived
source modification headers when distributing or installing that mod alone.
