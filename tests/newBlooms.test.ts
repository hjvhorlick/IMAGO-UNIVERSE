import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { inWorldCollection } from '../src/assets/worldCollections';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene } from '../src/scene/sceneModel';

const ROOT = path.resolve(import.meta.dirname, '..');
const IDS = ['scarlet-dahlias', 'golden-sunflowers', 'white-orchids'];
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('new close-up blooms', () => {
  it('provides independent still-by-default flower assets with optional bending in each look', () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const scene = createScene(style);
      for (const id of IDS) {
        const meta = lib.get(`${style}.foreground.${id}`)!;
        expect(meta.category).toBe('flowers');
        expect(meta.alpha).toBe(true);
        expect(inWorldCollection(meta, 'japanese')).toBe(true);
        const node = createAssetNode(meta, scene);
        expect(node.animation?.type).toBe('stem-bend');
        expect(node.animation?.enabled).toBe(false);
        scene.nodes.push(node);
      }
      expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(3);
    }
  });

  it('bends only when enabled and returns exactly to the initial frame', async () => {
    const lib = library();
    for (const id of IDS) {
      const meta = lib.get(`enchanted.foreground.${id}`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
        ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
      const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
      const scene = createScene('enchanted'); scene.canvas.width = 400; scene.canvas.height = 300;
      const node = createAssetNode(meta, scene); node.x = 200; node.y = 150;
      node.height = 250; node.width = node.height * meta.width / meta.height;
      node.animation!.seed = 123; scene.nodes = [node];
      const render = (t: number) => {
        const cv = createCanvas(400, 300), ctx = cv.getContext('2d');
        comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
        return Buffer.from(ctx.getImageData(0, 0, 400, 300).data);
      };
      expect(render(0).equals(render(1.3)), `${id} still`).toBe(true);
      node.animation!.enabled = true;
      loops.invalidate();
      expect(render(0).equals(render(node.animation!.loop)), `${id} exact loop`).toBe(true);
      expect(render(0).equals(render(1.3)), `${id} motion`).toBe(false);
    }
  });
});
