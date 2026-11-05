# Architecture

Imago Universe is a client-only TypeScript application. There is no backend, no account system and
no network call at runtime after the asset manifest and WebP files are fetched from the same origin.

## Design rules

1. **Animation never depends on export.** The animation engine is a pure function of time. The
   preview renderer, still renderer and video renderer all consume the same evaluation, so what you
   see playing is what you get in the file.
2. **The compositor never draws editor UI.** Handles, guides and selection live on a separate
   overlay canvas. Export reuses the compositor directly, so chrome cannot leak into output.
3. **Solo preview is a render filter, not a scene edit.** `RenderOptions.onlyNode` draws exactly one
   node (overriding its hidden flag, since the user explicitly asked to see it); `layers` draws one
   whole layer. Neither mutates the scene, and a solo whose subject is deleted is dropped so the
   canvas cannot stay silently empty.
4. **Effects hold no inter-frame state.** Every effect is `f(u)` where `u ∈ [0,1)` is the loop phase.
   Randomness comes from a hash of `(seed, particle index, channel)`, never from a running RNG. This
   is what makes exact looping and frame-accurate seeking possible.
5. **Originals are never modified.** Crops, tints, warps and grades are all applied at draw time.
6. **Layer 4 is universal.** Style gating applies to layers 1–3 only.

## Module map

```
core/
  types.ts          Scene, SceneNode, AnimationSettings, EffectInstance, AssetMeta, defaults
  store.ts          Single source of truth. Selection, history, events, dirty tracking.
  util.ts           clamp/lerp/rad, mulberry32 rng, hashString, periodic(), gcd/lcm, deepClone

assets/library.ts   Manifest load, style gate, search/filter, favourites, user imports (IndexedDB)
project/idb.ts      IndexedDB wrapper: importedAssets | projects | meta

scene/
  sceneModel.ts     createScene, createAssetNode, grounding, paint order, resizeCanvas, fitBackground
  composition.ts    autoCompose / regenerate / reground / sortByDepth (seeded, respects locks)
  styleManager.ts   reference collection, style stats, switchStyle, clash detection
  demoScene.ts      The composed world the app opens on

animation/
  loopManager.ts    Cycle analysis, grid snapping, LCM master cycle, exactness report, plan()
  animationEngine.ts  evaluate(scene, node, t) -> NodeRenderState (transform + warp + scroll + glow)
  effects.ts        52 effect definitions, parameter schemas, 8 theme presets
  spiritualOverlays.ts  25 modular vector ornaments and their shared periodic motion controls
  effectPrimitives.ts  Deterministic per-particle randomness, shapes, life envelopes

render/
  imageCache.ts     Lazy ImageBitmap decode, LRU eviction at 420 MB
  deform.ts         stripWarp, meshWarp, texturedTriangle, pooled scratch canvases
  compositor.ts     The whole picture: assets, shadows, warps, effects, lighting
  previewRenderer.ts  rAF loop, DPR-aware, longest side <= 1400 px, solo-layer support
  stillRenderer.ts    One frame at export resolution, <= 40 MP
  videoRenderer.ts    WebCodecs encode, loop tiling, muxing, sinks, MediaRecorder fallback

export/exportManager.ts  Presets, dimensions, capability text, still/video orchestration
project/projectFormat.ts  .sceneproject ZIP: packageProject / readProject / migrate
project/projectShelf.ts   Browser-local project list

ui/                 app shell, stage (zoom/pan/handles), asset / layers / inspector / scene
                    panels, dialogs, DOM helpers, design system
```

## Data flow

```
                 ┌─────────── Store (scene + selection + history) ───────────┐
                 │                                                          │
   user input ───┤                                                          ├─── events
                 │                                                          │      │
                 └──────────────────────────────────────────────────────────┘      │
                                                                                   ▼
   AssetLibrary ──► Compositor ──► PreviewRenderer ──► #scene-canvas        UI panels re-render
        │               ▲                                                   Stage overlay draws
        │               │                                                   handles on #overlay-canvas
   ImageCache ──────────┤
                        │
   LoopManager ──► AnimationEngine ──► NodeRenderState
                        │
                        └──► Effects (pure f(u))
```

The Store is the only mutable state. Panels never write to each other; they emit store mutations and
re-render from events. `App.renderRight()` sets an `active` flag on each right-hand panel so only the
visible one rebuilds its DOM.

## Render pipeline (per frame)

1. Clear, fill backdrop, optionally clip to canvas bounds.
2. Walk nodes in paint order: layer 1 → 4, then `node.order` within a layer.
3. **Assets:** resolve crop → optional tint/flatten scratch → CSS filter (brightness, contrast,
   saturation, hue, blur) → strip or mesh warp → region scroll → additive glow. A contact shadow is
   drawn first as a blurred black silhouette sheared at the ground line.
4. **Effects:** `isActive()` window check, then `draw(ctx, {w,h,u,t,params,seed,scale})` with the
   effect's blend mode.
5. **Lighting pass:** soft-light warmth, additive haze, god rays keyed to the master cycle,
   multiply vignette.

### Deformation

- `stripWarp` — horizontal bands, each offset independently. Used for grass and stems where the
  base must stay planted: displacement scales as `(1-v)^1.7`, so the root row never moves.
- `meshWarp` — a grid of textured triangle pairs. Used for water, canopies and flags where bands
  would tear. Adjacent triangles overlap by ~1.6 device pixels to hide antialiasing seams.

  **Flat-band fast path:** rows that cannot move are coalesced into a single `drawImage`. This is
  both faster and visually necessary — without it, a water shimmer leaves faint mesh seams across
  the *sky*, which is not moving at all.

  Two details make this correct rather than merely fast:

  - **`breaks`** — the caller passes the region's v-edges so they land exactly on a mesh row line.
    Otherwise a triangle band straddles the boundary and drags stationary artwork along with the
    moving part.
  - **`active`** — the caller declares the v-range outside which the field is zero *at every phase*.
    The slice/triangle split is then decided by geometry alone. If it were decided by the
    instantaneous displacement, a band whose displacement passes through zero would flip rendering
    mode between frames, shifting the slice boundary and re-resampling artwork that should be
    perfectly still — visible as a faint shimmer in the foreground.

- Region masks fade smoothly to exactly zero at the region border (`regionMask`). A hard 0/1 mask
  tears the artwork between two adjacent mesh rows and defeats the flat-band fast path.

Together these give a measured **max delta of 1/255 outside a background's water region** (rounding
on the antialiased boundary row) against 182/255 inside it.

### Scratch pooling

`acquireScratch(w, h)` returns a pooled canvas that may be *larger* than requested. Always use the
returned `w`/`h`, never `canvas.width`/`canvas.height` — using the backing size stretches crops.

## Looping

`LoopManager.analyse(scene)`:

1. Collect every enabled animation's `loop` seconds.
2. Snap each to the 0.5 s grid (`LOOP_GRID`).
3. Master cycle = LCM of the snapped values, capped at `MAX_MASTER = 60 s`.
4. **Re-check exactness after snapping** — a value that was exact before snapping may not be after.
5. Return `{master, exact, animated, cycles, snapped}`.

`plan(duration, master, fps)` returns `{cycleFrames, totalFrames, repeats, remainder}`.

Every continuous rotation is computed as `TAU * frac(turns * u)` so that floating-point drift cannot
accumulate and the value at `u=1` is bit-identical to `u=0`. Particle effects use `life()` for
desynchronised lifetimes and `envelope()` to force alpha to zero at both ends of a particle's life.

## Video export

```
plan → canTile = report.exact && !windowed && repeats >= 1

canTile:   encode cycleFrames frames → tileSequence() repeats those encoded chunks
otherwise: encode all totalFrames frames

sink priority: user-chosen file handle → OPFS stream → ArrayBuffer in memory
codec probe:   avc1.640034 → avc1.42003e → avc1.42001f → WebM/VP9 → MediaRecorder
```

`tileSequence()` is a pure generator and is unit-tested independently of the encoder: frame count,
monotonic timestamps, key frame at every repeat boundary, no reference outside the encoded cycle,
partial final cycle, and video shorter than one cycle.

Backpressure: the encoder is awaited whenever `encodeQueueSize > 8`. A key frame is forced every
`fps * 2` frames. Success is reported only after `muxer.finalize()` returns a non-zero byte count.

## Project format

`.sceneproject` is an uncompressed ZIP (level 0 — the WebP payloads are already compressed):

```
project.json          { format: 'imago.sceneproject', version: 1, generator, savedAt, scene }
assets/manifest.json  metadata for every asset the scene references
assets/files/<id>.webp  the actual bytes, including user imports
audio/<id>.<ext>      the imported sound track, present only if the scene has one
preview.jpg           optional thumbnail
README.txt            human-readable description of the package
```

`readProject` validates the format, warns on a newer version, runs `migrate()` to fill defaults, and
**always re-registers the embedded blobs and metadata**, even for built-in asset ids. A project
therefore renders identically on a machine that has never seen the library.

Sound follows the same rule. `packageProject` takes the track's bytes as an argument (the caller
loads them from the audio store), and `readProject` returns them as `LoadedProject.sound`. The app
then writes them to the audio store before swapping the scene, so the preview player finds them.
`migrate()` sanitises the `audio` block and drops it if it has no id, so a malformed file opens silent
rather than half-configured.

## Extension points

| To add | Touch |
| --- | --- |
| A new artistic style | `assets-src/<style>/`, `tools/prepare_assets.py`, manifest `styles[]` |
| A new asset | Drop a plate in `assets-src/`, re-run `npm run assets` |
| A new animation technique | `AnimationType` in `types.ts`, a case in `animationEngine.evaluate` |
| A new atmospheric effect | One entry in `EFFECTS` with a param schema and a pure `draw` |
| A new theme preset | One entry in `THEME_PRESETS` |
| A new export container | A sink + muxer branch in `videoRenderer.ts` |

Seasons, day/night, weather, water simulation and generated audio ambience are all anticipated by the data
model (per-node adjustments, the lighting block, effect parameters) but are deliberately not
implemented yet.
