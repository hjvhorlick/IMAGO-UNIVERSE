# The art library

## Provenance — please read

The application contains **no generative AI**. Nothing is generated at runtime; there is no model,
no API key, no token cost. The runtime library is a fixed set of WebP files plus a JSON manifest.

The **source artwork plates** in `assets-src/` were produced during development with an image
generator, then processed by a conventional Python pipeline. This is disclosed because the master
brief forbids generative AI *in the product*, and it matters that the distinction is clear:

- **In the product:** conventional rendering, composition, deformation, particles, grading. No AI.
- **In the art supply chain:** 10 painted plates were generated once, offline, and are now static
  files indistinguishable from commissioned artwork. Replace them with licensed or hand-painted
  art and nothing in the application changes.

Every asset records its own `origin` in the manifest, so provenance is auditable per asset rather
than buried in a README.

| `origin` | Count | Meaning |
| --- | --- | --- |
| `painted` | 12 | A dedicated source plate exists in `assets-src/` |
| `graded` | 17 | Colour-graded from a painted plate to build the sibling styles |
| `composed` | 5 | Built procedurally by the pipeline from extracted artwork chips |
| `derived` | 3 | Geometric/colour variant of another asset (mirror, narrow, golden) |

The image generator hit a hard 10-image-per-turn cap during the first art pass, so there are no
painted flower or fern plates. Those foreground plants are `composed` — assembled by the pipeline from
foliage chips extracted from the painted plates. This is a real limitation of the current library's
variety, not a hidden one.

## Styles

Three complete styles ship. A style is only offered once it has all five reference pieces
(background, tree, structure, foreground plant, ground element), which is what guarantees any
composition in that style is coherent.

| Style | Character | Light | Assets |
| --- | --- | --- | --- |
| `enchanted` | Warm sunlit fantasy — golden hour, lush greens, soft god rays | upper-left | 18 |
| `moonlit` | Cool nocturnal sibling — silver foliage, deep teals, lantern warmth | upper-right | 8 |
| `autumn` | Harvest sibling — amber, copper and rust foliage, stone kept neutral | upper-left | 11 |

`moonlit` and `autumn` are graded siblings of `enchanted`, not independently painted styles. They
demonstrate that the style system, the light-direction metadata and the grading pipeline all work,
but they are not yet stylistically independent bodies of work.

The autumn grade is **foliage-aware**: it detects green-dominant and yellow-green pixels and shifts
only those toward amber, so the stone bridge stays stone and bark stays bark. A flat warm multiply
would read as a colour cast rather than a season.

## Inventory

**Backgrounds (7)** — Enchanted Lake Valley, Sunrise Highlands, Sunlit Forest Hollow, Moonlit Forest
Glade, Night Lake Valley, Autumn River Valley, Harvest Woodland Hollow
**Middle-ground (13)** — Ancient Oak, Weeping Willow, Mossy Stone Bridge, Elven Garden Pavilion,
Mossy Boulders, Forest Waterfall, Silver Oak, Lantern Pavilion, Moonlit Boulders, Amber Oak, Copper
Willow, Harvest Stone Bridge, Autumn Boulders
**Foreground (17)** — Lush Grass Tuft, Grass Clump (narrow), Grass Sweep (mirrored), Golden Harvest
Grass, Wildflower Cluster, Woodland Fern, Leafy Bush, Ground Ivy Trail, Pebble Scatter, Moonlit
Grass, Night Fern, Shadow Bush, Autumn Grass, Bracken Fern, Copper Bush, Fallen Ivy Trail, Autumn
Pebble Scatter
**Atmosphere (22 effects)** — procedural, not assets; see below.

The brief's starter targets were 5 backgrounds / 8 middle / 8 foreground / 10 effects. **All four
targets are met or exceeded** (7 / 13 / 17 / 22). `npm run render-check` composes and renders one
world per background plate to `.render-check/worlds.png` so the variety is verifiable at a glance.

## Atmospheric effects

Layer 4 is procedural and never style-gated. 22 effects in 6 families:

- **Magical:** fairy-dust, sparkles, glowing-orbs, light-beams, energy-rings
- **Symbols:** magic-circle, mandala, floating-runes, glowing-symbols
- **Celestial:** constellation, starfield, shooting-stars, aurora
- **Fantasy:** butterflies, drifting-petals, feathers
- **Natural:** fireflies, falling-leaves, bubbles
- **Weather:** mist, snow, rain

Six theme presets (Norse, Greek, Chinese fantasy, Gothic, fairy tale, meditation/celestial) select
and tune subsets of these effects. They are **artistic interpretations, not claims of cultural
authenticity**.

## Metadata

Every asset carries: `id`, `name`, `style`, `layer`, `category`, `themes`, `tags`, `origin`, `file`,
`thumb`, `format`, `width`, `height`, `alpha`, `depth`, `groundContact`, `perspective`, `lighting`,
`palette`, `defaultScale`, `placement`, `animations`, `rig`, `variants`, `notes`, `bytes`.

`groundContact` is the normalised y of the point that must sit on the ground line — this is what
makes grounding work for a tuft of grass versus a boulder versus a tree.

`rig` describes how the asset may be deformed:

```jsonc
// tree
{ "anchor": [0.5, 1], "canopyStart": 0.66, "stiffness": 0.72, "gusts": 3 }
// grass / stem
{ "stiffness": 0.18, "gusts": 4 }
// waterfall — the sub-rectangle that may scroll
{ "region": [0.30, 0.06, 0.42, 0.80] }
```

An asset with no rig can still translate, rotate, scale, pulse and glow, but will not be warped.

## The preparation pipeline

```bash
python3 -m venv .venv
.venv/bin/pip install Pillow numpy
.venv/bin/python tools/prepare_assets.py
```

`tools/prepare_assets.py` performs, in order:

1. **Chroma-key un-mixing.** Plates are shot on a pure magenta `#FF00FF` backdrop. Rather than a
   tolerance key (which leaves a coloured fringe), alpha is recovered from the key channel and the
   foreground colour is *un-composited*: `obj = (observed − key·(1−a)) / a`. This yields clean edges
   with zero magenta residue — verified across all assets by `npm run render-check`.
2. **Despill and alpha refinement.**
3. **Autocrop** to the content bounding box, recording the ground-contact point.
4. **Palette extraction** for style matching and grading.
5. **Sibling grades** — a night grade builds `moonlit`; a foliage-aware autumn grade builds `autumn`.
6. **Procedural plants** — green-biased foliage chips are extracted from the painted plates and
   assembled into ferns, bushes, ivy and pebble scatter with a shared ground line.
7. **Encode** to WebP (quality 90, method 6, exact) plus 256 px thumbnails, and write
   `public/library/manifest.json` (`imago.asset-library/1`).

Output: 37 assets, ~5.9 MB of WebP (6.6 MB on disk with thumbnails).

## Adding a style

1. Create `assets-src/style-<name>/` and add plates on a magenta backdrop. Name them
   `bg-*`, `mid-*`, `fg-*`.
2. Add the style entry and any per-asset metadata to the pipeline's style table.
3. Run `npm run assets`.
4. The style appears in the New World and Change Style dialogs only once its five reference pieces
   exist. Until then it is invisible rather than half-usable.

## Adding an asset at runtime

The asset panel's Import button accepts PNG/WebP/JPEG with alpha. You choose the layer, category
and ground-contact point; the file is stored in IndexedDB and behaves like a built-in, including
being embedded in any `.sceneproject` that uses it.
