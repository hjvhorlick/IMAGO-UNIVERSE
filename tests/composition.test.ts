/** Acceptance tests for composition, grounding, depth and controlled regeneration. */
import { describe, expect, it } from 'vitest';
import { autoCompose, DEFAULT_COMPOSE, reground, sortByDepth } from '../src/scene/composition';
import { createAssetNode, createScene, groundLine, layerNodes, paintOrder, resizeCanvas } from '../src/scene/sceneModel';
import { LAYER_ORDER } from '../src/core/types';
import { testLibrary } from './helpers';

describe('automatic composition', () => {
  it('builds a complete environment across the first three layers', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    const r = autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 7 });
    expect(r.added).toBeGreaterThan(8);
    expect(layerNodes(scene, 'background').length).toBe(1);
    expect(layerNodes(scene, 'middle').length).toBeGreaterThan(2);
    expect(layerNodes(scene, 'foreground').length).toBeGreaterThan(4);
  });

  it('only ever uses artwork from the active style', () => {
    const lib = testLibrary();
    const scene = createScene('moonlit');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 3 });
    for (const n of scene.nodes) {
      const m = lib.get(n.assetId);
      expect(m?.style).toBe('moonlit');
    }
  });

  it('is deterministic for a given seed', () => {
    const lib = testLibrary();
    const a = createScene('enchanted'); const b = createScene('enchanted');
    autoCompose(a, lib, { ...DEFAULT_COMPOSE, seed: 99 });
    autoCompose(b, lib, { ...DEFAULT_COMPOSE, seed: 99 });
    const sig = (s: typeof a) => s.nodes.map((n) => `${n.assetId}:${Math.round(n.x)}:${Math.round(n.y)}`).join('|');
    expect(sig(a)).toBe(sig(b));
  });

  it('never moves or replaces locked objects', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 11 });
    const hero = layerNodes(scene, 'middle')[0];
    hero.locked = true;
    hero.name = 'My hero tree';
    const before = { ...hero };
    const bg = layerNodes(scene, 'background')[0];
    bg.locked = true;

    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 4242, replaceUnlocked: true });
    const kept = scene.nodes.find((n) => n.id === hero.id)!;
    expect(kept).toBeDefined();
    expect(kept.x).toBe(before.x);
    expect(kept.y).toBe(before.y);
    expect(kept.width).toBe(before.width);
    expect(kept.assetId).toBe(before.assetId);
    expect(kept.name).toBe('My hero tree');
    expect(scene.nodes.some((n) => n.id === bg.id)).toBe(true);
  });

  it('keeps atmospheric effects when regenerating the environment', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 5 });
    const fx = { ...layerNodes(scene, 'middle')[0], id: 'fx1', kind: 'effect' as const, layer: 'atmosphere' as const };
    scene.nodes.push(fx);
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 6, replaceUnlocked: true });
    expect(scene.nodes.some((n) => n.id === 'fx1')).toBe(true);
  });

  it('grounds every object on the ground line for its depth', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 21 });
    for (const n of scene.nodes) {
      const m = lib.get(n.assetId)!;
      if (m.layer === 'background') continue;
      const bottom = n.y + n.height / 2;
      expect(bottom).toBeCloseTo(groundLine(scene, n.depth) + n.height * (1 - m.groundContact), 4);
    }
  });

  it('makes distant objects smaller than near ones of the same asset', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    const m = lib.get('enchanted.middle.oak')!;
    const far = createAssetNode(m, scene, { depth: 0.15 });
    const near = createAssetNode(m, scene, { depth: 0.9 });
    expect(near.height).toBeGreaterThan(far.height * 1.5);
    expect(groundLine(scene, 0.9)).toBeGreaterThan(groundLine(scene, 0.15));
  });

  it('allows foreground objects to extend past the canvas edges', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 8, foreground: 1 });
    const overflowing = layerNodes(scene, 'foreground').filter((n) =>
      n.x - n.width / 2 < 0 || n.x + n.width / 2 > scene.canvas.width);
    expect(overflowing.length).toBeGreaterThan(0);
  });

  it('re-grounding restores the base after an object is moved', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 31 });
    const n = layerNodes(scene, 'middle').find((x) => !x.locked)!;
    n.y -= 300;
    reground(scene, lib);
    const m = lib.get(n.assetId)!;
    expect(n.y + n.height / 2).toBeCloseTo(groundLine(scene, n.depth) + n.height * (1 - m.groundContact), 4);
  });

  it('sorting by depth makes near objects paint last', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 12 });
    sortByDepth(scene);
    const mid = layerNodes(scene, 'middle');
    for (let i = 1; i < mid.length; i++) expect(mid[i].depth).toBeGreaterThanOrEqual(mid[i - 1].depth);
  });
});

describe('scene structure', () => {
  it('paints strictly background -> middle -> foreground -> atmosphere', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 2 });
    scene.nodes.push({ ...layerNodes(scene, 'middle')[0], id: 'fx', kind: 'effect', layer: 'atmosphere', order: 0 });
    const order = paintOrder(scene).map((n) => LAYER_ORDER.indexOf(n.layer));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
  });

  it('rescaling the canvas keeps objects proportionally placed', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted', 'a', '16:9');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 4 });
    const n = layerNodes(scene, 'middle')[0];
    const relX = n.x / scene.canvas.width;
    const relH = n.height / scene.canvas.height;
    resizeCanvas(scene, 1080, 1920, '9:16');
    expect(n.x / scene.canvas.width).toBeCloseTo(relX, 6);
    expect(n.height / scene.canvas.height).toBeCloseTo(relH, 6);
  });

  it('cropping is stored as data and never touches the asset', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    const m = lib.get('enchanted.middle.oak')!;
    const node = createAssetNode(m, scene);
    const originalFile = m.file;
    node.crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };
    node.adjust.brightness = 1.4;
    expect(lib.get(m.id)!.file).toBe(originalFile);
    expect(lib.get(m.id)!.width).toBe(700);
    expect(node.crop.w).toBe(0.5);
  });
});
