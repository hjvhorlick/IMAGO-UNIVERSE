/**
 * Rendering acceptance tests, run against a real 2D canvas implementation.
 * These check the guarantees the product makes about motion and looping.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { EFFECTS } from '../src/animation/effects';
import { effectDefaults } from '../src/animation/effects';
import { AnimationEngine } from '../src/animation/animationEngine';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { meshWarp } from '../src/render/deform';
import { AssetLibrary } from '../src/assets/library';
import { createScene, createAssetNode, fitBackground } from '../src/scene/sceneModel';
import { buildDemoScene } from '../src/scene/demoScene';
import { makeEffectNode } from '../src/ui/inspector';
import { DEFAULT_LOOP, makeAnimation } from '../src/core/types';
import type { AnimationType, Scene } from '../src/core/types';
import { testLibrary } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');

type Ctx = ReturnType<Canvas['getContext']>;

function ctx2d(w: number, h: number) {
  const cv = createCanvas(w, h) as Canvas;
  const ctx = cv.getContext('2d');
  return { cv, ctx };
}

function pixels(arg: { cv: { width: number; height: number }; ctx: Ctx }) {
  return arg.ctx.getImageData(0, 0, arg.cv.width, arg.cv.height).data;
}

describe('painted foreground artwork', () => {
  it('preserves the red, pink and golden petals in the blue-keyed close-up flowers', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
    const cases = [
      { name: 'wild-poppies', match: (r: number, g: number, b: number) => r > 120 && r > g * 1.5 && r > b * 1.5 },
      { name: 'rose-peonies', match: (r: number, g: number, b: number) => r > 150 && r > g * 1.2 && b > g * 1.05 },
      { name: 'lotus-flowers', match: (r: number, g: number, b: number) => r > 150 && r > g * 1.2 && b > g * 1.05 },
      { name: 'golden-irises', match: (r: number, g: number, b: number) => r > 150 && g > 90 && b < g * 0.75 },
      { name: 'scarlet-dahlias', match: (r: number, g: number, b: number) => r > 120 && r > g * 1.5 && r > b * 1.5 },
      { name: 'golden-sunflowers', match: (r: number, g: number, b: number) => r > 150 && g > 90 && b < g * 0.75 },
      { name: 'white-orchids', match: (r: number, g: number, b: number) => r > 190 && g > 180 && b > 170 },
    ];
    for (const { name, match } of cases) {
      const meta = manifest.assets.find((a: { style: string; file: string }) =>
        a.style === 'enchanted' && a.file.endsWith(`/${name}.webp`));
      expect(meta, `enchanted/${name} is in the manifest`).toBeTruthy();
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const { cv, ctx } = ctx2d(img.width, img.height);
      ctx.drawImage(img, 0, 0);
      const data = pixels({ cv, ctx });
      let petals = 0, blueResidue = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (match(r, g, b)) petals++;
        if (b - Math.max(r, g) > 70) blueResidue++;
      }
      expect(petals, `${name} lost its colourful petals`).toBeGreaterThan(10000);
      expect(blueResidue, `${name} retained blue background`).toBe(0);
    }
  });

  it('keeps the keyed objects transparent around their full boundary in every palette', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      for (const name of ['celestial-arch', 'starflowers', 'lantern-bridge', 'river-reeds',
        'woodland-foxgloves', 'wild-roses', 'woodland-anemones', 'wild-poppies', 'rose-peonies', 'golden-irises',
        'modern-sectional', 'future-lounge-chair', 'modern-fireplace',
        'contemporary-oak-door', 'contemporary-oak-chair', 'contemporary-oak-table',
        'oak-bookshelf', 'indoor-fig', 'oak-floor-lamp', 'lotus-flowers', 'lotus-pavilion',
        'chinese-moon-gate', 'japanese-stone-lantern', 'norse-dragon-boat',
        'fairy-mushroom-cottage', 'japanese-garden-bridge', 'norse-stone-well',
        'scarlet-dahlias', 'golden-sunflowers', 'white-orchids']) {
        // Look the file up through the manifest rather than hard-coding the folder layout.
        const meta = manifest.assets.find((a: { style: string; file: string }) =>
          a.style === style && a.file.endsWith(`/${name}.webp`));
        expect(meta, `${style}/${name} is in the manifest`).toBeTruthy();
        const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
        const { cv, ctx } = ctx2d(img.width, img.height);
        ctx.drawImage(img, 0, 0);
        const data = pixels({ cv, ctx });
        for (let x = 0; x < cv.width; x++) {
          expect(data[(x * 4) + 3], `${style}/${name} top`).toBe(0);
          expect(data[((cv.height - 1) * cv.width + x) * 4 + 3], `${style}/${name} bottom`).toBe(0);
        }
        for (let y = 0; y < cv.height; y++) {
          expect(data[(y * cv.width) * 4 + 3], `${style}/${name} left`).toBe(0);
          expect(data[(y * cv.width + cv.width - 1) * 4 + 3], `${style}/${name} right`).toBe(0);
        }
      }
    }
  });
});

describe('atmospheric effects', () => {
  it('every effect draws something visible', () => {
    for (const def of EFFECTS) {
      const { cv, ctx } = ctx2d(200, 120);
      def.draw(ctx as never, {
        w: 200, h: 120, u: 0.4, t: 0.4 * def.defaultLoop,
        params: effectDefaults(def.id), seed: 12, scale: 1,
      });
      const data = pixels({ cv, ctx });
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit++;
      expect(lit, `${def.id} produced no visible output`).toBeGreaterThan(20);
    }
  });

  it('every effect is exactly periodic (u=0 identical to u=1)', () => {
    for (const def of EFFECTS) {
      const params = effectDefaults(def.id);
      const draw = (u: number) => {
        const { cv, ctx } = ctx2d(160, 100);
        def.draw(ctx as never, { w: 160, h: 100, u, t: u * def.defaultLoop, params, seed: 99, scale: 1 });
        return pixels({ cv, ctx });
      };
      const a = draw(0), b = draw(1);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      expect(diff, `${def.id} is not seamless at the loop boundary`).toBe(0);
    }
  });

  it('is deterministic: the same seed and phase always give the same frame', () => {
    for (const def of EFFECTS) {
      const params = effectDefaults(def.id);
      const run = () => {
        const { cv, ctx } = ctx2d(120, 80);
        def.draw(ctx as never, { w: 120, h: 80, u: 0.63, t: 5, params, seed: 4242, scale: 1 });
        return Buffer.from(pixels({ cv, ctx })).toString('base64');
      };
      expect(run(), `${def.id} is not deterministic`).toBe(run());
    }
  });

  it('renders every mythic emblem variation as its own periodic motif', () => {
    const def = EFFECTS.find((e) => e.id === 'mythic-emblem')!;
    const motifs = ['fae-seal', 'norse-compass', 'chinese-knot', 'japanese-torii'];
    const frames = motifs.map((motif) => {
      const params = { ...effectDefaults(def.id), motif };
      const draw = (u: number) => {
        const { cv, ctx } = ctx2d(220, 160);
        def.draw(ctx as never, { w: 220, h: 160, u, t: u * def.defaultLoop, params, seed: 87, scale: 1 });
        return pixels({ cv, ctx });
      };
      const a = draw(0), b = draw(1);
      expect(Buffer.from(a).equals(Buffer.from(b)), `${motif} loop boundary`).toBe(true);
      expect(a.filter((_, i) => i % 4 === 3 && a[i] > 8).length).toBeGreaterThan(20);
      return Buffer.from(draw(0.43)).toString('base64');
    });
    expect(new Set(frames).size).toBe(motifs.length);
  });

  it('different seeds give different particle arrangements', () => {
    const def = EFFECTS.find((e) => e.id === 'fairy-dust')!;
    const run = (seed: number) => {
      const { cv, ctx } = ctx2d(160, 100);
      def.draw(ctx as never, { w: 160, h: 100, u: 0.5, t: 5, params: effectDefaults(def.id), seed, scale: 1 });
      return Buffer.from(pixels({ cv, ctx })).toString('base64');
    };
    expect(run(1)).not.toBe(run(2));
  });
});

describe('animation engine', () => {
  const engine = new AnimationEngine();
  const loops = new LoopManager();
  const lib = testLibrary();

  function sceneWithAnim(type: AnimationType): { scene: Scene; nodeId: string } {
    const scene = createScene('enchanted');
    const meta = lib.get('enchanted.middle.oak')!;
    const node = makeEffectNode('sparkles', scene, 0);
    node.kind = 'asset';
    node.assetId = meta.id;
    node.effect = undefined;
    node.width = 600; node.height = 800;
    node.animation = makeAnimation(type, 42);
    node.animation.enabled = true;
    scene.nodes = [node];
    return { scene, nodeId: node.id };
  }

  const types = Object.keys(DEFAULT_LOOP).filter((t) => t !== 'none') as AnimationType[];

  it('every technique returns to its exact initial state after one cycle', () => {
    for (const type of types) {
      const { scene, nodeId } = sceneWithAnim(type);
      const node = scene.nodes.find((n) => n.id === nodeId)!;
      const meta = lib.get(node.assetId);
      const loop = node.animation!.loop;
      const a = engine.evaluate(scene, node, 0, loops, meta, 'export');
      const b = engine.evaluate(scene, node, loop, loops, meta, 'export');
      const label = `${type}`;
      expect(b.offsetX, label).toBeCloseTo(a.offsetX, 9);
      expect(b.offsetY, label).toBeCloseTo(a.offsetY, 9);
      expect(b.rotation % 360, label).toBeCloseTo(a.rotation % 360, 9);
      expect(b.scale, label).toBeCloseTo(a.scale, 9);
      expect(b.alpha, label).toBeCloseTo(a.alpha, 9);
      expect(b.glow, label).toBeCloseTo(a.glow, 9);
      if (a.flame && b.flame) expect(b.flame.phase, label).toBeCloseTo(a.flame.phase, 9);
      if (a.steam && b.steam) expect(b.steam.phase, label).toBeCloseTo(a.steam.phase, 9);
      if (a.warp && b.warp) {
        for (const [u, v] of [[0, 0], [0.3, 0.4], [0.5, 0.5], [1, 1], [0.8, 0.1]]) {
          const fa = a.warp.field(u, v), fb = b.warp.field(u, v);
          expect(fb.dx, `${label} field dx at ${u},${v}`).toBeCloseTo(fa.dx, 9);
          expect(fb.dy, `${label} field dy at ${u},${v}`).toBeCloseTo(fa.dy, 9);
        }
      } else {
        expect(!!b.warp, label).toBe(!!a.warp);
      }
    }
  });

  it('actually moves things in the middle of the cycle', () => {
    for (const type of types) {
      const { scene, nodeId } = sceneWithAnim(type);
      const node = scene.nodes.find((n) => n.id === nodeId)!;
      const meta = lib.get(node.assetId);
      const loop = node.animation!.loop;
      const a = engine.evaluate(scene, node, 0, loops, meta, 'export');
      let moved = false;
      for (const f of [0.17, 0.31, 0.5, 0.73]) {
        const b = engine.evaluate(scene, node, loop * f, loops, meta, 'export');
        if (Math.abs(b.offsetX - a.offsetX) > 1e-6 || Math.abs(b.offsetY - a.offsetY) > 1e-6
          || Math.abs(b.rotation - a.rotation) > 1e-6 || Math.abs(b.scale - a.scale) > 1e-6
          || Math.abs(b.glow - a.glow) > 1e-6) { moved = true; break; }
        if (a.warp && b.warp) {
          for (const [u, v] of [[0.2, 0.1], [0.5, 0.3], [0.8, 0.6]]) {
            const fa = a.warp.field(u, v), fb = b.warp.field(u, v);
            if (Math.abs(fa.dx - fb.dx) > 1e-6 || Math.abs(fa.dy - fb.dy) > 1e-6) { moved = true; break; }
          }
        }
        if (a.scroll || b.scroll) moved = true;
        // Falling water carries its motion in a masked streak field, not in a
        // transform or a warp of the artwork.
        if (a.fall || b.fall) moved = true;
        if (a.flame && b.flame && a.flame.phase !== b.flame.phase) moved = true;
        if (a.steam && b.steam && a.steam.phase !== b.steam.phase) moved = true;
        // Sparkle lives in a glint field driven by the cycle position.
        if (a.sparkle && b.sparkle && a.sparkle.phase !== b.sparkle.phase) moved = true;
        if (moved) break;
      }
      expect(moved, `${type} never moves`).toBe(true);
    }
  });

  it('keeps a tree trunk planted while the canopy moves', () => {
    const { scene, nodeId } = sceneWithAnim('canopy-sway');
    const node = scene.nodes.find((n) => n.id === nodeId)!;
    const meta = { ...lib.get(node.assetId)!, rig: { type: 'canopy', canopyStart: 0.66, stiffness: 0.72, gusts: 3 } };
    const s = engine.evaluate(scene, node, 2, loops, meta, 'export');
    expect(s.warp).not.toBeNull();
    const base = s.warp!.field(0.5, 1.0);
    const canopy = s.warp!.field(0.5, 0.1);
    expect(Math.abs(base.dx)).toBeLessThan(1.0);              // trunk barely shifts
    expect(Math.abs(canopy.dx)).toBeGreaterThan(Math.abs(base.dx) * 3);
    // branch clusters are out of phase with each other
    const left = s.warp!.field(0.15, 0.25);
    const right = s.warp!.field(0.85, 0.25);
    expect(Math.abs(left.dx - right.dx)).toBeGreaterThan(0.01);
  });

  it('anchors grass at the soil and moves the tips most', () => {
    const { scene, nodeId } = sceneWithAnim('grass-wind');
    const node = scene.nodes.find((n) => n.id === nodeId)!;
    const s = engine.evaluate(scene, node, 1.5, loops, lib.get(node.assetId), 'export');
    const base = s.warp!.field(0.5, 1);
    const tip = s.warp!.field(0.5, 0);
    expect(Math.abs(base.dx)).toBeLessThan(0.001);
    expect(Math.abs(tip.dx)).toBeGreaterThan(1);
  });

  it('respects start and stop windows', () => {
    const { scene, nodeId } = sceneWithAnim('float');
    const node = scene.nodes.find((n) => n.id === nodeId)!;
    node.animation!.start = 5;
    node.animation!.end = 10;
    const before = engine.evaluate(scene, node, 2, loops, lib.get(node.assetId));
    const during = engine.evaluate(scene, node, 7, loops, lib.get(node.assetId));
    const after = engine.evaluate(scene, node, 12, loops, lib.get(node.assetId));
    expect(before.animated).toBe(false);
    expect(during.animated).toBe(true);
    expect(after.animated).toBe(false);
  });

  it('does not mutate the scene while evaluating', () => {
    const { scene } = sceneWithAnim('canopy-sway');
    const snapshot = JSON.stringify(scene);
    const node = scene.nodes[0];
    for (let t = 0; t < 20; t += 0.7) engine.evaluate(scene, node, t, loops, lib.get(node.assetId), 'export');
    expect(JSON.stringify(scene)).toBe(snapshot);
  });
});

describe('compositor', () => {
  it('renders the demo scene and returns to a pixel-identical state at the master cycle', async () => {
    const manifestPath = path.join(ROOT, 'public/library/manifest.json');
    if (!fs.existsSync(manifestPath)) return;   // artwork not built yet
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const cache = new Map<string, { bitmap: unknown; width: number; height: number }>();
    for (const m of lib.assets) {
      const img = await loadImage(path.join(ROOT, 'public/library', m.file));
      cache.set(m.id, { bitmap: img, width: img.width, height: img.height });
    }
    const images = {
      peek: (id: string | undefined) => (id ? cache.get(id) ?? null : null),
      ensure: async () => {},
      stats: { count: cache.size, bytes: 0, pending: 0 },
    };
    const loops = new LoopManager();
    const comp = new Compositor(lib, images as never, loops);
    const scene = buildDemoScene(lib, { withEffects: true });
    const report = loops.analyse(scene);
    expect(report.animated).toBeGreaterThan(5);
    expect(report.exact).toBe(true);

    const W = 480, H = 270;
    const scale = W / scene.canvas.width;
    const draw = (t: number) => {
      const { cv, ctx } = ctx2d(W, H);
      comp.render(ctx as never, scene, { scale, quality: 'preview', time: t, masterCycle: report.master });
      return pixels({ cv, ctx });
    };
    const a = draw(0), b = draw(report.master);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBe(0);

    const mid = draw(report.master / 2);
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - mid[i]) > 6) changed++;
    expect(changed / (a.length / 4)).toBeGreaterThan(0.005);
  }, 120_000);

  it('shows the current world through the transparent lounge-window overlay', async () => {
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
    const bg = lib.get('enchanted.background.enchanted-lake')!;
    const room = lib.get('enchanted.foreground.lounge-window')!;
    const bgImage = await loadImage(path.join(ROOT, 'public/library', bg.file));
    const roomImage = await loadImage(path.join(ROOT, 'public/library', room.file));
    const cache = new Map([
      [bg.id, { bitmap: bgImage, width: bgImage.width, height: bgImage.height }],
      [room.id, { bitmap: roomImage, width: roomImage.width, height: roomImage.height }],
    ]);
    const images = {
      peek: (id: string | undefined) => (id ? cache.get(id) ?? null : null),
      ensure: async () => {}, stats: { count: cache.size, bytes: 0, pending: 0 },
    };
    const scene = createScene('enchanted');
    const bgNode = createAssetNode(bg, scene);
    fitBackground(bgNode, scene, bgImage.width, bgImage.height);
    bgNode.locked = true;
    const roomNode = createAssetNode(room, scene);
    scene.nodes = [bgNode, roomNode];
    const comp = new Compositor(lib, images as never, new LoopManager());
    const render = () => {
      const { cv, ctx } = ctx2d(400, 225);
      comp.render(ctx as never, scene, { scale: 400 / scene.canvas.width, quality: 'export', time: 0, skipLighting: true });
      return pixels({ cv, ctx });
    };
    const withRoom = render();
    scene.nodes = [bgNode];
    const worldOnly = render();
    const center = (Math.floor(112.5) * 400 + 200) * 4;
    const wall = (Math.floor(112.5) * 400 + 8) * 4;
    expect(Array.from(withRoom.slice(center, center + 3))).toEqual(Array.from(worldOnly.slice(center, center + 3)));
    expect(Array.from(withRoom.slice(wall, wall + 3))).not.toEqual(Array.from(worldOnly.slice(wall, wall + 3)));
  });

  it('does not mutate the scene while rendering', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    scene.nodes.push(makeEffectNode('sparkles', scene, 0));
    const loops = new LoopManager();
    const images = { peek: () => null, ensure: async () => {}, stats: { count: 0, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, loops);
    const snapshot = JSON.stringify(scene);
    const { ctx } = ctx2d(160, 90);
    comp.render(ctx as never, scene, { scale: 160 / scene.canvas.width, quality: 'preview', time: 3 });
    expect(JSON.stringify(scene)).toBe(snapshot);
  });
});

describe('mesh warp locality', () => {
  /**
   * A water shimmer must not touch the sky. Warping the whole plate as one
   * triangle mesh used to leave faint antialiased grid seams across areas with
   * zero displacement; those areas are now drawn as plain image slices.
   */
  it('leaves zero-displacement rows pixel-identical to an unwarped draw', async () => {
    const { cv, ctx } = ctx2d(400, 300);
    const src = createCanvas(400, 300) as Canvas;
    const sc = src.getContext('2d');
    const grad = sc.createLinearGradient(0, 0, 400, 300);
    grad.addColorStop(0, '#204060'); grad.addColorStop(1, '#e0c090');
    sc.fillStyle = grad; sc.fillRect(0, 0, 400, 300);
    for (let i = 0; i < 60; i++) {
      sc.fillStyle = `rgba(${i * 4},${255 - i * 3},${i * 2},0.7)`;
      sc.fillRect((i * 37) % 390, (i * 53) % 290, 9, 7);
    }

    const s = { sx: 0, sy: 0, sw: 400, sh: 300 };
    const d = { dx: 0, dy: 0, dw: 400, dh: 300 };
    // Displacement only in the bottom third, reaching exactly zero at v = 2/3.
    const field = (_u: number, v: number) => {
      const m = v <= 2 / 3 ? 0 : Math.min(1, (v - 2 / 3) / 0.1);
      return { dx: Math.sin(v * 40) * 6 * m, dy: 0 };
    };
    meshWarp(ctx as never, src as never, s, d, 8, 24, field, 1.6);

    const ref = createCanvas(400, 300) as Canvas;
    ref.getContext('2d').drawImage(src as never, 0, 0);
    const a = pixels({ cv, ctx });
    const b = pixels({ cv: ref, ctx: ref.getContext('2d') });

    // Rows above the active band (v < 2/3 -> y < 200) must be untouched.
    let skyDiff = 0;
    for (let y = 0; y < 195; y++) {
      for (let x = 0; x < 400 * 4; x++) {
        if (a[y * 400 * 4 + x] !== b[y * 400 * 4 + x]) skyDiff++;
      }
    }
    expect(skyDiff).toBe(0);

    // ...and the water below it must actually have moved.
    let waterDiff = 0;
    for (let y = 240; y < 300; y++) {
      for (let x = 0; x < 400 * 4; x++) {
        if (Math.abs(a[y * 400 * 4 + x] - b[y * 400 * 4 + x]) > 8) waterDiff++;
      }
    }
    expect(waterDiff).toBeGreaterThan(500);
  });

  it('draws a completely flat field as a single clean image', () => {
    const { cv, ctx } = ctx2d(200, 150);
    const src = createCanvas(200, 150) as Canvas;
    const sc = src.getContext('2d');
    sc.fillStyle = '#3a7d44'; sc.fillRect(0, 0, 200, 150);
    sc.fillStyle = '#f0e68c'; sc.fillRect(40, 30, 120, 90);
    meshWarp(ctx as never, src as never, { sx: 0, sy: 0, sw: 200, sh: 150 },
      { dx: 0, dy: 0, dw: 200, dh: 150 }, 10, 10, () => ({ dx: 0, dy: 0 }), 1.6);
    const ref = createCanvas(200, 150) as Canvas;
    ref.getContext('2d').drawImage(src as never, 0, 0);
    expect(Buffer.from(pixels({ cv, ctx })).equals(
      Buffer.from(pixels({ cv: ref, ctx: ref.getContext('2d') })))).toBe(true);
  });
});

describe('solo preview isolation', () => {
  /**
   * The inspector offers "Preview this effect only". That must isolate ONE node,
   * not its whole layer - otherwise the control does not do what it says.
   */
  function rig() {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    const a = makeEffectNode('sparkles', scene, 0);
    const b = makeEffectNode('fireflies', scene, 1);
    const c = makeEffectNode('snow', scene, 2);
    scene.nodes.push(a, b, c);
    const loops = new LoopManager();
    const images = { peek: () => null, ensure: async () => {}, stats: { count: 0, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, loops);
    return { lib, scene, loops, comp, a, b, c };
  }

  const draw = (comp: Compositor, scene: Scene, extra: Record<string, unknown> = {}) => {
    const { cv, ctx } = ctx2d(200, 112);
    comp.render(ctx as never, scene, {
      scale: 200 / scene.canvas.width, quality: 'preview', time: 2, skipLighting: true, ...extra,
    });
    return Buffer.from(pixels({ cv, ctx }));
  };

  it('renders exactly the soloed node and nothing else', () => {
    const { scene, comp, b } = rig();
    const solo = draw(comp, scene, { onlyNode: b.id });

    const alone = { ...scene, nodes: [b] };
    const expected = draw(comp, alone as Scene);
    expect(solo.equals(expected)).toBe(true);
  });

  it('a soloed node differs from the full scene and from a different solo', () => {
    const { scene, comp, a, b } = rig();
    const all = draw(comp, scene);
    const soloA = draw(comp, scene, { onlyNode: a.id });
    const soloB = draw(comp, scene, { onlyNode: b.id });
    expect(soloA.equals(all)).toBe(false);
    expect(soloA.equals(soloB)).toBe(false);
  });

  it('takes precedence over a layer filter', () => {
    const { scene, comp, b } = rig();
    // Ask for the foreground layer but solo an atmosphere node: the node wins.
    const withBoth = draw(comp, scene, { onlyNode: b.id, layers: ['foreground'] });
    const justNode = draw(comp, scene, { onlyNode: b.id });
    expect(withBoth.equals(justNode)).toBe(true);
  });

  it('overrides the hidden flag, because the user explicitly asked to see it', () => {
    const { scene, comp, b } = rig();
    b.visible = false;
    const hiddenSolo = draw(comp, scene, { onlyNode: b.id });
    b.visible = true;
    const shownSolo = draw(comp, scene, { onlyNode: b.id });
    expect(hiddenSolo.equals(shownSolo)).toBe(true);
  });

  it('an unknown solo id draws the empty backdrop rather than the whole scene', () => {
    const { scene, comp } = rig();
    const bogus = draw(comp, scene, { onlyNode: 'does-not-exist' });
    const empty = draw(comp, { ...scene, nodes: [] } as Scene);
    expect(bogus.equals(empty)).toBe(true);
  });

  it('a layer solo still shows every node in that layer', () => {
    const { scene, comp } = rig();
    const layerSolo = draw(comp, scene, { layers: ['atmosphere'] });
    const all = draw(comp, scene);
    // All three nodes are atmosphere, so a layer solo equals the full scene here.
    expect(layerSolo.equals(all)).toBe(true);
  });
});

describe('background water regions', () => {
  /**
   * Every background that declares a water region must shimmer ONLY there.
   * This is the regression guard for the sky-seam bug: a whole-plate mesh warp
   * used to disturb foliage and sky that were never meant to move.
   */
  it('keeps every declared-region background still outside its water', async () => {
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
    const loops = new LoopManager();
    const cache = new Map<string, { bitmap: unknown; width: number; height: number }>();
    const images = {
      peek: (id: string | undefined) => (id ? cache.get(id) ?? null : null),
      ensure: async () => {},
      stats: { count: 0, bytes: 0, pending: 0 },
    };
    const comp = new Compositor(lib, images as never, loops);

    const backgrounds = lib.assets.filter((a) => a.layer === 'background' && a.rig?.region);
    expect(backgrounds.length).toBeGreaterThanOrEqual(2);

    for (const meta of backgrounds) {
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      cache.set(meta.id, { bitmap: img, width: img.width, height: img.height });

      const scene = createScene(meta.style);
      const node = createAssetNode(meta, scene);
      fitBackground(node, scene, img.width, img.height);
      node.animation = makeAnimation('water-shimmer', 8);
      node.animation.enabled = true;
      node.animation.amplitude = 1;
      node.animation.loop = 8;
      scene.nodes = [node];

      const W = 480, H = 270;
      const scale = W / scene.canvas.width;
      const draw = (t: number) => {
        const { cv, ctx } = ctx2d(W, H);
        comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
        return pixels({ cv, ctx });
      };
      const a = draw(0), b = draw(3.1);

      // Map the asset's normalised region into canvas rows.
      const [, ry, , rh] = meta.rig!.region as number[];
      const top = node.y - node.height / 2;
      const y0 = Math.max(0, Math.floor((top + ry * node.height) * scale));
      const y1 = Math.min(H, Math.ceil((top + (ry + rh) * node.height) * scale));

      // Outside the water nothing may move. A +/-1 rounding difference on the
      // antialiased boundary row is unavoidable; anything larger is real motion.
      let outside = 0, maxOutside = 0;
      for (let y = 0; y < H; y++) {
        if (y >= y0 && y < y1) continue;
        for (let x = 0; x < W * 4; x++) {
          const d = Math.abs(a[y * W * 4 + x] - b[y * W * 4 + x]);
          if (d > maxOutside) maxOutside = d;
          if (d > 2) outside++;
        }
      }
      expect(outside, `${meta.id} moved outside its water region (max delta ${maxOutside})`).toBe(0);

      let inside = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W * 4; x += 4) {
          if (Math.abs(a[y * W * 4 + x] - b[y * W * 4 + x]) > 4) inside++;
        }
      }
      expect(inside, `${meta.id} water did not move at all`).toBeGreaterThan(50);
    }
  }, 120_000);
});
