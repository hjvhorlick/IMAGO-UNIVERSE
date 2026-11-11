# Changelog

All notable changes to IMAGO UNIVERSE are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Synthesised ambience**: five beds — water, wind, rain, birdsong and
  crickets — generated live with WebAudio and mixed per scene (master plus one
  level per bed) in *View ▸ Ambience & breathing*. No audio files, no network,
  no AI; the mix travels inside the `.sceneproject` as numbers.
- **Breathing guide**: a ring in present mode that expands on the inhale, rests
  on the hold and settles on the exhale, in calm 4-6, box 4-4-4-4 or coherent
  5-5, with the phase named underneath.
- **Session timer**: an optional 5/10/20/30-minute session that ends with a soft
  bell and a single quiet card offering to stay or to leave present mode.
- **Present bar**: sound, breathing-guide, mix-settings and elapsed-time
  controls that fade in at the bottom of present mode, so the scene stays
  chrome-free until you need them. Messages that matter while presenting — a
  browser with no audio stack, a finished session — appear in the bar, because
  status toasts are hidden there.
- The Sound panel now also reports the synthesised mix and links to its
  settings, so imported audio and generated ambience are found in one place.
- **Present mode** (F9): fullscreen, chrome-free looping playback of the scene
  with a single exit chip; Esc or F9 returns to the editor.
- Autosave now also fires when the tab is hidden, on top of the 45-second
  interval, so a closed tab loses nothing that the shelf can keep.
- Reduced-motion support: with the OS `prefers-reduced-motion` setting the
  preview starts paused and interface transitions are disabled.
- Accessibility: status toasts are a polite live region, icon-only top-bar
  controls carry labels, and keyboard focus is always visible.

## [1.0.0] - 2026-11-09

First full release: a complete four-layer world composer with a photographic
realistic look, seamless animation everywhere, and image/video export.

### Added
- **Editor** — four layers (Background, Middle, Foreground, Atmosphere),
  style-gated asset library with world categories and previews, inspector with
  per-effect parameters, undo/redo with a visual history, keyboard shortcuts,
  theme presets, room views through eight painted and photographic interiors,
  project save/load to file, and a welcome dialog.
- **Asset library** — 347 assets across five looks (Enchanted Realms, Moonlit
  Reverie, Harvest Season, Clearwater, Frostfall): vistas, gardens, waters,
  rooms, furniture, creatures, flowers, plus the photographic Clearwater set
  (ten meditation scene backgrounds, twenty field-grown grass and flower
  cutouts, ten trees, a cascade, five glass rooms and five meditation figures).
- **Motion** — rig-driven water (shimmer bands, directional stream flow,
  refraction and caustics, a photographic waterfall with spray and mist),
  research-based songbird flocking with per-bird flap-glide cycles, calm
  grass-wind sway with planted bases, canopy sway with rigid trunks, breathing
  creatures, and 60 universal atmosphere effects in 7 families — including five
  pixie-dust glitter overlays (swirls, streamers, fairy rings, dust columns,
  wandering stardust). Every animation loops seamlessly.
- **Export** — PNG stills and looped video as H.264 MP4 (WebCodecs) with a
  WebM MediaRecorder fallback, at selectable resolution and frame rate.
- **Engineering** — deterministic asset pipeline (`tools/prepare_assets.py`)
  with chroma/difference keying, autocrop and de-fringe; manifest-driven
  library with an illustrated asset catalog; 258 vitest tests including
  pixel-level loop-exactness, region-stillness and cutout-alpha assertions;
  CI workflow running typecheck, tests and build on push and pull request.

### Fixed
- Main-thread pinning while images load (responsive UI with loading feedback).
- Sub-row motion sliver above masked waterlines in the mesh warp.
- Canopy-sway bark flicker caused by per-frame slice/triangle mode flips.
