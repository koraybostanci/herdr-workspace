# Third-party material

## Herdr default mods (derived)

`mods/compact-spaces`, `mods/space-agents` and `mods/session-tabs`
are owned clones of, or additions to, the default mods shipped with Herdr 0.1.9
(each `mod.json` records `cloned_from`). Herdr supplies the `herdr`, `gpui-kit`
and `gpui-base` runtime modules at run time; they are not copied here.

**Open item for the owner:** confirm the Herdr license terms for derived mod
code and add any required notice here before the repository is made public or
distributed. This bundle does not include Herdr binaries or other Herdr mods.

## Icons

The bundled SVG icon (`mods/space-agents/pull-request.svg`) is a Lucide-style glyph. Lucide is ISC
licensed, with MIT-licensed Feather-derived icons (https://lucide.dev).

> ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis
> 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are
> held by Lucide Contributors 2022.
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
> SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
> RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
> CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
> CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Agent and brand icons are provided by the host Herdr app and are not bundled.

## npm dependencies

Installed from `integrations/session-metadata/package-lock.json` (not vendored):

- `@anthropic-ai/claude-agent-sdk` 0.3.314: see the license in its package.
- `jsonc-parser` 3.3.1: MIT.
