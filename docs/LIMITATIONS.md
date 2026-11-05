# Limitations and verification status

This document exists so that nothing in the README can be read as a stronger claim than the evidence
supports.

## What was verified against real pixels

The sandbox has Node 22 and `@napi-rs/canvas` (a native Skia binding), so the **real** compositor,
animation engine, Loop Manager and effect library were exercised headlessly.

| Claim | Evidence |
| --- | --- |
| The demo world composes correctly | `npm run render-check` → `.render-check/demo-t0.png`, inspected visually |
| The master cycle returns to its exact start | **0 differing subpixels** between t=0 and t=48 s at 1280×720 |
| The scene actually animates | about 10.9 % of pixels change at mid-cycle |
| All 52 effects are exactly periodic | `u=0` vs `u=1` compared per effect, byte-identical |
| Lounge windows reveal the current world | transparent center pixel-identical to the background; opaque wall area changes |
| No obvious chroma-key residue | opaque key-colour pixel scan across every object |
| Trees stay planted | trunk-base displacement asserted < 0.001 in tests |
| Grass roots do not slide | base-row `dx` < 0.001 |
| Warping is local | sky above a shimmering lake is **pixel-identical** to the unwarped plate |
| Water shimmer stays in the water | max delta **1/255** outside every background's declared region, 182/255 inside |
| Every style composes | one rendered world per background plate → `.render-check/worlds.png` |
| Rendering never mutates the scene | deep-equality assertion before/after render |
| The UI really works | 19 jsdom tests mount the real `App` and drive it |
| Still export produces a real file | 640×360 PNG > 5 kB asserted in the UI test |
| Projects round-trip | scene → ZIP → scene, including embedded asset bytes |

`npm test` → **202 passed** across 19 files. `npm run typecheck` → clean under `strict`,
`noUnusedLocals` and `noUnusedParameters`. `npm run build` → succeeds.

## What was NOT verified — video export

**No MP4 or WebM file was ever produced during this build.**

The sandbox has no Chromium (0 matching shared libraries in `ldconfig -p`), no ffmpeg, and browser
download hosts are blocked by the network allowlist. Installing a headless browser was attempted
and abandoned. Consequently:

- `VideoEncoder.isConfigSupported()` was never called for real.
- The H.264 codec-string probe order (`avc1.640034` → `avc1.42003e` → `avc1.42001f`) is reasoned from
  the spec, not observed on hardware.
- `mp4-muxer` output was never decoded or played back.
- The MediaRecorder fallback was never run.
- `showSaveFilePicker`, OPFS streaming and storage-quota behaviour were never exercised.
- Actual encode throughput, and therefore whether 4K/60 fps is achievable, is unknown.

**What *is* verified about video:** the part that makes long exports possible is pure logic and is
tested exhaustively. `tileSequence()` has 8 dedicated tests covering exact frame counts at 15 s,
1 min, 5 min, 10 min, 30 min and 60 min; strictly increasing timestamps with no gaps; a key frame at
every repeat boundary; no reference outside the encoded cycle; correct partial final cycle; video
shorter than one cycle; and the non-tileable fallback. `VideoRenderer.plan()` is tested for the
tiling decision, the windowed-effect refusal, duration/cycle independence and honest reporting of a
static scene.

**Practical consequence:** treat video export as *implemented and logically tested, but not
field-tested*. The first thing to do on real hardware is export a 15-second 720p MP4 and play it in
VLC, then a 5-minute export and check the loop boundary in an editor. The code reports success only
after `finalize()` yields a non-zero byte count, so a silent failure should surface as an error
rather than a broken file — but that error path itself is untested against a real encoder.

## Known functional constraints

**Library size.** 306 assets across 5 styles (32 backgrounds / 83 middle / 191 foreground), which
exceeds the brief's starter targets. Fairy, Norse, Chinese-inspired, Japanese-inspired, celestial
observatory, waterside and lotus sanctuary vistas, landmarks and foreground accents have Enchanted, Moonlit and Autumn
palette variants, but the
latter two remain colour grades rather than independently painted styles. Frostfall is the exception: it is
painted from its own plates, though it is a small collection (10 outdoor pieces) and its room interiors are
shared with the Enchanted look rather than repainted, since a room has no season. The general fern, bush,
ivy and pebble ground covers are still procedurally assembled from foliage and rock chips; the story-
specific foreground accents are painted plates. This is enough to build varied scenes but is not a
large commercial library. Adding a genuinely independent style means
commissioning or painting a new plate set, not more grading.

**Hearth regions are measured, not guessed.** Each fireplace animation flicks painted flames inside a
declared rectangle. For the Clearwater rooms that rectangle was located by finding the flame pixels
in the finished plate, and a test re-measures it against the shipped file, so the fire cannot drift
onto a wall unnoticed.

**Master cycle cap.** The LCM of all animation cycles is capped at 60 s. With many co-prime cycle
lengths the true LCM can exceed this; the Loop Manager snaps cycles to a 0.5 s grid to keep the LCM
small and reports `exact: false` when it cannot guarantee a perfect return. The UI shows this
rather than hiding it.

**Tiling requires exactness.** A 60-minute export is only cheap if the scene is exactly periodic and
no effect has a start/stop window. Otherwise every frame is rendered, which at 1080p/30 fps means
108 000 frames — potentially hours. The export dialog states the frame count before you commit.

**Memory ceilings.** Still export is capped at 40 MP, video at 12 MP and an estimated 700 MB for the
in-memory sink. Long exports prefer a file handle, then OPFS. The OPFS path checks
`navigator.storage.estimate()` first and fails with an actionable message rather than dying at 90 %.

**Browser support.** WebCodecs (Chrome/Edge 94+, Safari 16.4+) gives the good path. Firefox and older
browsers fall back to MediaRecorder, which produces WebM, cannot guarantee frame-exact duration, and
cannot tile encoded samples — so long exports there are slow and the loop is only as seamless as the
scene's own periodicity. The export dialog reports which path will be used.

**4K is offered, not promised.** 4K UHD is within the 12 MP budget, but whether a given machine can
encode it at 60 fps depends entirely on its hardware encoder. The capability probe will refuse a
configuration the browser reports as unsupported.

**Performance figures are from a native canvas, not a browser.** ~24 ms/frame at 1280×720 on 2 vCPUs
in `render_check`. Browser performance with GPU-accelerated Canvas2D will differ, probably
favourably, but this was not measured.

## Deliberate omissions

- **No `src/scene/lighting.ts`.** Lighting lives in `compositor.applyLighting` and `autoCompose`;
  a separate module would have been an empty seam.
- **No ffmpeg.wasm.** It is a ~30 MB dependency that would still not give frame-exact H.264 muxing
  better than `mp4-muxer`, and it would violate the "works on ordinary hardware" goal.
- **Sound in export.** An imported track plays in the preview only. Exported MP4/WebM video is silent,
  because mixing audio would need an audio encoder track and a decode-and-mix pass that have not
  been built or tested on real hardware. The sound panel says so.
- **Sound in the browser, not verified in a real browser.** Playback, the crossfade at the loop join
  and autoplay handling are logic-checked only. Browsers may block playback until a user gesture;
  the panel shows a notice when that happens. The project round trip is tested: the bytes travel
  inside the `.sceneproject`, and the settings come back unchanged.
- **Seasons, day/night cycles, weather systems, water simulation and generated audio ambience** are not
  implemented. The data model anticipates them (per-node adjustments, the lighting block, effect
  parameters) but the brief said not to delay the core product for them.
- **No multi-select, no grouping, no keyframe timeline.** Animation is procedural per node with a
  loop length, not a keyframed timeline. This is a design choice consistent with the brief's
  "natural, non-mechanical, desynchronised motion", but it means you cannot hand-animate a specific
  path.

## Corrections made during the build

These were real bugs found by looking at output, not by reading code:

1. **Pooled scratch sizing** — callers used `canvas.width` instead of the requested logical size,
   stretching every crop. Scratch now carries explicit `w`/`h`.
2. **Strip-warp tearing on water** — horizontal bands tore along band edges; water now uses a mesh.
3. **Mesh hairline seams** — fixed with a ~1.6 device-pixel bleed between triangles.
4. **Non-periodic rotations** — fractional turn multipliers and `angle + TAU` float noise broke
   exactness; all continuous rotations are now `TAU * frac(turns * u)`.
5. **Right-panel render conflict** — three panels wrote to the same DOM node on every store event;
   each now has an `active` flag.
6. **`resizeCanvas` semantics** — used `min(sx, sy)`, shrinking objects to ~0.32× relative height on
   16:9 → 9:16. Now scales by height ratio, matching how `defaultScale` is defined.
7. **Project portability** — `readProject` skipped re-registering built-in assets, so a project
   depended on the local library. It now always prefers embedded bytes.
8. **Sky seams from water shimmer** — the region mask was a hard 0/1 step (tearing at the border)
   and undistorted rows were still drawn as antialiased triangles (faint grid lines across the sky).
   Fixed with a smooth `regionMask` and a flat-band fast path in `meshWarp`; the sky is now
   pixel-identical to the unwarped plate.
9. **Mesh bands straddling the region edge** — a band whose top row was inside the water and bottom
   row outside dragged stationary foliage along. Fixed by passing the region edges as `breaks` so
   they land exactly on mesh row lines.
10. **Phase-dependent slice boundaries** — the flat-band test used the instantaneous displacement, so
   a band passing through zero flipped between triangle and slice rendering, shifting the slice
   boundary and re-resampling the still foreground (max delta 43/255 where nothing should move).
   Fixed by declaring an `active` v-range and deciding the split on geometry alone. Outside the
   water region the max delta is now 1/255.
11. **"Preview this effect only" previewed the whole layer** — the control did not do what it said.
   Added `RenderOptions.onlyNode` for true single-node isolation, kept layer solo as a separate
   button, made solo override the hidden flag, and dropped a solo whose subject gets deleted.


## Waterfalls and themed room views

`waterfall-flow` uses an artwork-derived, cached multi-stream water mask and renders high-contrast
falling curtains, droplets, plunge-pool ripples, splash arcs, and broad rising/drifting mist. The
wide enchanted, moonlit, and autumn waterfalls are auto-enabled and showcased without a bridge or
foreground clutter over their impact zone. Tests cover downward optical flow, scene-region locality,
mid-cycle motion, splash/mist turbulence response, exact loop boundaries, and auto-enabled placement.

The Layer 3 room views are keyed transparent foreground overlays in all three styles. Their openings
show the composition underneath. In addition to the original lounge, a reading room and a window-seat
room each have an automatically flickering painted hearth and a steaming cup. A modern penthouse and
a futuristic lounge add large panoramic windows, with modular furniture and a contemporary fireplace
available as separate props. Two present-day oak-beamed rooms with tiled floors and wooden doors,
plus a separate oak door, lounge chair and table, complement the futuristic options. An asymmetric
brick-and-timber room adds two window openings on adjoining walls and a sloped roof. The loose
oak bookshelf, potted fig and floor lamp are static placeable props. The fire and steam
are stylized animation rather than video or physical
simulations. `tests/interiors.test.ts` verifies window transparency, local fire motion, rising steam,
and exact loop boundaries.

Layer 4 now also includes a moving **Mythic Zodiac Wheel** and **Floating Lanterns**, alongside the
existing rune, constellation, rain, windborne-petal and mist effects. A Japanese moon-garden theme
and a separate mythic zodiac preset are available. These are clearly framed as stylized fantasy
starting points, not culturally authoritative reconstructions.

## Spiritual & mystical overlays

The 25 new overlays are lightweight Canvas vector effects integrated into the existing compositor,
not image files or true 3D objects. Their gold, chrome, glass and holographic looks, axis tilt and
depth are visual approximations; symbolic designs are artistic interpretations. Tests exercise their
materials, motion, loop boundaries, window fades, 16:9 and 9:16 rendering, style independence,
project round-tripping and the export compositor/tiling plan. Actual browser MP4/WebM export and
playback have not been tested.
