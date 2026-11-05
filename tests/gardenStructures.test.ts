import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { switchStyle, findStyleClashes } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
const IDS = ['fairy-mushroom-cottage', 'japanese-garden-bridge', 'norse-stone-well'];
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('placeable garden structures', () => {
  it('provides independent, style-matched assets across all three palettes', () => {
    const lib = library();
    const scene = createScene('enchanted');
    for (const id of IDS) {
      const meta = lib.get(`enchanted.middle.${id}`)!;
      expect(meta.category).toBe('decorations');
      expect(meta.alpha).toBe(true);
      expect(meta.animations).toEqual([]);
      scene.nodes.push(createAssetNode(meta, scene));
    }
    expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(3);
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const id of IDS) expect(scene.nodes.some((n) => n.assetId === `${style}.middle.${id}`)).toBe(true);
    }
  });

  it('shows the scene through the garden bridge rails and underneath its span', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.middle.japanese-garden-bridge`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const canvas = createCanvas(img.width, img.height), ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const alpha = (x: number, y: number) => ctx.getImageData(Math.floor(x * img.width), Math.floor(y * img.height), 1, 1).data[3];
      expect(alpha(0.50, 0.40), `${style} rails`).toBeLessThan(5);
      expect(alpha(0.50, 0.60), `${style} deck`).toBeGreaterThan(250);
      expect(alpha(0.50, 0.80), `${style} span`).toBeLessThan(5);
    }
  });
});
