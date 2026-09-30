# mcpmaster brand assets

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="mcpmaster-lockup-dark.svg">
    <img src="mcpmaster-lockup-light.svg" height="64" alt="mcpmaster">
  </picture>
</p>

The mark is an **M inside a port ring**, with a tab where the connection
plugs in: one endpoint your agents connect to, with every tool behind it. Use
these files whenever you need to show mcpmaster, in a README, a blog post, a
slide or an integration list.

It's a sibling of the [mcpv](https://github.com/mcpmastersh/mcpv/tree/main/brand)
`[v]` mark: same tile, same colors, same light and dark variants.

## Files

| File | What it is | Use it for |
| --- | --- | --- |
| [`mcpmaster-logo-light.svg`](mcpmaster-logo-light.svg) | Mark, white tile | Light backgrounds |
| [`mcpmaster-logo-dark.svg`](mcpmaster-logo-dark.svg) | Mark, dark tile | Dark backgrounds |
| [`mcpmaster-logo.svg`](mcpmaster-logo.svg) | Mark that follows the system light/dark setting | Favicons, and apps that follow the system theme (it's the mcpmaster web UI's icon) |
| [`mcpmaster-lockup-light.svg`](mcpmaster-lockup-light.svg) | Mark + "mcpmaster", dark text | Headers and banners on light backgrounds |
| [`mcpmaster-lockup-dark.svg`](mcpmaster-lockup-dark.svg) | Mark + "mcpmaster", light text | Headers and banners on dark backgrounds |
| [`png/`](png/) | PNG exports, transparent background | Places that don't take SVG |

PNG sizes: `mcpmaster-logo-{light,dark}-{16,32,64,128,256,512}.png`, and
`mcpmaster-lockup-{light,dark}@2x.png` (586×128) / `@4x.png` (1172×256).

Prefer the SVGs: they're sharp at any size and under a few kilobytes. The
wordmark in the lockups is outlined (Geist SemiBold), so it looks the same
without the font installed.

## Which one do I use?

**In a GitHub README or Markdown doc.** Let GitHub pick the variant for the
reader's theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mcpmastersh/mcpmaster/main/brand/mcpmaster-logo-dark.svg">
  <img src="https://raw.githubusercontent.com/mcpmastersh/mcpmaster/main/brand/mcpmaster-logo-light.svg" width="48" height="48" alt="mcpmaster">
</picture>
```

Swap in `mcpmaster-lockup-*.svg` (and use `height="48"` without a width) to
show the name next to the mark.

**As a website favicon.** Use the adaptive SVG, with a PNG fallback:

```html
<link rel="icon" href="mcpmaster-logo.svg" type="image/svg+xml">
<link rel="icon" href="png/mcpmaster-logo-light-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="png/mcpmaster-logo-light-256.png">
```

**On a page with its own light/dark toggle.** Show `mcpmaster-logo-light.svg`
in light mode and `mcpmaster-logo-dark.svg` in dark mode. The adaptive file
follows the system setting, not your page's toggle.

**Social cards, app stores, avatars.** `png/mcpmaster-logo-{light,dark}-512.png`.

**Profile pictures (GitHub org, X, LinkedIn, Discord).** Use
[`png/mcpmaster-avatar-500.png`](png/mcpmaster-avatar-500.png)
([SVG](mcpmaster-avatar.svg)): the mark on a full-bleed dark square with no tile
or rounded corners, because those sites crop avatars to their own rounded
square or circle. It's the avatar of the `mcpmastersh` GitHub organization.

**In a list of MCP servers, integrations or tools.** The mark on its own, at the
same size as the other logos in the list.

**Next to mcpv.** Use both marks at the same size and the same variant
(both light or both dark).

## Colors

| | Light | Dark |
| --- | --- | --- |
| Tile | `#ffffff`, edge `#e1e1e8` | `#121216`, edge `#2e2e39` |
| Ring and tab | `#5a46f0` | `#8b7bff` |
| M | `#121216` | `#ffffff` |
| Wordmark | `#121216` | `#f2f2f5` |

## Please

- **Keep the tile and the tab.** The ring, the tab and the M belong together;
  don't use the M on its own or drop the tab.
- **Leave room.** Keep clear space of at least a quarter of the mark's width on
  every side (16 px around a 64 px mark).
- **Don't go below 16 px** for the mark, or 24 px tall for a lockup.
- **Match the background.** Light files on light backgrounds, dark files on
  dark ones.
- **Don't change it.** No recoloring, stretching, rotating, outlines, shadows
  or effects, and don't set "mcpmaster" in another font next to the mark: use
  a lockup file instead.
