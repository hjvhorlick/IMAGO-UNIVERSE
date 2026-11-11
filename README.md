# Imago Universe
[![CI](https://github.com/hjvhorlick/IMAGO-UNIVERSE/actions/workflows/ci.yml/badge.svg)](https://github.com/hjvhorlick/IMAGO-UNIVERSE/actions/workflows/ci.yml)

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
| `npm test` | 203 unit / integration / UI tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run render-check` | Headless pixel verification of the real render pipeline |
| `npm run assets` | Rebuild the runtime art library and `docs/ASSET_CATALOG.md` from `assets-src/` (needs Pillow + numpy, ~11 min) |

The app opens empty with the **world picker** showing. A world is a background type (for example
"enchanted lake" or "celestial observatory"), grouped into categories. Its looks (enchanted, moonlit,
autumn) change the palette within that world. Choosing a world puts only its background in the
scene; you add everything else yourself. The "Demo" starting point still builds the composed sample.

### Flying bird flock

Find **Songbird Flock** in **Layer 2 → Artwork → Creatures**. Newly placed flocks
start high in the sky as a loose clustered group of 18 level, forward-facing
birds with deliberately uneven spacing. Like real songbirds, each cruises on
wings held out level with its side, breaking into brief flap bursts on its own
random sequence - some birds beating while others glide in any given frame -
and keeps its
own slight speed, so birds overtake each other and the group breathes. The flock
makes a slow, unhurried crossing of its sky area — about twenty-four seconds
there and back — riding further away and closer again, leaving the frame on the
long leg and coming back, looping seamlessly. Move, resize or flip
the flock as a single object — the flight area follows the node bounds. Use
Animation to adjust or turn off its motion. In an older project where the flock
was placed while animation was off, enable **Wing flutter** to see the glide,
the flap bursts and the crossing flight.

### Gentle water movement

In **Layer 4 → Atmosphere → Natural**, choose **Rain Ripples** for heavy, densely overlapping raindrop impacts,
**Lake Waves** for waves that sway sideways with a slight rise and fall, or **River Flow** for the same waves travelling in a chosen direction with reflective crests. You can
combine Rain Ripples with the Rain effect. Select a water effect and drag its **eight round points**
to trace the water; the square handles resize the whole area. Move points outside the frame to extend
it, or duplicate an effect for separate areas. In Animation, adjust strength, size and speed. River Flow
can travel left, right, up or down; rotate the area to follow the river's course.

These effects animate the image beneath them and add moving wave highlights and shadows. River waves travel downstream while the reflected image moves only slightly, mostly up and down rather than sideways. They do not automatically
detect shorelines, so trace only the water and keep the effect above its artwork in the layer order.
The Clearwater **Clear Water Surface** and **Shallow Ripples and Caustics** artwork also starts with
gentle motion. Other water artwork can use its recommended **Water shimmer** or **Flowing water**
technique. Press Play to see motion in the preview.

---

## The four layers

Every scene is built from exactly four layers, painted back to front:

1. **Background** — the painted plate that establishes the place, horizon and light.
2. **Middle-ground** — trees, structures, rock, water; the substance of the world.
3. **Foreground** — grass, flowers, ferns, ground detail. Fully animatable, and allowed to
   extend past the canvas edge; only the visible part is rendered.
4. **Atmosphere, Rooms & Imagination** — effects, room views and interior furnishings. Effects are
   universal; room artwork follows the chosen look. Room and effect order can be changed on canvas.

**A world has exactly one background.** Choosing a new background replaces the old one, and a background
cannot be duplicated. Every other element (trees, rocks, bushes, flowers, effects) can repeat as often as you need.

Artwork is gated by the selected artistic style, including rooms on Layer 4. Incompatible artwork is
not shown in the library, while effects remain available with every look. Layer 4 also carries five
pixie-dust glitter overlays — **Pixie Dust Swirls** (strings of glitter whose heads trace looping
twirls), **Glitter Streamers** (beaded ribbons flowing in waves), **Fairy Ring Dance** (spinning,
breathing rings of dust), **Twirling Dust Columns** (corkscrew dust devils) and **Wandering
Stardust** (loose motes curling around the screen) — each fully loopable and editable in the
inspector.
Press **F9** (or File → Present mode) to step inside a creation: fullscreen, chrome-free looping
playback with a single quiet exit chip. Work autosaves to the browser shelf every 45 seconds and
whenever the tab is hidden, and reopens from the Projects dialog; if your system prefers reduced
motion the preview starts paused instead of playing.

---

## What is implemented

**Asset library** — 347 assets across 5 styles, with fairy/Norse/Chinese/Japanese-inspired vistas,
a celestial observatory, a moonlit waterside and a lotus sanctuary with animated water, a timber
meditation pavilion and close-up lotus blossoms. Placeable Chinese-inspired moon gate, Japanese-inspired
stone lantern and Norse-inspired dragon boat add garden and waterside details. A fairy mushroom cottage, Japanese-inspired garden bridge and Norse-inspired stone well are also separately placeable.
Detailed close-up flowers, including dahlias, sunflowers and white orchids, add foreground variety.
Thirteen placeable creatures — a white stag, red fox, mute swans, koi, butterflies, a great owl, a rabbit,
a squirrel, mallards, a hedgehog, a fawn, a frog and a flock of songbirds — each arrive still, with optional
breathing, swimming or fluttering motion.
**Frostfall** is an independently painted winter look — snow-laden pines, frosted bare branches, a
frozen lake and an icicle pavilion — rather than another recolouring of the fantasy plates.
**Clearwater** is a fifth, ultra-realistic photographic look built around water: refraction, caustics on
the bed, and a **sparkle** animation that scatters specular glints which wink in and out across wet
surfaces. It also ships ten photographic scene backgrounds for meditation and open-air worlds:
**Zen Pond**, **Misty Dawn Lake**, **Bamboo Stream**, **Zen Garden**, **Wildflower Meadow**,
**Lavender Fields**, **Creek Meadow**, **Granite Tarn**, **Rocky Coast Cove** and **Still Forest
Pool**. Each starts animating as soon as it is placed, and each moves only where nature would:
lakes, pools and the sea carry small travelling shimmer waves inside a rigged band; the bamboo
stream and the meadow creek use a directional flow that runs downstream; the two meadows get a
gentle breeze limited to the grass and flower band. Sky, rock and raked gravel never move, and
every scene loops seamlessly. Photographic **grass and flower cutouts** — meadow tufts, wild and
feather grasses, fescue, sedge, dew blades, and wildflower clumps of poppies, cornflowers,
lavender, bluebells, buttercups, daisies, thistles, yarrow, clover, foxglove and chamomile —
place into any look as detailed foreground plants, grown as irregular field clumps with a planted
soil base so they sit naturally in a scene. Each is keyed off its studio backdrop and rigged with a calm
**grass-wind** sway: one slow bending wave that lags with height, so tips travel a few percent of
the width while the base stays planted. They sway; they never wobble. Ten photographic **trees** —
English oak, silver birch, Scots pine, weeping willow, copper beech, hawthorn, rowan, flowering
cherry, aspen and olive — stand as whole-tree cutouts with sky holes through the crown; each crown
sways in slow gusts on a `canopy-sway` rig while the trunk below its pin line stands perfectly still. A photographic **Clearwater Falls** pours over a mossy cliff: the painted water itself is
lifted onto its own layer and pushed down the cascades while the rock stays still, with spray,
hovering mist and plunge-pool ripples. It ships five photographic rooms — modern Japanese and open-plan, in wood and stone, with
floor-to-roof glass that keys out into a real opening — each with a fireplace whose fire is optional,
plus minimal oak and linen furniture. Two placeable photographic fireplaces have the same optional
fire, now with glowing embers lifting off the bed and dying as they rise. Five photographic figures
in meditation — seated, seated in profile, standing prayer, tree and mountain poses — arrive still,
with slow breathing as an option. Eight room views reveal the current composition
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

**Effects** — 60 universal atmospheric effects in 7 families, plus 8 theme presets, including Norse,
Greek, Chinese-inspired fantasy, a Japanese moon garden, fairy tale, and a mythic zodiac. The new
**Spiritual & Mystical Overlays** category offers 25 individually placeable vector ornaments across
eight subcategories, with materials, movement, rotation, glow, particles and timing controls. Select
Layer 4 to drag or click ornaments; use Properties and Animation to edit each one. Their simulated
materials and perspective are 2D artistic interpretations, not religiously authoritative diagrams.

**Export** — PNG / JPEG / WebP stills with zero editor UI in the output. MP4 (H.264) and WebM video
via WebCodecs with a MediaRecorder fallback. 16:9, 9:16, 1:1, 4:3, 21:9 and custom aspect ratios;
720p / 1080p / 1440p / 4K; 24 / 30 / 60 fps; four quality tiers with a live size estimate, progress
and cancellation.

**Sound** — an import slot, not a library. The app ships no audio files. A track you import plays in
the preview, loops with a configurable crossfade at the join, and is embedded in the `.sceneproject`
so it reopens with the scene. Exported video is still silent.

**Meditation** — five ambient beds synthesised live with WebAudio (water, wind, rain, birdsong and
crickets), mixed per scene with a master level in *View ▸ Ambience & breathing* or from the Sound
panel; no audio assets, no network, no AI. Present mode (F9) starts the mix automatically and adds a
small bar with sound, breathing-guide, mix-settings and elapsed-time controls. Because the editor
chrome is hidden there, any warning the viewer needs — a browser with no audio stack, a session that
ended — is spoken in that bar rather than in a toast. The breathing guide is a ring that expands on the inhale, rests on the hold and settles on
the exhale, in three patterns: calm 4-6, box 4-4-4-4 and coherent 5-5. An optional session timer
(5/10/20/30 minutes) closes with a soft bell and a quiet card, once, without interrupting the scene.
Ambience is live only — nothing is recorded into exported video — and where a browser has no
WebAudio the app says so and the picture carries on unchanged.

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
exporting a PNG. `tests/meditation.test.ts` checks the breathing phases and the soundscape
schedules (phrase gaps, whistle registers, droplet and chirrup rates) as pure mathematics, drives the
engine against a mock audio context to prove that stopping releases every source and the context,
and confirms it degrades to silence where there is no audio stack at all.

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
tests/         203 tests across 19 files
docs/          architecture, assets, limitations
```
