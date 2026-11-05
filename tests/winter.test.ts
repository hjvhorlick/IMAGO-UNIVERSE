import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { switchStyle, findStyleClashes, styleStats } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
/** The painted winter plates - everything except the shared interiors. */
const OUTDOOR = [
  'middle.snow-pine', 'middle.bare-winter-tree', 'middle.ice-pavilion',
  'foreground.snow-drift', 'foreground.snowdrops', 'foreground.frost-grasses',
  'foreground.winter-berries', 'foreground.frost-fern',
];
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('the painted winter look', () => {
  it('registers Frostfall as a complete style of its own', () => {
    const lib = library();
    const winter = lib.style('winter');
    expect(winter, 'winter style is registered').toBeDefined();
    expect(winter!.name).toBe('Frostfall');
    expect(winter!.complete).toBe(true);
    const stats = styleStats(lib, 'winter');
    expect(stats.background, 'winter backgrounds').toBeGreaterThanOrEqual(2);
    expect(stats.middle).toBeGreaterThanOrEqual(3);
    expect(stats.foreground).toBeGreaterThanOrEqual(5);
  });

  it('is painted from its own plates rather than graded from another look', () => {
    const lib = library();
    for (const key of OUTDOOR) {
      const meta = lib.get(`winter.${key}`)!;
      expect(meta, `winter.${key}`).toBeDefined();
      // "Graded" would mean this is only a recolouring of an existing plate.
      expect(meta.origin, `${key} must not be a grade`).toBe('painted');
      expect(meta.alpha).toBe(true);
    }
    // Rooms have no season, so they are shared rather than repainted - but the
    // Rooms tab must still have something to show in this look.
    expect(lib.get('winter.foreground.lounge-window'), 'winter room view').toBeDefined();
  });

  it('keeps every winter plate transparent around its full boundary', async () => {
    const lib = library();
    for (const key of OUTDOOR) {
      const meta = lib.get(`winter.${key}`)!;
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

  it('composes and cross-fades a whole scene into winter without losing anything', () => {
    const lib = library();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 99 });
    const before = scene.nodes.length;
    expect(before).toBeGreaterThan(5);

    const report = switchStyle(scene, lib, 'winter');
    expect(scene.styleId).toBe('winter');
    // No object should be discarded just because this look has fewer plates.
    expect(report.removed, 'objects dropped by the winter switch').toEqual([]);
    expect(findStyleClashes(scene, lib)).toEqual([]);
    for (const node of scene.nodes) {
      if (node.kind === 'effect') continue;
      const meta = lib.get(node.assetId);
      expect(meta, `${node.name} has no asset`).toBeDefined();
      expect(meta!.style, `${node.name} is not a winter asset`).toBe('winter');
    }
    expect(scene.nodes.filter((n) => n.kind !== 'effect').length).toBe(before);

    // And back again, so switching looks is reversible rather than one-way.
    const back = switchStyle(scene, lib, 'enchanted');
    expect(back.removed).toEqual([]);
    expect(findStyleClashes(scene, lib)).toEqual([]);
  });

  it('sways the snow-laden pine and returns exactly to the first frame', async () => {
    const lib = library();
    const meta = lib.get('winter.middle.snow-pine')!;
    const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
    const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
    const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
    const scene = createScene('winter'); scene.canvas.width = 400; scene.canvas.height = 300;
    const node = createAssetNode(meta, scene); node.x = 200; node.y = 150;
    node.height = 260; node.width = node.height * meta.width / meta.height;
    node.animation!.seed = 41; node.animation!.amplitude = 1; node.animation!.turbulence = 0.6;
    scene.nodes = [node];
    const render = (t: number) => {
      const cv = createCanvas(400, 300), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
      return Buffer.from(ctx.getImageData(0, 0, 400, 300).data);
    };
    expect(render(0).equals(render(3.1)), 'pine is still before motion is enabled').toBe(true);
    node.animation!.enabled = true;
    loops.invalidate();
    expect(render(0).equals(render(node.animation!.loop)), 'sway must loop exactly').toBe(true);
    expect(render(0).equals(render(node.animation!.loop * 0.27)), 'sway must move').toBe(false);
  });
});
