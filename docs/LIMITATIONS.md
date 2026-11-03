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
| The scene actually animates | 10.96 % of pixels change at mid-cycle |
| All 22 effects are exactly periodic | `u=0` vs `u=1` compared per effect, byte-identical |
| No chroma-key residue | magenta-pixel scan across every asset |
| Trees stay planted | trunk-base displacement asserted < 0.001 in tests |
| Grass roots do not slide | base-row `dx` < 0.001 |
| Warping is local | sky above a shimmering lake is **pixel-identical** to the unwarped plate |
| Rendering never mutates the scene | deep-equality assertion before/after render |
| The UI really works | 12 jsdom tests mount the real `App` and drive it |
| Still export produces a real file | 640×360 PNG > 5 kB asserted in the UI test |
| Projects round-trip | scene → ZIP → scene, including embedded asset bytes |

`npm test` → **81 passed** across 7 files. `npm run typecheck` → clean under `strict`,
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

**Library size.** 25 assets across 2 styles, and the second style is a colour grade of the first.
Backgrounds are at 4 of the 5 the brief asked for. There are no painted flower or fern plates —
those foreground plants are procedurally composed from foliage chips. This is enough to build
varied scenes but is not a large commercial library.

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
- **Seasons, day/night cycles, weather systems, water simulation and audio ambience** are not
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
