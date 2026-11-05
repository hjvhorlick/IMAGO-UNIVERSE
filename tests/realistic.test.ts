import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { switchStyle, findStyleClashes } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLATES = [
  'middle.water-rocks', 'middle.driftwood', 'middle.lily-pads',
  'foreground.water-surface', 'foreground.shallow-ripples', 'foreground.river-stones',
  'foreground.reeds', 'foreground.water-droplets',
];
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

/** A compositor over one plate, with a render helper at an arbitrary time. */
async function stage(assetId: string, height = 240) {
  const lib = library();
  const meta = lib.get(assetId)!;
  const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
  const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
    ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
  const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
  const scene = createScene(meta.style);
  scene.canvas.width = 360; scene.canvas.height = 260;
  const node = createAssetNode(meta, scene);
  node.x = 180; node.y = 130; node.height = height;
  node.width = node.height * meta.width / meta.height;
  scene.nodes = [node];
  const render = (t: number) => {
    const cv = createCanvas(360, 260), ctx = cv.getContext('2d');
    comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
    return Buffer.from(ctx.getImageData(0, 0, 360, 260).data);
  };
  return { lib, meta, scene, node, loops, render };
}

describe('the ultra-realistic Clearwater look', () => {
  it('registers Clearwater as a complete photographic style', () => {
    const lib = library();
    const real = lib.style('realistic');
    expect(real, 'realistic style is registered').toBeDefined();
    expect(real!.name).toBe('Clearwater');
    expect(real!.complete).toBe(true);
    for (const key of PLATES) {
      const meta = lib.get(`realistic.${key}`)!;
      expect(meta, `realistic.${key}`).toBeDefined();
      expect(meta.origin, `${key} must be photographed, not graded`).toBe('painted');
      expect(meta.themes).toContain('photoreal');
    }
  });

  it('keeps every plate transparent around its full boundary', async () => {
    const lib = library();
    for (const key of PLATES) {
      const meta = lib.get(`realistic.${key}`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      let edge = 0, magenta = 0;
      for (let x = 0; x < img.width; x++) {
        edge = Math.max(edge, data[x * 4 + 3], data[((img.height - 1) * img.width + x) * 4 + 3]);
      }
      for (let y = 0; y < img.height; y++) {
        edge = Math.max(edge, data[y * img.width * 4 + 3], data[(y * img.width + img.width - 1) * 4 + 3]);
      }
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 250 && Math.min(data[i], data[i + 2]) - data[i + 1] > 18) magenta++;
      }
      expect(edge, `${key} touches its plate edge`).toBe(0);
      expect(magenta / (data.length / 4), `${key} magenta residue`).toBeLessThan(0.01);
    }
  });

  it('composes a scene and carries it into Clearwater without dropping anything', () => {
    const lib = library();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 7 });
    const before = scene.nodes.length;
    const report = switchStyle(scene, lib, 'realistic');
    expect(report.removed, 'objects dropped by the realistic switch').toEqual([]);
    expect(findStyleClashes(scene, lib)).toEqual([]);
    expect(scene.nodes.filter((n) => n.kind !== 'effect').length).toBe(before);
  });
});

describe('water sparkle', () => {
  it('adds visible glints only once motion is enabled', async () => {
    const { node, render } = await stage('realistic.foreground.water-surface');
    const still = render(0);
    expect(still.equals(render(2.2)), 'still before enabling').toBe(true);
    node.animation!.enabled = true;
    const moved = render(2.2);
    let brighter = 0;
    for (let i = 0; i < still.length; i += 4) {
      if (moved[i] - still[i] > 6) brighter++;
    }
    expect(brighter, 'no glints appeared').toBeGreaterThan(40);
  });

  it('twinkles exactly - the loop boundary is pixel-identical', async () => {
    const { node, loops, render } = await stage('realistic.foreground.water-surface');
    node.animation!.enabled = true;
    node.animation!.seed = 2026;
    node.animation!.amplitude = 1;
    loops.invalidate();
    expect(render(0).equals(render(node.animation!.loop)), 'sparkle must loop exactly').toBe(true);
    expect(render(0).equals(render(node.animation!.loop * 0.37)), 'sparkle must twinkle').toBe(false);
  });

  it('confines glints to the wet region of the plate', async () => {
    // Rocks stand in water: the rig declares water below 42% of the height.
    const { meta, node, loops, render } = await stage('realistic.middle.water-rocks', 220);
    const regionTop = meta.rig?.region?.[1] ?? 0;
    expect(regionTop, 'water-rocks needs a water region').toBeCloseTo(0.42, 5);
    const dry = render(0);
    node.animation!.enabled = true;
    node.animation!.type = 'sparkle';
    node.animation!.amplitude = 1;
    loops.invalidate();
    // Each glint flashes for part of the cycle, so sample several phases and
    // take the union - otherwise the check is a coin toss on when it looked.
    const top = 130 - node.height / 2 + regionTop * node.height;
    let above = 0, below = 0;
    for (const f of [0.08, 0.21, 0.34, 0.47, 0.61, 0.74, 0.88]) {
      const wet = render(node.animation!.loop * f);
      for (let y = 0; y < 260; y++) {
        for (let x = 0; x < 360; x++) {
          const i = (y * 360 + x) * 4;
          if (wet[i] - dry[i] <= 6) continue;
          if (y < top - 45) above++; else below++;
        }
      }
    }
    expect(below, 'no glints in the water region').toBeGreaterThan(20);
    expect(above, 'glints leaked onto the dry rock above the waterline').toBe(0);
  });

  it('gives every seed its own patch of glitter', async () => {
    const first = await stage('realistic.foreground.water-surface');
    first.node.animation!.enabled = true;
    first.node.animation!.seed = 11;
    first.loops.invalidate();
    const a = first.render(1.7);
    const second = await stage('realistic.foreground.water-surface');
    second.node.animation!.enabled = true;
    second.node.animation!.seed = 99;
    second.loops.invalidate();
    const b = second.render(1.7);
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 6) diff++;
    expect(diff, 'different seeds produced identical glitter').toBeGreaterThan(20);
  });
});
