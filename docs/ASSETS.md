# The art library

## Provenance — please read

The application contains **no generative AI**. Nothing is generated at runtime; there is no model,
no API key, no token cost. The runtime library is a fixed set of WebP files plus a JSON manifest.

The **source artwork plates** in `assets-src/` were produced during development with an image
generator, then processed by a conventional Python pipeline. This is disclosed because the master
brief forbids generative AI *in the product*, and it matters that the distinction is clear:

- **In the product:** conventional rendering, composition, deformation, particles, grading. No AI.
- **In the art supply chain:** painted plates were generated offline and are now static files.
  The lounge-window overlays use a chroma-keyed opening so the current scene shows through. Replace
  these with licensed or hand-painted artwork and nothing in the application changes.

Every asset records its own `origin` in the manifest, so provenance is auditable per asset rather
than buried in a README.

| `origin` | Count | Meaning |
| --- | --- | --- |
| `painted` | 130 | A dedicated source plate exists in `assets-src/` |
| `graded` | 161 | Colour-graded from a painted plate to build the sibling styles |
| `composed` | 5 | Built procedurally by the pipeline from extracted artwork chips |
| `derived` | 3 | Geometric/colour variant of another asset (mirror, narrow, golden) |

Many general-purpose ground plants are `composed` — assembled by the pipeline from foliage chips
extracted from painted plates. The story-specific foreground accents have dedicated painted sources.
This keeps the starter library varied without pretending its general flora is a large catalog.

## Styles

Three complete styles ship. A style is only offered once it has all five reference pieces
(background, tree, structure, foreground plant, ground element), which is what guarantees any
composition in that style is coherent.

| Style | Character | Light | Assets |
| --- | --- | --- | --- |
| `enchanted` | Fantasy vistas, including an observatory and a moonlit waterside | upper-left | 89 |
| `moonlit` | Cool nocturnal sibling, including moonlit grades of the seven story sets | upper-right | 80 |
| `autumn` | Harvest sibling, including autumn grades of the seven story sets | upper-left | 83 |
| `winter` | Frostfall: an independently painted winter collection, with shared interiors | upper-left | 29 |
| `realistic` | Clearwater: ultra-realistic photographic water and rooms | upper-left | 18 |

`moonlit` and `autumn` are graded siblings of `enchanted`, not independently painted styles. They
demonstrate that the style system, the light-direction metadata and the grading pipeline all work,
but they are not yet stylistically independent bodies of work.

The autumn grade is **foliage-aware**: it detects green-dominant and yellow-green pixels and shifts
only those toward amber, so the stone bridge stays stone and bark stays bark. A flat warm multiply
would read as a colour cast rather than a season.

## Inventory

**Backgrounds (28)** — The 7 base Enchanted, Moonlit and Autumn vistas, plus Fairy Court Glade,
Norse Worldtree Fjord, Chinese-Inspired Mist Mountains, Japanese Moon Garden, Celestial Observatory
Garden, Moonlit Waterside and Lotus Sanctuary Lake in each palette. The waterside river shimmers automatically on placement.
**Middle-ground (54)** — The 15 base trees, structures, rocks and waterfalls, plus a Fae Court
Willow, Norse rune stones, Chinese-inspired pavilion, Japanese torii gate, Celestial Astrolabe
Arch, Lantern Bridge and a contemporary timber meditation pavilion in each palette. A Chinese-inspired
moon gate, Japanese-inspired stone lantern and Norse-inspired dragon boat are separately placeable
decorations in each palette. The lantern glows and the boat floats automatically; their motion can be edited.
The boat's lower hull is cut along a gently wavy, transparent waterline, so place it over water for a submerged appearance. A fairy mushroom cottage, Japanese-inspired arched garden bridge and Norse-inspired stone well are also individually placeable in each palette. Their artwork is static; atmospheric effects can be layered around them.
**Foreground (189)** — The 20 base plants, grasses, ground covers and room overlays, plus Fae Lantern
Mushrooms, Frost-Kissed Juniper, Peach Blossom Garden Cluster, Moon Garden Moss and Sakura,
Starflower Cluster and River Reeds in Enchanted, Moonlit and Autumn palettes. Ten detailed botanical
close-up plates — Woodland Foxgloves, Wild Roses, Woodland Anemones, Scarlet Wild Poppies, Rose Peonies,
Golden Irises, Lotus Blossoms, Scarlet Dahlias, Golden Sunflowers, White Moth Orchids, Garden Tulips,
Daffodils and Cosmos Spray — also come in each palette; they retain their source dimensions, use higher-quality
WebP encoding and support stem bending. Each palette also has two additional windowed rooms with
flickering hearths and steaming cups, plus a separate stone fireplace and coffee cup. A modern
penthouse and futuristic sky lounge offer high ceilings and large transparent windows, with a separate
modular sectional, futuristic chair and animated modern fireplace. Eight placeable creatures — a white
stag, red fox, mute swans, koi fish, butterflies, a great owl, a brown rabbit, a red squirrel, mallard
ducks, a hedgehog, a deer fawn, a moor frog and a flock of songbirds — come in each palette as their own
objects; each is still when placed and offers optional breathing, swimming or wing-fluttering motion. Two present-day rooms have
varnished oak beams, wooden doors, tiled floors and large windows; the great room includes an
animated fireplace. An asymmetrical brick-and-timber room has a sloping roof and two transparent
windows on adjacent walls. A separate oak door, lounge chair, coffee table, bookshelf, floor lamp and potted fig are also available. Find them under **Layer 4 → Rooms & interiors**; loose furniture and props can be moved and resized independently. Their source assets remain foreground artwork in the manifest, but newly placed interiors are scene nodes on Layer 4.
**Atmosphere (52 effects)** — procedural, not assets; see below.

The brief's starter targets were 5 backgrounds / 8 middle / 8 foreground / 10 effects. **All four
targets are met or exceeded** (32 / 78 / 189 / 52). `npm run render-check` composes and renders one
world per background plate to `.render-check/worlds.png` so the variety is verifiable at a glance.

## Atmospheric effects

The effects in Layer 4 are procedural and never style-gated. The same layer also offers style-matched room artwork under a separate tab. 52 effects in 7 families:

- **Magical:** fairy-dust, sparkles, glowing-orbs, light-beams, energy-rings
- **Symbols:** magic-circle, mandala, floating-runes, glowing-symbols, mythic-emblem
- **Celestial:** constellation, starfield, shooting-stars, aurora, zodiac-wheel
- **Fantasy:** butterflies, drifting-petals, feathers, floating-lanterns
- **Natural:** fireflies, falling-leaves, bubbles, wind-currents
- **Weather:** mist, snow, rain, rising-mist
- **Spiritual & Mystical Overlays:** 25 independently placeable vector ornaments across Sacred Geometry,
  Meditation Symbols, Mandalas, Chakra & Energy, Celestial Symbols, Ancient Mystical Symbols, Glowing
  Geometric Patterns and Inspirational Elements. Choose the category in Layer 4 and use its collection
  filter to browse. The seven chakra designs and the yantra, Om and zodiac motifs are stylized
  interpretations, not authoritative representations.

These ornaments use Canvas paths rather than large image files; they render transparently and work in
any style. Appearance presets simulate gold, silver, white, energy, glass and holographic finishes,
with a custom colour option. Each has independent position, size, rotation, opacity, cycle length,
rotation direction, phase, sway, tilt, simulated depth, glow, fade, particles and optional trails.
Tilt/depth and materials are 2D approximations, not physical 3D. When a start or stop is set, the
separate start/stop fade softens the edge. Timing windows prevent master-cycle video tiling.

Eight theme presets include Norse, Greek, Chinese-inspired fantasy, Japanese moonlit garden, Gothic,
fairy tale, meditation/celestial, and Mythic Zodiac. They are **artistic interpretations, not claims
of cultural authenticity**. A layered lounge-window foreground overlay lets any current composition
show through a large transparent window opening.

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
// waterfall — cascades, splash and mist animate inside this region
{ "type": "fall", "region": [0.16, 0.10, 0.68, 0.85], "speed": 1.0 }
// lounge view — alpha opening reveals the composed scene behind the frame
{ "type": "window-overlay" }
```

An asset with no rig can still translate, rotate, scale, pulse and glow, but will not be warped.

## The preparation pipeline

```bash
python3 -m venv .venv
.venv/bin/pip install Pillow numpy
.venv/bin/python tools/prepare_assets.py
```

`tools/prepare_assets.py` performs, in order:

1. **Chroma-key un-mixing.** Object plates use a magenta `#FF00FF` or blue `#0000FF` studio backdrop;
   blue preserves the pink and red petals of the new flowers. Alpha is estimated from key dominance
   and the foreground colour is *un-composited*: `obj = (observed − key·(1−a)) / a`.
   `npm run render-check` scans each object for opaque pixels dominated by its key colour.
2. **Despill and alpha refinement.**
3. **Autocrop** to the content bounding box, recording the ground-contact point.
4. **Palette extraction** for style matching and grading.
5. **Sibling grades** — a night grade builds `moonlit`; a foliage-aware autumn grade builds `autumn`.
6. **Procedural plants** — green-biased foliage chips are extracted from the painted plates and
   assembled into ferns, bushes, ivy and pebble scatter with a shared ground line.
7. **Encode** to WebP (quality 90, or 95 for close-up botanical plates; method 6, exact) plus 256 px thumbnails, and write
   `public/library/manifest.json` (`imago.asset-library/1`).

Output: 299 assets; file sizes depend on the WebP encoder used.

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
