import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { inWorldCollection } from '../src/assets/worldCollections';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { switchStyle, findStyleClashes } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
/** layer, expected motion, worlds the creature should be offered in. */
const CREATURES: Array<[string, string, string, string[]]> = [
  ['middle.white-stag', 'creature-breathe', 'White Stag', ['fairy', 'nature']],
  ['foreground.red-fox', 'creature-breathe', 'Red Fox', ['nature']],
  ['middle.mute-swans', 'swim', 'Mute Swans', ['japanese', 'norse', 'waterside', 'lotus-sanctuary']],
  ['foreground.koi-fish', 'swim', 'Koi Fish', ['japanese', 'chinese']],
  ['foreground.butterflies', 'flutter', 'Butterflies', ['japanese', 'lotus-sanctuary']],
  ['middle.great-owl', 'creature-breathe', 'Great Owl', ['fairy']],
  ['foreground.rabbit', 'creature-breathe', 'Brown Rabbit', ['nature']],
  ['foreground.red-squirrel', 'creature-breathe', 'Red Squirrel', ['nature']],
  ['middle.mallard-ducks', 'swim', 'Mallard Ducks', ['japanese', 'waterside']],
  ['foreground.hedgehog', 'creature-breathe', 'Hedgehog', ['nature', 'chinese']],
  ['middle.deer-fawn', 'creature-breathe', 'Deer Fawn', ['nature']],
  ['foreground.moor-frog', 'creature-breathe', 'Moor Frog', ['japanese', 'lotus-sanctuary']],
  ['middle.songbird-flock', 'flutter', 'Songbird Flock', ['nature', 'japanese']],
];
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('placeable creatures', () => {
  it('ships every animal in all three looks, still until motion is opted in', () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const scene = createScene(style);
      for (const [key, motion, name, worlds] of CREATURES) {
        const meta = lib.get(`${style}.${key}`)!;
        expect(meta, `${style}.${key}`).toBeDefined();
        expect(meta.category).toBe('creatures');
        expect(meta.alpha).toBe(true);
        expect(meta.name).toContain(name);
        expect(meta.animations).toEqual([motion]);
        for (const world of worlds) {
          expect(inWorldCollection(meta, world), `${key} in ${world}`).toBe(true);
        }
        const node = createAssetNode(meta, scene);
        expect(node.animation?.type).toBe(motion);
        expect(node.animation?.enabled, `${key} must not move on placement`).toBe(false);
        scene.nodes.push(node);
      }
      // Each animal is its own object, not a group.
      expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(CREATURES.length);
    }
  });

  it('keeps animals transparent around their whole boundary in every palette', async () => {
    const lib = library();
    for (const [key] of CREATURES) {
      for (const style of ['enchanted', 'moonlit', 'autumn']) {
        const meta = lib.get(`${style}.${key}`)!;
        const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
        const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, img.width, img.height);
        let edge = 0;
        for (let x = 0; x < img.width; x++) {
          edge = Math.max(edge, data[x * 4 + 3], data[((img.height - 1) * img.width + x) * 4 + 3]);
        }
        for (let y = 0; y < img.height; y++) {
          edge = Math.max(edge, data[y * img.width * 4 + 3], data[(y * img.width + img.width - 1) * 4 + 3]);
        }
        expect(edge, `${style}.${key} touches its plate edge`).toBe(0);
      }
    }
  });

  it('keeps the bird flock crisp instead of veiled in keyed sky haze', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.middle.songbird-flock`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const al = ctx.getImageData(0, 0, img.width, img.height).data;
      let opaque = 0, haze = 0;
      for (let i = 3; i < al.length; i += 4) {
        if (al[i] > 250) opaque++;
        else if (al[i] > 5) haze++;
      }
      const total = al.length / 4;
      expect(opaque / total, `${style} flock too faint`).toBeGreaterThan(0.05);
      // A bird painted against open sky keys to a wide band of near-zero alpha;
      // that band must be ramped away or the plate arrives as a grey veil.
      expect(haze / total, `${style} flock haze`).toBeLessThan(0.05);
    }
  });

  it('animates each motion style and returns exactly to the first frame', async () => {
    const lib = library();
    for (const [key, motion] of CREATURES.filter((c) =>
      ['middle.white-stag', 'middle.mute-swans', 'foreground.butterflies'].includes(c[0]))) {
      expect(['creature-breathe', 'swim', 'flutter']).toContain(motion);
      const meta = lib.get(`enchanted.${key}`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
        ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
      const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
      const scene = createScene('enchanted'); scene.canvas.width = 400; scene.canvas.height = 300;
      const node = createAssetNode(meta, scene); node.x = 200; node.y = 150;
      node.height = 220; node.width = node.height * meta.width / meta.height;
      node.animation!.seed = 77; node.animation!.amplitude = 1; node.animation!.turbulence = 0.5;
      scene.nodes = [node];
      const render = (t: number) => {
        const cv = createCanvas(400, 300), ctx = cv.getContext('2d');
        comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
        return Buffer.from(ctx.getImageData(0, 0, 400, 300).data);
      };
      expect(render(0).equals(render(2.7)), `${key} still`).toBe(true);
      node.animation!.enabled = true;
      loops.invalidate();
      expect(render(0).equals(render(node.animation!.loop)), `${motion} exact loop`).toBe(true);
      expect(render(0).equals(render(node.animation!.loop * 0.31)), `${motion} moves`).toBe(false);
    }
  });

  it('carries animals and their motion across a look change', () => {
    const lib = library();
    const scene = createScene('enchanted');
    for (const [key] of CREATURES) {
      const node = createAssetNode(lib.get(`enchanted.${key}`)!, scene);
      node.animation!.enabled = true;
      scene.nodes.push(node);
    }
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const [key, motion] of CREATURES) {
        const node = scene.nodes.find((n) => n.assetId === `${style}.${key}`);
        expect(node, `${style}.${key}`).toBeDefined();
        expect(node!.animation?.type).toBe(motion);
        expect(node!.animation?.enabled).toBe(true);
      }
    }
  });
});
