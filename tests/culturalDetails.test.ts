import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { switchStyle, findStyleClashes } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('placeable cultural details', () => {
  it('ships independent three-palette counterparts with editable looping motion', () => {
    const lib = library(), scene = createScene('enchanted');
    const ids = ['chinese-moon-gate', 'japanese-stone-lantern', 'norse-dragon-boat'];
    for (const id of ids) {
      const meta = lib.get(`enchanted.middle.${id}`)!;
      expect(meta.category).toBe('decorations');
      expect(meta.alpha).toBe(true);
      scene.nodes.push(createAssetNode(meta, scene));
    }
    expect(scene.nodes[0].animation).toBeNull();
    expect(scene.nodes[1].animation?.type).toBe('lantern-glow');
    expect(scene.nodes[2].animation?.type).toBe('float');
    expect(scene.nodes[1].animation?.enabled).toBe(true);
    expect(scene.nodes[2].animation?.enabled).toBe(true);
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const id of ids) expect(scene.nodes.some((node) => node.assetId === `${style}.middle.${id}`)).toBe(true);
      expect(scene.nodes[1].animation?.enabled).toBe(true);
      expect(scene.nodes[2].animation?.enabled).toBe(true);
    }
  });

  it('keeps the moon gate opening transparent, with solid surrounding stone', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.middle.chinese-moon-gate`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const alpha = (x: number, y: number) => ctx.getImageData(Math.floor(x * img.width), Math.floor(y * img.height), 1, 1).data[3];
      expect(alpha(0.50, 0.50), `${style} opening`).toBeLessThan(5);
      expect(alpha(0.18, 0.50), `${style} wall`).toBeGreaterThan(250);
    }
  });

  it('cuts the boat at a rippling transparent waterline in every palette', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.middle.norse-dragon-boat`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const bottomEdges: number[] = [];
      for (let x = Math.floor(img.width * 0.15); x < img.width * 0.70; x += 8) {
        let bottom = -1;
        for (let y = img.height - 1; y >= 0; y--) {
          if (data[(y * img.width + x) * 4 + 3] > 200) { bottom = y; break; }
        }
        expect(bottom).toBeGreaterThan(img.height * 0.9);
        expect(data[((img.height - 1) * img.width + x) * 4 + 3]).toBe(0);
        bottomEdges.push(bottom);
      }
      expect(Math.max(...bottomEdges) - Math.min(...bottomEdges), `${style} waves`).toBeGreaterThan(5);
    }
  });

  it('animates the lantern and boat and returns to the exact starting pixels', async () => {
    const lib = library();
    for (const id of ['japanese-stone-lantern', 'norse-dragon-boat']) {
      const meta = lib.get(`enchanted.middle.${id}`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
        ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
      const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
      const scene = createScene('enchanted'); scene.canvas.width = 400; scene.canvas.height = 240;
      const node = createAssetNode(meta, scene); node.x = 200; node.y = 120;
      node.height = 150; node.width = node.height * meta.width / meta.height;
      node.animation!.seed = 123; scene.nodes = [node];
      const render = (t: number) => {
        const cv = createCanvas(400, 240), ctx = cv.getContext('2d');
        comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
        return Buffer.from(ctx.getImageData(0, 0, 400, 240).data);
      };
      const a = render(0), later = render(1.3), loop = render(node.animation!.loop);
      expect(a.equals(loop), `${id} loop`).toBe(true);
      expect(a.equals(later), `${id} motion`).toBe(false);
    }
  });
});
