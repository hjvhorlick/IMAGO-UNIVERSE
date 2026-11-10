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
import { makeAnimation } from '../src/core/types';
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

/** Horizontal counterpart of flowDown: positive is motion to the right. */
function flowRight(a: { data: Float64Array; w: number; h: number },
  b: { data: Float64Array; w: number; h: number }, dt: number): number {
  let num = 0, den = 0;
  for (let y = 1; y < a.h - 1; y++) for (let x = 1; x < a.w - 1; x++) {
    const i = y * a.w + x;
    const ix = (a.data[i + 1] - a.data[i - 1]) / 2;
    num += ((b.data[i] - a.data[i]) / dt) * ix;
    den += ix * ix;
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

/**
 * The second half of the job: the *painted* water has to move too, the way a
 * real fall does - gathering at the lip, tipping over it and plunging - while
 * the rock it runs over never moves a pixel.
 */
describe('painted water, not a picture of water', () => {
  const FALLS = ['realistic.middle.waterfall', 'enchanted.middle.waterfall'];

  async function stageFall(assetId: string) {
    const manifestPath = path.join(ROOT, 'public/library/manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const m = lib.get(assetId);
    if (!m || !m.rig?.region) return null;
    const img = await loadImage(path.join(ROOT, 'public/library', m.file));
    const cache = new Map([[m.id, { bitmap: img, width: img.width, height: img.height }]]);
    const images = {
      peek: (id: string | undefined) => (id ? cache.get(id) ?? null : null),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 },
    };
    const loops = new LoopManager();
    const comp = new Compositor(lib, images as never, loops);
    const scene = createScene(m.style);
    scene.canvas.width = 380;
    scene.canvas.height = 320;
    const node = createAssetNode(m, scene);
    node.width = 320;
    node.height = node.width * (m.height / m.width);
    node.x = 190;
    node.y = 160;
    node.animation = makeAnimation('waterfall-flow', 8);
    node.animation.enabled = true;
    node.animation.amplitude = 0.9;
    node.animation.turbulence = 0.78;
    node.animation.loop = 8;
    scene.nodes = [node];

    const draw = (t: number) => {
      const { cv, ctx } = ctx2d(scene.canvas.width, scene.canvas.height);
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
      return pixels(cv, ctx);
    };
    return { lib, m, node, scene, draw, img, comp };
  }

  it('extracts each painted cascade as a tube from its lip to its foot', async () => {
    const { buildFallGeometry } = await import('../src/render/waterfall');
    for (const id of FALLS) {
      const s = await stageFall(id);
      if (!s) continue;
      const region = s.m.rig!.region as [number, number, number, number];
      const GW = 320;
      const GH = Math.round(GW * (region[3] * s.img.height) / (region[2] * s.img.width));
      const geo = buildFallGeometry(
        s.img as unknown as CanvasImageSource,
        { sx: 0, sy: 0, sw: s.img.width, sh: s.img.height }, region, GW, GH,
      );
      expect(geo, `${id} must yield water geometry`).not.toBeNull();
      expect(geo!.streams.length, `${id} must find at least one cascade`).toBeGreaterThan(0);
      const hero = geo!.streams[0];
      expect(hero.footY).toBeGreaterThan(hero.lipY);
      expect(hero.coreW).toBeGreaterThan(1);
      expect(hero.lipY).toBeLessThan(geo!.impactY);
      expect(geo!.impactY).toBeLessThanOrEqual(GH);
    }
  }, 60_000);

  it('carries Clearwater Falls through the lower cascade to its actual plunge pool', async () => {
    const s = await stageFall('realistic.middle.waterfall');
    expect(s).not.toBeNull();
    if (!s) throw new Error('Clearwater Falls is missing');
    const region = s.m.rig!.region!;
    const impact = s.m.rig!.impactY;
    expect(impact).toBeDefined();
    const GW = 320;
    const GH = Math.round(GW * (region[3] * s.img.height) / (region[2] * s.img.width));
    const { buildFallGeometry } = await import('../src/render/waterfall');
    const geo = buildFallGeometry(s.img as unknown as CanvasImageSource,
      { sx: 0, sy: 0, sw: s.img.width, sh: s.img.height }, region, GW, GH, impact)!;
    expect(geo.impactY / GH).toBeGreaterThan(0.8);
    expect(geo.streams[0].footY / GH).toBeGreaterThan(0.8);

    // Check the actual lower curtain, not the upper water or surrounding mist.
    const left = s.node.x - s.node.width / 2;
    const top = s.node.y - s.node.height / 2;
    const x0 = Math.round(left + s.node.width * 0.48);
    const x1 = Math.round(left + s.node.width * 0.66);
    const y0 = Math.round(top + s.node.height * 0.60);
    const y1 = Math.round(top + s.node.height * 0.74);
    const a = s.draw(0.4), b = s.draw(1.05), loop = s.draw(8.4);
    let changed = 0, seamDiff = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * s.scene.canvas.width + x) * 4;
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 8) changed++;
        for (let k = 0; k < 4; k++) seamDiff = Math.max(seamDiff, Math.abs(a[i + k] - loop[i + k]));
      }
    }
    expect(changed, 'the lower curtain should visibly move').toBeGreaterThan(200);
    expect(seamDiff, 'the lower curtain should loop seamlessly').toBeLessThanOrEqual(1);
  }, 60_000);

  it('keeps Clearwater water darker, irregular and moving downward', async () => {
    const s = await stageFall('realistic.middle.waterfall');
    if (!s || !s.m.rig) throw new Error('Clearwater Falls is missing');
    expect(s.m.rig.naturalFlow).toBe(true);
    const left = s.node.x - s.node.width / 2;
    const top = s.node.y - s.node.height / 2;
    const x0 = Math.round(left + s.node.width * 0.50);
    const x1 = Math.round(left + s.node.width * 0.64);
    const y0 = Math.round(top + s.node.height * 0.22);
    const y1 = Math.round(top + s.node.height * 0.68);
    const natural = s.draw(0.8);
    s.m.rig.naturalFlow = false;
    const smooth = s.draw(0.8);
    s.m.rig.naturalFlow = true;
    let darkLuma = 0, smoothLuma = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * s.scene.canvas.width + x) * 4;
      darkLuma += natural[i] * 0.299 + natural[i + 1] * 0.587 + natural[i + 2] * 0.114;
      smoothLuma += smooth[i] * 0.299 + smooth[i + 1] * 0.587 + smooth[i + 2] * 0.114;
      n++;
    }
    expect(darkLuma / n, 'the cascade should be less washed out').toBeLessThan(smoothLuma / n - 10);
    expect(darkLuma / n, 'the water should retain light as well as shadow').toBeGreaterThan(95);
    const end = s.draw(8 - 0.0001), start = s.draw(0.0001);
    let boundaryDiff = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * s.scene.canvas.width + x) * 4;
      boundaryDiff += Math.abs(end[i] - start[i]) + Math.abs(end[i + 1] - start[i + 1]) + Math.abs(end[i + 2] - start[i + 2]);
    }
    expect(boundaryDiff / (n * 3), 'water should not jump at the loop boundary').toBeLessThan(1.5);
    for (const t of [0.3, 0.7, 1.2, 2.1, 3.2]) {
      const a = lumaPlane(s.draw(t), s.scene.canvas.width, x0, x1, y0, y1);
      const b = lumaPlane(s.draw(t + 0.03), s.scene.canvas.width, x0, x1, y0, y1);
      expect(flowDown(a, b, 0.03), `water should fall at phase ${t}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it('animates the foreground pool independently and lets a little mist drift above it', async () => {
    const s = await stageFall('realistic.middle.waterfall');
    if (!s) throw new Error('Clearwater Falls is missing');
    const pool = s.m.rig!.poolRegion;
    expect(pool).toBeDefined();
    const left = s.node.x - s.node.width / 2;
    const top = s.node.y - s.node.height / 2;
    // The pool extends below the waterfall's old animation rectangle.
    const x0 = Math.round(left + s.node.width * 0.32);
    const x1 = Math.round(left + s.node.width * 0.76);
    const y0 = Math.round(top + s.node.height * 0.925);
    const y1 = Math.round(top + s.node.height * 0.96);
    const a = s.draw(0.4), b = s.draw(1.05), loop = s.draw(8.4);
    let changed = 0, seamDiff = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * s.scene.canvas.width + x) * 4;
      const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (diff > 5) changed++;
      for (let k = 0; k < 4; k++) seamDiff = Math.max(seamDiff, Math.abs(a[i + k] - loop[i + k]));
    }
    expect(changed, 'foreground pool water should move').toBeGreaterThan(30);
    expect(seamDiff, 'pool should loop seamlessly').toBeLessThanOrEqual(1);

    const { buildFallGeometry, drawFallPool } = await import('../src/render/waterfall');
    const region = s.m.rig!.region!;
    const geo = buildFallGeometry(s.img as unknown as CanvasImageSource,
      { sx: 0, sy: 0, sw: s.img.width, sh: s.img.height }, region, 320, 306, s.m.rig!.impactY)!;
    const f = { region, cycles: 3, density: 48, length: 0.25, width: 0.03,
      opacity: 0.9, seed: 42, splash: 0, mist: 1 };
    const mistFrame = (phase: number) => {
      const { cv, ctx } = ctx2d(320, 200);
      ctx.translate(0, 80);
      drawFallPool(ctx as never, 320, 80, geo, f, phase, 1);
      return pixels(cv, ctx);
    };
    const m1 = mistFrame(0.1), m2 = mistFrame(0.35), mLoop = mistFrame(1.1);
    let above = 0, drifting = 0, maxAlpha = 0, mistLoopDiff = 0;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      if (m1[i + 3] > 0) above++;
      if (Math.abs(m1[i + 3] - m2[i + 3]) > 1) drifting++;
      maxAlpha = Math.max(maxAlpha, m1[i + 3]);
      mistLoopDiff = Math.max(mistLoopDiff, Math.abs(m1[i + 3] - mLoop[i + 3]));
    }
    expect(above, 'mist should hover above the pool').toBeGreaterThan(100);
    expect(drifting, 'mist should move and dissipate').toBeGreaterThan(100);
    expect(maxAlpha, 'mist should remain translucent').toBeLessThan(80);
    expect(mistLoopDiff).toBeLessThanOrEqual(1);

    // Crop into the pool: its animation must follow the image crop rather
    // than stay at its old full-image coordinates or leak beyond the node.
    s.node.crop = { x: 0.25, y: 0.8, w: 0.5, h: 0.2 };
    const withPool = s.draw(0.4);
    s.m.rig!.poolRegion = undefined;
    const withoutPool = s.draw(0.4);
    s.m.rig!.poolRegion = pool;
    let cropMotion = 0, outsideMotion = 0;
    for (let y = 0; y < s.scene.canvas.height; y++) for (let x = 0; x < s.scene.canvas.width; x++) {
      const i = (y * s.scene.canvas.width + x) * 4;
      const delta = Math.abs(withPool[i] - withoutPool[i]) + Math.abs(withPool[i + 1] - withoutPool[i + 1])
        + Math.abs(withPool[i + 2] - withoutPool[i + 2]);
      if (delta < 4) continue;
      if (x >= Math.floor(left) && x <= Math.ceil(left + s.node.width)
        && y >= Math.floor(top) && y < top + s.node.height * 0.86) cropMotion++;
      else outsideMotion++;
    }
    expect(cropMotion, 'pool effects should follow the cropped artwork').toBeGreaterThan(30);
    expect(outsideMotion, 'pool effects should not escape the cropped node').toBe(0);
  }, 60_000);

  it('moves the photographed pool surface itself, not just the overlaid foam', async () => {
    const s = await stageFall('realistic.middle.waterfall');
    if (!s || !s.m.rig?.poolRegion) throw new Error('Clearwater pool rig is missing');
    const W = 360, H = 80;
    const poolPainter = s.comp as unknown as { drawPoolWater: (
      ctx: unknown, source: unknown, imageWidth: number, imageHeight: number,
      region: [number, number, number, number], width: number, height: number,
      u: number, strength: number, opts: { scale: number; quality: 'export'; time: number },
    ) => void };
    const frame = (u: number) => {
      const { cv, ctx } = ctx2d(W, H);
      poolPainter.drawPoolWater(ctx, s.img, s.img.width, s.img.height, s.m.rig!.poolRegion!,
        W, H, u, 1, { scale: 1, quality: 'export', time: u });
      return pixels(cv, ctx);
    };
    const a = frame(0.13), b = frame(0.33), loop = frame(1.13);
    // Optical flow from the real rendered texture, across both cross-fades:
    // left water travels left, right water right, and the pool flows forward.
    for (const t of [0.05, 0.11, 0.18, 0.24, 0.30, 0.36, 0.43, 0.49]) {
      const ap = frame(t), bp = frame(t + 0.002);
      const velocityY = flowDown(lumaPlane(ap, W, 90, 270, 25, 56), lumaPlane(bp, W, 90, 270, 25, 56), 0.002);
      const left = flowRight(lumaPlane(ap, W, 85, 145, 25, 56), lumaPlane(bp, W, 85, 145, 25, 56), 0.002);
      const right = flowRight(lumaPlane(ap, W, 215, 275, 25, 56), lumaPlane(bp, W, 215, 275, 25, 56), 0.002);
      expect(velocityY, `phase ${t}: water should flow toward the foreground`).toBeGreaterThan(0);
      expect(left, `phase ${t}: left-hand water should spread left`).toBeLessThan(0);
      expect(right, `phase ${t}: right-hand water should spread right`).toBeGreaterThan(0);
    }
    let changed = 0, foreground = 0, outside = 0, seam = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta > 10 && a[i + 3] > 100 && b[i + 3] > 100) {
        changed++;
        if (y > H * 0.55) foreground++;
      }
      if (x < 5 || x >= W - 5 || y < 3 || y >= H - 3) outside = Math.max(outside, a[i + 3]);
      for (let k = 0; k < 4; k++) seam = Math.max(seam, Math.abs(a[i + k] - loop[i + k]));
    }
    expect(changed, 'painted water texture should visibly undulate').toBeGreaterThan(3000);
    expect(foreground, 'movement must reach the water in front').toBeGreaterThan(500);
    expect(outside, 'the textured water must fade before the pool boundary').toBeLessThan(24);
    expect(seam, 'the texture must loop seamlessly').toBeLessThanOrEqual(1);
  }, 60_000);

  it('runs water over the painted lip instead of switching on below it', async () => {
    for (const id of FALLS) {
      const s = await stageFall(id);
      if (!s) continue;
      const region = s.m.rig!.region as [number, number, number, number];
      const GW = 320;
      const GH = Math.round(GW * (region[3] * s.img.height) / (region[2] * s.img.width));
      const { buildFallGeometry } = await import('../src/render/waterfall');
      const geo = buildFallGeometry(
        s.img as unknown as CanvasImageSource,
        { sx: 0, sy: 0, sw: s.img.width, sh: s.img.height }, region, GW, GH,
      )!;
      const hero = geo.streams[0];
      const left = s.node.x - s.node.width / 2;
      const top = s.node.y - s.node.height / 2;
      const regTop = top + region[1] * s.node.height;
      const regH = region[3] * s.node.height;
      const lipY = regTop + (hero.lipY / GH) * regH;
      const lipX0 = left + (region[0] + (hero.lip.x0 / GW) * region[2]) * s.node.width;
      const lipX1 = left + (region[0] + (hero.lip.x1 / GW) * region[2]) * s.node.width;
      // The shelf a hair upstream of the lip - rock in the painting, water in
      // the animation: sheen and rivulets must be moving there.
      const bandTop = Math.max(regTop, lipY - regH * 0.05);
      const a = s.draw(0.4), b = s.draw(1.15);
      let changed = 0;
      for (let y = Math.round(bandTop); y < Math.round(lipY); y++) {
        for (let x = Math.round(lipX0 + 4); x < Math.round(lipX1 - 4); x++) {
          const i = (y * s.scene.canvas.width + x) * 4;
          if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) changed++;
        }
      }
      expect(changed, `${id}: water must be seen going over the lip`).toBeGreaterThan(20);
    }
  }, 60_000);

  it('moves the water while the surrounding rock stays put', async () => {
    for (const id of FALLS) {
      const s = await stageFall(id);
      if (!s) continue;
      const region = s.m.rig!.region as [number, number, number, number];
      const left = s.node.x - s.node.width / 2;
      const top = s.node.y - s.node.height / 2;
      const x0 = Math.round(left + region[0] * s.node.width);
      const x1 = Math.round(left + (region[0] + region[2]) * s.node.width);
      const y0 = Math.round(top + region[1] * s.node.height);
      const y1 = Math.round(top + (region[1] + region[3]) * s.node.height);
      const a = s.draw(0.4), b = s.draw(1.05);
      let inside = 0, insideN = 0;
      let maxOutside = 0, outX = 0, outY = 0;
      const W = s.scene.canvas.width, H = s.scene.canvas.height;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          const pool = s.m.rig?.poolRegion;
          const inPool = pool && x >= Math.round(left + pool[0] * s.node.width)
            && x < Math.round(left + (pool[0] + pool[2]) * s.node.width)
            && y >= Math.round(top + pool[1] * s.node.height)
            && y < Math.round(top + (pool[1] + pool[3]) * s.node.height);
          const inRegion = (x >= x0 && x < x1 && y >= y0 && y < y1) || inPool;
          if (inRegion) { inside += d; insideN++; }
          else if (d > maxOutside) { maxOutside = d; outX = x; outY = y; }
        }
      }
      expect(insideN).toBeGreaterThan(1000);
      expect(inside / insideN, `${id}: the painted water must actually move`).toBeGreaterThan(0.6);
      // Antialiased boundary rows may differ by a hair; more is leakage.
      // A photographic plate is resampled, so a handful of antialiased edge
      // pixels may differ by a step or two of 255. Anything more is leakage.
      expect(maxOutside, `${id}: nothing outside the fall may move (worst at ${outX},${outY}; region ${x0},${y0}-${x1},${y1})`).toBeLessThanOrEqual(4);
    }
  }, 60_000);
});
