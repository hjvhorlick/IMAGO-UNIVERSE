/**
 * Falling water acceptance tests.
 *
 * Two bugs are guarded here, both reported by eye:
 *  1. the water climbed UP the screen (a sign error in the region scroll), and
 *  2. what moved was a PICTURE of a waterfall, not water - the painted lip and
 *     pool slid along with it and a tiling seam marched through the artwork.
 *
 * So the assertions are about pixels, not implementation: motion must be
 * downward, the painted plate must not slide, the loop must return exactly, and
 * nothing outside the water may move.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { AnimationEngine } from '../src/animation/animationEngine';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { AssetLibrary } from '../src/assets/library';
import { createScene, createAssetNode, fitBackground } from '../src/scene/sceneModel';
import { DEFAULT_LOOP, makeAnimation } from '../src/core/types';
import { meta } from './helpers';

const ROOT = process.cwd();   // vitest runs from the repository root
type Ctx = ReturnType<Canvas['getContext']>;

function ctx2d(w: number, h: number) {
  const cv = createCanvas(w, h) as Canvas;
  return { cv, ctx: cv.getContext('2d') };
}
function pixels(cv: Canvas, ctx: Ctx) {
  return ctx.getImageData(0, 0, cv.width, cv.height).data;
}

/** Luminance plane for a pixel rectangle - the streak field, per pixel. */
function lumaPlane(px: Uint8ClampedArray, W: number, x0: number, x1: number, y0: number, y1: number) {
  const w = x1 - x0, h = y1 - y0;
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * W + (x0 + x)) * 4;
      out[y * w + x] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
  }
  return { data: out, w, h };
}

/**
 * Vertical velocity by 2D optical flow.
 *
 * For a pattern translating as f(y - v*t), dI/dt = -v * dI/dy, so
 * v = -sum(It*Iy) / sum(Iy^2). Positive v means the features move DOWN.
 *
 * This must be measured per PIXEL, not on a row-averaged profile: averaging
 * across the width cancels the streaks against each other and leaves almost no
 * vertical structure, which made an earlier version of this test read ~0.
 * Unlike a shift search, flow cannot alias when motion exceeds a search window.
 */
function flowDown(
  a: { data: Float64Array; w: number; h: number },
  b: { data: Float64Array; w: number; h: number },
  dt: number,
): number {
  let num = 0, den = 0;
  const { w, h } = a;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const iy = (a.data[i + w] - a.data[i - w]) / 2;
      const it = (b.data[i] - a.data[i]) / dt;
      num += it * iy;
      den += iy * iy;
    }
  }
  return den > 1e-9 ? -num / den : 0;
}

/**
 * A flat grey plate with a declared fall region. Flat means the mesh wobble is
 * invisible, so the ONLY features in the profile are the falling streaks -
 * which is exactly what we want to measure.
 */
function flatFallScene() {
  const lib = new AssetLibrary();
  const m = meta('enchanted.middle.falls', 'middle', 'water', 'enchanted', {
    width: 400, height: 800, defaultScale: 0.9,
    animations: ['waterfall-flow'],
    rig: { type: 'fall', region: [0.25, 0.1, 0.5, 0.7], speed: 1 },
  });
  lib.manifest = {
    schema: 'imago.asset-library/1',
    styles: [{ id: 'enchanted', name: 'Enchanted', subtitle: '', description: '', swatches: ['#2f7d55'],
      lighting: 'upper-left', reference: [], complete: true }],
    assets: [m],
  } as never;

  const plate = createCanvas(400, 800);
  const pc = plate.getContext('2d');
  pc.fillStyle = '#4a5560';
  pc.fillRect(0, 0, 400, 800);
  const cache = new Map([[m.id, { bitmap: plate, width: 400, height: 800 }]]);
  const images = {
    peek: (id: string | undefined) => (id ? cache.get(id) ?? null : null),
    ensure: async () => {},
    stats: { count: 1, bytes: 0, pending: 0 },
  };
  const loops = new LoopManager();
  const comp = new Compositor(lib, images as never, loops);
  const scene = createScene('enchanted');
  const node = createAssetNode(m, scene);
  node.animation = makeAnimation('waterfall-flow', 8);
  node.animation.enabled = true;
  node.animation.amplitude = 1;
  node.animation.loop = 8;
  scene.nodes = [node];
  return { lib, comp, scene, node, loops, m };
}

describe('falling water', () => {
  it('starts flowing automatically when a waterfall asset is placed', () => {
    const manifestPath = path.join(ROOT, 'public/library/manifest.json');
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const m = lib.assets.find((x) => x.animations.includes('waterfall-flow'))!;
    const scene = createScene(m.style);
    const node = createAssetNode(m, scene);
    expect(node.animation?.type).toBe('waterfall-flow');
    expect(node.animation?.enabled).toBe(true);
    expect(node.animation!.amplitude).toBeGreaterThan(0.7);
    expect(node.animation!.turbulence).toBeGreaterThan(0.5);
  });

  it('never slides the painted plate - a picture of a waterfall is not water', () => {
    const { lib, scene, node, loops } = flatFallScene();
    const engine = new AnimationEngine();
    const state = engine.evaluate(scene, node, 1.3, loops, lib.get(node.assetId), 'export');
    // The old implementation scrolled the artwork itself. It must not.
    expect(state.scroll).toBeNull();
    expect(state.fall).not.toBeNull();
    expect(state.fall!.cycles).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(state.fall!.cycles)).toBe(true);
  });

  it('turns up both splash and plume strength with turbulence', () => {
    const { scene, node, loops, m } = flatFallScene();
    const engine = new AnimationEngine();
    node.animation!.amplitude = 0.9;
    node.animation!.turbulence = 0;
    const calm = engine.evaluate(scene, node, 1.3, loops, m, 'export').fall!;
    node.animation!.turbulence = 1;
    const turbulent = engine.evaluate(scene, node, 1.3, loops, m, 'export').fall!;
    expect(turbulent.splash).toBeGreaterThan(calm.splash);
    expect(turbulent.mist).toBeGreaterThan(calm.mist);
  });

  it('moves DOWNWARD, not upward', () => {
    const { comp, scene, node } = flatFallScene();
    const W = 300, H = 600;
    const scale = W / scene.canvas.width;
    const draw = (t: number) => {
      const { cv, ctx } = ctx2d(W, H);
      comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
      return pixels(cv, ctx);
    };

    const [rx, ry, rw, rh] = [0.25, 0.1, 0.5, 0.7];
    const left = node.x - node.width / 2, top = node.y - node.height / 2;
    const x0 = Math.max(0, Math.round((left + (rx + 0.08) * node.width) * scale));
    const x1 = Math.min(W, Math.round((left + (rx + rw - 0.08) * node.width) * scale));
    const y0 = Math.max(0, Math.round((top + (ry + 0.08) * node.height) * scale));
    const y1 = Math.min(H, Math.round((top + (ry + rh - 0.08) * node.height) * scale));
    expect(x1 - x0).toBeGreaterThan(10);
    expect(y1 - y0).toBeGreaterThan(40);

    // Sample several phase pairs and require consistent DOWNWARD velocity.
    // Optical-flow linearisation assumes subpixel-scale temporal steps. At the
    // waterfall's several-cascade-per-loop speed, 0.2s jumps can cross more
    // than a full streak width and alias the derivative in either direction.
    const dt = 0.025;
    const vels: number[] = [];
    for (const t of [0.4, 1.1, 2.3, 3.7, 5.2, 6.6]) {
      const a = lumaPlane(draw(t), W, x0, x1, y0, y1);
      const b = lumaPlane(draw(t + dt), W, x0, x1, y0, y1);
      vels.push(flowDown(a, b, dt));
    }
    const down = vels.filter((v) => v > 0).length;
    const mean = vels.reduce((p, c) => p + c, 0) / vels.length;
    const shown = vels.map((v) => v.toFixed(1)).join(', ');
    expect(down, `expected downward flow, got px/s: ${shown}`).toBe(vels.length);
    expect(mean, `mean vertical velocity was ${mean.toFixed(2)} px/s`).toBeGreaterThan(1);
  });

  it('moves smoothly from frame to frame, without flicker in the spray and mist', async () => {
    // The shipped waterfall on its painted plate: flicker only shows up against
    // real rock and water, so a flat test plate would not catch it.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
    const lib = new AssetLibrary();
    lib.manifest = manifest;
    const falls = lib.assets.find((a) => a.animations.includes('waterfall-flow'))!;
    const bg = lib.assets.find((a) => a.style === falls.style && a.layer === 'background')!;
    const cache = new Map<string, { bitmap: unknown; width: number; height: number }>();
    for (const m of [falls, bg]) {
      const img = await loadImage(path.join(ROOT, 'public/library', m.file));
      cache.set(m.id, { bitmap: img, width: img.width, height: img.height });
    }
    const images = {
      peek: (id?: string) => (id ? cache.get(id) ?? null : null),
      ensure: async () => {}, stats: { count: cache.size, bytes: 0, pending: 0 },
    };
    const loops = new LoopManager();
    const comp = new Compositor(lib, images as never, loops);
    const scene = createScene(falls.style);
    const bn = createAssetNode(bg, scene);
    fitBackground(bn, scene, cache.get(bg.id)!.width, cache.get(bg.id)!.height);
    bn.locked = true;
    scene.nodes.push(bn);
    const node = createAssetNode(falls, scene);
    node.animation = makeAnimation('waterfall-flow', DEFAULT_LOOP['waterfall-flow']);
    node.animation.enabled = true;
    scene.nodes.push(node);

    const W = 480, H = 270;
    const scale = W / scene.canvas.width;
    const [rx, ry, rw, rh] = falls.rig!.region as number[];
    const left = node.x - node.width / 2, top = node.y - node.height / 2;
    const x0 = Math.max(0, Math.round((left + rx * node.width) * scale));
    const x1 = Math.min(W, Math.round((left + (rx + rw) * node.width) * scale));
    const y0 = Math.max(0, Math.round((top + ry * node.height) * scale));
    const y1 = Math.min(H, Math.round((top + (ry + rh) * node.height) * scale));

    // Step evenly through one loop. Steady, smooth motion changes evenly from one
    // frame to the next; flicker shows up as the size of the change jumping.
    const loop = loops.effectiveLoop(scene, node);
    const N = 24;
    const luma = (t: number) => {
      const { cv, ctx } = ctx2d(W, H);
      comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
      const px = pixels(cv, ctx);
      const out: number[] = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        out.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
      }
      return out;
    };
    const frames = Array.from({ length: N }, (_, k) => luma((k / N) * loop));
    const change: number[] = [];
    for (let k = 0; k < N; k++) {
      const a = frames[k], b = frames[(k + 1) % N];
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(b[i] - a[i]);
      change.push(sum / a.length);
    }
    const mean = change.reduce((p, c) => p + c, 0) / N;
    const jitter = change.reduce((p, c, k) => p + Math.abs(change[(k + 1) % N] - c), 0) / N;
    const ratio = jitter / mean;
    expect(ratio, `frame-to-frame jitter ratio ${ratio.toFixed(3)}`).toBeLessThan(0.12);
  }, 120_000);

  it('returns to its exact starting pixels after one cycle', () => {
    const { comp, scene, node } = flatFallScene();
    const W = 300, H = 600;
    const scale = W / scene.canvas.width;
    const draw = (t: number) => {
      const { cv, ctx } = ctx2d(W, H);
      comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
      return pixels(cv, ctx);
    };
    const loop = node.animation!.loop;
    const a = draw(0), b = draw(loop);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBe(0);
    // ...and it really is animating in between. Sample a phase that is NOT a
    // whole number of streak traversals: with integer cycles, t = loop/2 can
    // legitimately land every streak back where it began.
    const mid = draw(loop * 0.31);
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - mid[i]) > 6) changed++;
    expect(changed).toBeGreaterThan(200);
  });

  it('leaves the rock and the pool outside the fall region untouched', () => {
    const { comp, scene, node } = flatFallScene();
    const W = 300, H = 600;
    const scale = W / scene.canvas.width;
    const draw = (t: number) => {
      const { cv, ctx } = ctx2d(W, H);
      comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
      return pixels(cv, ctx);
    };
    const a = draw(0), b = draw(2.7);
    const [, ry, , rh] = [0.25, 0.1, 0.5, 0.7];
    const top = node.y - node.height / 2;
    const y0 = Math.max(0, Math.floor((top + ry * node.height) * scale));
    const y1 = Math.min(H, Math.ceil((top + (ry + rh) * node.height) * scale));
    let maxOutside = 0;
    for (let y = 0; y < H; y++) {
      if (y >= y0 && y < y1) continue;
      for (let x = 0; x < W * 4; x++) {
        const d = Math.abs(a[y * W * 4 + x] - b[y * W * 4 + x]);
        if (d > maxOutside) maxOutside = d;
      }
    }
    // Antialiased boundary rows can differ by 1; anything more is real leakage.
    expect(maxOutside).toBeLessThanOrEqual(2);
  });

  it('the shipped waterfall loops exactly and stays still outside its water', async () => {
    const manifestPath = path.join(ROOT, 'public/library/manifest.json');
    if (!fs.existsSync(manifestPath)) return;
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const m = lib.assets.find((x) => x.animations.includes('waterfall-flow'));
    if (!m) return;
    const img = await loadImage(path.join(ROOT, 'public/library', m.file));
    const cache = new Map([[m.id, { bitmap: img, width: img.width, height: img.height }]]);
    const images = {
      peek: (id: string | undefined) => (id ? cache.get(id) ?? null : null),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 },
    };
    const loops = new LoopManager();
    const comp = new Compositor(lib, images as never, loops);
    const scene = createScene(m.style);
    const bg = lib.assets.find((x) => x.style === m.style && x.layer === 'background');
    if (bg) {
      const bimg = await loadImage(path.join(ROOT, 'public/library', bg.file));
      cache.set(bg.id, { bitmap: bimg, width: bimg.width, height: bimg.height });
      const bn = createAssetNode(bg, scene);
      fitBackground(bn, scene, bimg.width, bimg.height);
      bn.locked = true;
      scene.nodes.push(bn);
    }
    const node = createAssetNode(m, scene);
    node.animation = makeAnimation('waterfall-flow', 8);
    node.animation.enabled = true;
    node.animation.loop = 8;
    scene.nodes.push(node);

    const W = 400, H = 225;
    const scale = W / scene.canvas.width;
    const draw = (t: number) => {
      const { cv, ctx } = ctx2d(W, H);
      comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
      return pixels(cv, ctx);
    };
    const a = draw(0), b = draw(8);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff, 'shipped waterfall must loop exactly').toBe(0);
    const mid = draw(3.3);
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - mid[i]) > 6) changed++;
    expect(changed, 'shipped waterfall must actually move').toBeGreaterThan(100);
  }, 120_000);
});
