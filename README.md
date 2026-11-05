# Imago Universe

**Create worlds. Bring them to life.**

A browser-based world-building, environment-composition and animation application. You assemble
layered environments from a curated library of transparent artwork, the compositor grounds and
lights them into a single believable place, an independent animation engine brings the scene to
life, and the export pipeline renders stills or long looping video.

Everything runs locally in the browser. **There is no generative AI, no AI API, no token cost and
no cloud service anywhere in the application** — the creative work is done by conventional
rendering software operating on a curated art library.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on `0.0.0.0:5173` |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run preview` | Serve the production build on port 4173 |
| `npm test` | 141 unit / integration / UI tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run render-check` | Headless pixel verification of the real render pipeline |
| `npm run assets` | Rebuild the runtime art library and `docs/ASSET_CATALOG.md` from `assets-src/` (needs Pillow + numpy, ~11 min) |

The app opens on a fully composed demo world so there is something real to look at immediately.

---

## The four layers

Every scene is built from exactly four layers, painted back to front:

1. **Background** — the painted plate that establishes the place, horizon and light.
2. **Middle-ground** — trees, structures, rock, water; the substance of the world.
3. **Foreground** — grass, flowers, ferns, ground detail. Fully animatable, and allowed to
   extend past the canvas edge; only the visible part is rendered.
4. **Atmosphere & Imagination** — particles, light, magic, weather. **Universal:** this layer is
   never filtered by artistic style, so any effect can be used with any world.

Layers 1–3 are gated by the selected artistic style. Incompatible artwork is simply never shown —
there are no style-conflict dialogs, because the conflict cannot be created in the first place.

---

## What is implemented

**Asset library** — 186 assets across 3 styles, with fairy/Norse/Chinese/Japanese-inspired vistas,
a celestial observatory, a moonlit waterside and a lotus sanctuary with animated water, a timber
meditation pavilion and close-up lotus blossoms. Placeable Chinese-inspired moon gate, Japanese-inspired
stone lantern and Norse-inspired dragon boat add garden and waterside details.
Detailed close-up flowers add foreground variety. Eight room views reveal the current composition
through their windows, including present-day timber-beamed rooms as well as modern and futuristic
high-ceiling spaces, and an asymmetrical brick-and-timber room with windows on adjoining walls.
Animated fireplaces, a steaming coffee cup and contemporary furniture and doors
can be placed independently, including an oak bookshelf, potted fig and floor lamp. Assets come in Enchanted,
Moonlit and Autumn palettes.
Rich metadata includes
dimensions, alpha, depth, perspective, ground-contact point, lighting direction, palette,
animation capabilities, rig and variants. Visual browser with categories, search, theme filters,
thumbnails, favourites, preview, import and remove. Imported files are stored in IndexedDB and
survive reloads.

**Composition** — grounding to a depth-dependent ground line, depth scaling, occlusion ordering,
contact shadows sheared to the light direction, distance haze and per-style colour grading.
Optional auto-composition with controlled randomisation from a seed. **Locked objects are never
moved or replaced** by any automatic operation.

**Editor** — canvas-centric three-pane layout. Drag-drop, zoom, pan, move, resize, rotate, flip,
duplicate, delete, hide, lock, opacity, blend, layer reordering, undo/redo with a named history.
Two genuinely different crops: *image crop* (which part of the asset is used) and *canvas
overflow* (whether the scene clips at its own bounds). All editing is non-destructive.
Solo preview auditions a single animation or effect on its own, or one whole layer.

**Animation** — 16 techniques chosen per asset type, evaluated independently of the compositor:
canopy sway with a planted trunk and desynchronised branches, grass deformation, stem bending,
water shimmer and flow, waterfall cascades with splash and rising mist, flickering hearth fire,
rising coffee steam, cloud drift, ripples, flag waves, floating, spinning, pulsing, glow and parallax.
A tree is never rotated as a whole.

**Loop Manager** — a dedicated module that analyses every animated node, snaps cycle lengths to a
0.5 s grid, computes the master cycle as their least common multiple (capped at 60 s), and reports
honestly whether the scene returns *exactly* to its initial state. Video duration is completely
decoupled from cycle length.

**Effects** — 52 universal atmospheric effects in 7 families, plus 8 theme presets, including Norse,
Greek, Chinese-inspired fantasy, a Japanese moon garden, fairy tale, and a mythic zodiac. The new
**Spiritual & Mystical Overlays** category offers 25 individually placeable vector ornaments across
eight subcategories, with materials, movement, rotation, glow, particles and timing controls. Select
Layer 4 to drag or click ornaments; use Properties and Animation to edit each one. Their simulated
materials and perspective are 2D artistic interpretations, not religiously authoritative diagrams.

**Export** — PNG / JPEG / WebP stills with zero editor UI in the output. MP4 (H.264) and WebM video
via WebCodecs with a MediaRecorder fallback. 16:9, 9:16, 1:1, 4:3, 21:9 and custom aspect ratios;
720p / 1080p / 1440p / 4K; 24 / 30 / 60 fps; four quality tiers with a live size estimate, progress
and cancellation.

**Sound** — an import slot, not a library. The app ships no audio. A track you import plays in the
preview, loops with a configurable crossfade at the join, and is embedded in the `.sceneproject`
so it reopens with the scene. Exported video is still silent.

**Projects** — `.sceneproject` is a ZIP containing the full editable scene graph plus every asset
byte the scene uses. Never flattened. Save, Save As, open, and an in-browser project shelf.
Save As mints a new id and leaves the original untouched.

---

## How long video stays cheap

The Loop Manager proves the scene is exactly periodic; the video renderer then encodes **one master
cycle** and repeats those same encoded samples for the rest of the duration. A 60-minute export of
the 48-second demo world encodes 1 440 frames instead of 108 000 — and every repeat is
bit-identical, so the loop is genuinely seamless rather than approximately seamless.

Each repeat starts on source frame 0, which is a key frame, so the stream stays decodable at every
boundary. Frames are never accumulated in memory: encoded chunks stream into a file handle, the
Origin Private File System, or a memory buffer, in that order of preference.

If the scene *cannot* be tiled — an effect with a start/stop window, or a cycle that does not divide
the duration — the renderer says so and falls back to rendering every frame. It never claims a
seamless loop it cannot deliver.

---

## Verification

```
npm test              run the full Vitest suite
npm run typecheck     clean, strict
npm run build         current production build succeeds
npm run render-check  loop boundary: 0 differing subpixels
                      mid-cycle motion: about 10.9% of pixels
                      all effects exactly periodic
                      no chroma-key residue in any asset
                      28 composed environments, one per background
```

`tools/render_check.ts` runs the **real** compositor, animation engine, Loop Manager and effect
library against a native canvas and writes PNGs to `.render-check/`. `tests/ui.smoke.test.ts`
mounts the **real** application in jsdom and drives it: adding assets, transforming, undoing,
switching layers and styles, applying themes, opening every dialog, round-tripping a project and
exporting a PNG.

**Please read [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before relying on video export.** The
sandbox this was built in has no browser and no ffmpeg, so the WebCodecs/MediaRecorder paths are
verified by logic and unit tests, not by producing a real MP4. Still-image export, composition,
animation and looping *are* verified against real pixels.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, data flow, render pipeline, extension points
- [docs/ASSETS.md](docs/ASSETS.md) — art library, provenance of every asset, how to add styles
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — what is verified, what is not, and known constraints

---

## Repository layout

```
src/
  core/        types, store (undo/redo), maths utilities
  assets/      asset library, metadata gate, imports, favourites
  scene/       scene model, composition, style manager, demo world
  animation/   animation engine, Loop Manager, effects, effect primitives
  render/      compositor, mesh/strip deformation, image cache,
               preview / still / video renderers
  project/     .sceneproject package format, IndexedDB shelf
  export/      export manager, capability detection, presets
  ui/          application shell, stage, panels, dialogs
  styles/      design system
assets-src/plates/<layer>/  source artwork plates (pipeline input), one folder per layer
public/library/<style>/<layer>/  runtime WebP assets + thumbs/ + manifest.json
docs/ASSET_CATALOG.md  every asset with a thumbnail, grouped by style and layer
tools/         asset preparation pipeline, headless render verification
tests/         141 tests across 11 files
docs/          architecture, assets, limitations
```
