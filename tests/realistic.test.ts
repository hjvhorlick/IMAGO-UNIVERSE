import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene, fitBackground } from '../src/scene/sceneModel';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { inWorldCollection } from '../src/assets/worldCollections';
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

describe('photographic rooms', () => {
  const ROOMS = ['japanese-modern-room', 'glass-pavilion-lounge', 'woodstone-lounge',
    'minimal-glass-loft', 'japanese-engawa-room'];

  it('ships rooms with real floor-to-roof glass openings', async () => {
    const lib = library();
    for (const id of ROOMS) {
      const meta = lib.get(`realistic.foreground.${id}`)!;
      expect(meta, id).toBeDefined();
      expect(meta.category).toBe('interiors');
      expect(meta.alpha).toBe(true);
      expect(meta.rig?.type).toBe('window-overlay');
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const al = ctx.getImageData(0, 0, img.width, img.height).data;
      let open = 0;
      for (let i = 3; i < al.length; i += 4) if (al[i] < 10) open++;
      const fraction = open / (al.length / 4);
      expect(fraction, `${id} glass is too small to bring the outside in`).toBeGreaterThan(0.08);
      expect(fraction, `${id} is mostly hole`).toBeLessThan(0.6);
    }
  });

  it('measures every hearth region so the fire lands on the flames, not the wall', async () => {
    const lib = library();
    for (const id of [...ROOMS, 'stone-fireplace', 'linear-fireplace']) {
      const meta = lib.get(`realistic.foreground.${id}`)!;
      const region = meta.rig?.region as number[] | undefined;
      expect(region, `${id} has no hearth region`).toBeDefined();
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const x0 = Math.floor(region![0] * img.width), y0 = Math.floor(region![1] * img.height);
      const w = Math.max(1, Math.floor(region![2] * img.width)), h = Math.max(1, Math.floor(region![3] * img.height));
      let flame = 0, total = 0;
      for (let y = y0; y < Math.min(img.height, y0 + h); y++) {
        for (let x = x0; x < Math.min(img.width, x0 + w); x++) {
          const i = (y * img.width + x) * 4;
          if (data[i + 3] < 250) continue;
          total++;
          // Flame: very bright, strongly warm, blue-poor.
          if (data[i] > 220 && data[i + 1] > 90 && data[i + 2] < 125 && data[i] - data[i + 2] > 135) flame++;
        }
      }
      expect(total, `${id} hearth region is off the plate`).toBeGreaterThan(0);
      expect(flame / total, `${id} fire would animate the wrong pixels`).toBeGreaterThan(0.02);
    }
  });

  it('keeps the fire optional - a placed room starts still', () => {
    const lib = library();
    const scene = createScene('realistic');
    for (const id of ROOMS) {
      const node = createAssetNode(lib.get(`realistic.foreground.${id}`)!, scene);
      expect(node.animation?.type, id).toBe('hearth-fire');
      expect(node.animation?.enabled, `${id} must not light itself`).toBe(false);
      scene.nodes.push(node);
    }
    expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(ROOMS.length);
  });

  it('brings the composed world in through the glass', async () => {
    const lib = library();
    const bg = lib.get('realistic.background.clearwater-lake')!;
    const room = lib.get('realistic.foreground.japanese-modern-room')!;
    const bgImg = await loadImage(path.join(ROOT, 'public/library', bg.file));
    const roomImg = await loadImage(path.join(ROOT, 'public/library', room.file));
    const images = { peek: (key: string | undefined) => key === bg.id
        ? { bitmap: bgImg, width: bgImg.width, height: bgImg.height }
        : { bitmap: roomImg, width: roomImg.width, height: roomImg.height },
      ensure: async () => {}, stats: { count: 2, bytes: 0, pending: 0 } };
    const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
    const scene = createScene('realistic');
    scene.canvas.width = 640; scene.canvas.height = 360;
    const bgNode = createAssetNode(bg, scene);
    fitBackground(bgNode, scene, bg.width, bg.height);
    scene.nodes = [bgNode];
    const draw = () => {
      const cv = createCanvas(640, 360), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: 0, skipLighting: true });
      return Buffer.from(ctx.getImageData(0, 0, 640, 360).data);
    };
    const outside = draw();
    scene.nodes.push(createAssetNode(room, scene));
    const inside = draw();
    let through = 0;
    for (let i = 0; i < outside.length; i += 4) {
      if (Math.abs(outside[i] - inside[i]) <= 6) through++;
    }
    expect(through / (outside.length / 4), 'the glass is not showing the world outside')
      .toBeGreaterThan(0.06);
  });

  it('ships minimal furniture as separate, independently placeable props', () => {
    const lib = library();
    const scene = createScene('realistic');
    for (const id of ['minimal-wood-bench', 'low-wood-table', 'linen-floor-cushions']) {
      const meta = lib.get(`realistic.foreground.${id}`)!;
      expect(meta.category).toBe('interiors');
      expect(meta.alpha).toBe(true);
      expect(meta.animations, `${id} should be a still prop`).toEqual([]);
      scene.nodes.push(createAssetNode(meta, scene));
    }
    const bench = scene.nodes[0];
    const table = scene.nodes[1];
    const before = table.x;
    bench.x += 60;
    expect(table.x, 'moving one prop moved another').toBe(before);
  });
});

describe('photographic figures and fire', () => {
  const FIGURES = ['seated-meditation', 'seated-meditation-side', 'standing-prayer',
    'tree-pose', 'standing-mountain'];

  it('ships meditating figures that are still until you ask them to breathe', async () => {
    const lib = library();
    const scene = createScene('realistic');
    for (const id of FIGURES) {
      const meta = lib.get(`realistic.middle.${id}`)!;
      expect(meta, id).toBeDefined();
      expect(meta.category).toBe('figures');
      expect(meta.animations).toEqual(['creature-breathe']);
      expect(inWorldCollection(meta, 'lotus-sanctuary'), `${id} not offered in the lotus world`).toBe(true);
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const al = ctx.getImageData(0, 0, img.width, img.height).data;
      let edge = 0, haze = 0;
      for (let x = 0; x < img.width; x++) {
        edge = Math.max(edge, al[x * 4 + 3], al[((img.height - 1) * img.width + x) * 4 + 3]);
      }
      for (let y = 0; y < img.height; y++) {
        edge = Math.max(edge, al[y * img.width * 4 + 3], al[(y * img.width + img.width - 1) * 4 + 3]);
      }
      for (let i = 3; i < al.length; i += 4) if (al[i] > 5 && al[i] < 200) haze++;
      expect(edge, `${id} touches its plate edge`).toBe(0);
      // Figures shot against open backdrop key to a translucent veil unless the
      // matte is crisper than the raw key.
      expect(haze / (al.length / 4), `${id} is veiled in keyed background`).toBeLessThan(0.06);
      const node = createAssetNode(meta, scene);
      expect(node.animation?.enabled, `${id} must not breathe on its own`).toBe(false);
      scene.nodes.push(node);
    }
    expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(FIGURES.length);
  });

  it('breathes the figures exactly - no drift at the loop boundary', async () => {
    for (const id of ['seated-meditation', 'standing-mountain']) {
      const { node, loops, render } = await stage(`realistic.middle.${id}`, 240);
      expect(render(0).equals(render(2.4)), `${id} is still before motion`).toBe(true);
      node.animation!.enabled = true;
      node.animation!.amplitude = 1;
      loops.invalidate();
      expect(render(0).equals(render(node.animation!.loop)), `${id} breathing must loop`).toBe(true);
      expect(render(0).equals(render(node.animation!.loop * 0.3)), `${id} must breathe`).toBe(false);
    }
  });

  it('ships placeable fireplaces whose fire is optional', () => {
    const lib = library();
    const scene = createScene('realistic');
    for (const id of ['stone-fireplace', 'linear-fireplace']) {
      const meta = lib.get(`realistic.foreground.${id}`)!;
      expect(meta.category).toBe('interiors');
      expect(meta.animations).toEqual(['hearth-fire']);
      const node = createAssetNode(meta, scene);
      expect(node.animation?.enabled, `${id} must not light itself`).toBe(false);
      scene.nodes.push(node);
    }
    expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(2);
  });

  it('draws no fire at zero strength and loops exactly at full strength', async () => {
    const { node, loops, render } = await stage('realistic.foreground.stone-fireplace', 260);
    const cold = render(0);
    expect(cold.equals(render(2.9)), 'fire is off, nothing should move').toBe(true);
    node.animation!.enabled = true;
    node.animation!.amplitude = 0;
    loops.invalidate();
    expect(render(0).equals(cold), 'zero strength must draw nothing').toBe(true);
    node.animation!.amplitude = 1;
    loops.invalidate();
    expect(render(0).equals(render(2.9)), 'fire is lit, it should move').toBe(false);
    expect(render(0).equals(render(node.animation!.loop)), 'fire must loop exactly').toBe(true);
  });

  it('lifts glowing embers that rise above the flame bed', async () => {
    const { node, loops, render } = await stage('realistic.foreground.stone-fireplace', 260);
    node.animation!.enabled = true;
    loops.invalidate();
    // Sample several phases: an ember is only bright for part of its flight.
    const lit = new Set<number>();
    const base = render(0);
    for (const f of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      const frame = render(node.animation!.loop * f);
      for (let i = 0; i < frame.length; i += 4) {
        if (frame[i] - base[i] > 10 && frame[i + 1] - base[i + 1] > 4) lit.add(i / 4);
      }
    }
    expect(lit.size, 'no embers or flames appeared').toBeGreaterThan(50);
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
