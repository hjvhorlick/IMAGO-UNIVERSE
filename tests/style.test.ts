/** Acceptance tests for style consistency across layers 1-3 and universality of layer 4. */
import { describe, expect, it } from 'vitest';
import { findStyleClashes, referenceCollection, styleStats, switchStyle } from '../src/scene/styleManager';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { makeEffectNode } from '../src/ui/inspector';
import { EFFECTS, THEME_PRESETS, effectDefaults } from '../src/animation/effects';
import { testLibrary } from './helpers';
import { AssetLibrary } from '../src/assets/library';
import fs from 'node:fs';
import path from 'node:path';

describe('style manager', () => {
  it('exposes a five-piece reference collection for every style', () => {
    const lib = testLibrary();
    for (const style of lib.styles) {
      const refs = referenceCollection(lib, style);
      expect(refs).toHaveLength(5);
      expect(refs.map((r) => r.layer)).toEqual(['background', 'middle', 'middle', 'foreground', 'foreground']);
      expect(refs.every((r) => r.style === style.id)).toBe(true);
    }
  });

  it('filters layers 1-3 to the active style only', () => {
    const lib = testLibrary();
    for (const layer of ['background', 'middle', 'foreground'] as const) {
      const list = lib.forStyle('enchanted', layer);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((a) => a.style === 'enchanted')).toBe(true);
    }
  });

  it('search never leaks another style into the results', () => {
    const lib = testLibrary();
    const results = lib.search('moonlit', 'middle', { query: 'oak' });
    expect(results.every((r) => r.style === 'moonlit')).toBe(true);
  });

  it('swaps artwork by category and keeps every effect when changing style', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 14 });
    const fx = makeEffectNode('aurora', scene, 0);
    fx.effect!.params.intensity = 0.77;
    scene.nodes.push(fx);
    const treeBefore = scene.nodes.find((n) => lib.get(n.assetId)?.category === 'trees')!;
    const treeId = treeBefore.id;
    const treeX = treeBefore.x;

    const report = switchStyle(scene, lib, 'moonlit');
    expect(scene.styleId).toBe('moonlit');
    expect(report.keptEffects).toBe(1);
    const keptFx = scene.nodes.find((n) => n.id === fx.id)!;
    expect(keptFx.effect!.params.intensity).toBe(0.77);
    const tree = scene.nodes.find((n) => n.id === treeId);
    if (tree) {
      expect(lib.get(tree.assetId)!.style).toBe('moonlit');
      expect(lib.get(tree.assetId)!.category).toBe('trees');
      expect(tree.x).toBe(treeX);
    }
    expect(findStyleClashes(scene, lib)).toHaveLength(0);
  });

  it('detects a clash if one is ever introduced', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 2 });
    const rogue = scene.nodes.find((n) => n.layer === 'middle')!;
    rogue.assetId = 'moonlit.middle.oak';
    expect(findStyleClashes(scene, lib).length).toBe(1);
  });

  it('reports collection sizes per style', () => {
    const lib = testLibrary();
    const s = styleStats(lib, 'enchanted');
    expect(s.background).toBe(2);
    expect(s.middle).toBe(5);
    expect(s.foreground).toBe(4);
  });
});

describe('layer 4 universality', () => {
  it('offers every effect regardless of the scene style', () => {
    for (const style of ['enchanted', 'moonlit', 'anything-at-all']) {
      const scene = createScene(style);
      for (const def of EFFECTS) {
        const node = makeEffectNode(def.id, scene, 0);
        expect(node.layer).toBe('atmosphere');
        expect(node.effect!.effectId).toBe(def.id);
      }
    }
  });

  it('gives every effect only its own relevant parameters', () => {
    for (const def of EFFECTS) {
      const params = effectDefaults(def.id);
      expect(Object.keys(params).sort()).toEqual(def.params.map((p) => p.key).sort());
      for (const p of def.params) {
        if (p.type === 'range') {
          expect(typeof params[p.key]).toBe('number');
          expect(p.min).toBeLessThan(p.max!);
          expect(Number(params[p.key])).toBeGreaterThanOrEqual(p.min!);
          expect(Number(params[p.key])).toBeLessThanOrEqual(p.max!);
        }
        if (p.type === 'color') expect(String(params[p.key])).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('ships at least ten atmospheric effects and six theme collections', () => {
    expect(EFFECTS.length).toBeGreaterThanOrEqual(10);
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(EFFECTS.some((e) => e.id === 'zodiac-wheel')).toBe(true);
    expect(EFFECTS.some((e) => e.id === 'floating-lanterns')).toBe(true);
    expect(THEME_PRESETS.some((t) => t.id === 'japanese')).toBe(true);
    expect(THEME_PRESETS.some((t) => t.id === 'mythic-zodiac')).toBe(true);
    for (const t of THEME_PRESETS) {
      expect(t.effects.length).toBeGreaterThan(1);
      for (const e of t.effects) expect(EFFECTS.some((x) => x.id === e.id)).toBe(true);
    }
  });

  it('keeps each themed scenario inside the selected effects’ real controls', () => {
    for (const theme of THEME_PRESETS) {
      for (const entry of theme.effects) {
        const effect = EFFECTS.find((x) => x.id === entry.id)!;
        for (const [key, value] of Object.entries(entry.params ?? {})) {
          const param = effect.params.find((p) => p.key === key);
          expect(param, `${theme.id}.${entry.id} has no ${key} control`).toBeTruthy();
          if (param?.type === 'range') {
            expect(Number(value), `${theme.id}.${entry.id}.${key}`).toBeGreaterThanOrEqual(param.min!);
            expect(Number(value), `${theme.id}.${entry.id}.${key}`).toBeLessThanOrEqual(param.max!);
          }
          if (param?.type === 'color') expect(String(value)).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it('keeps effects out of the style filter entirely', () => {
    const lib = testLibrary();
    const scene = createScene('enchanted');
    scene.nodes.push(makeEffectNode('snow', scene, 0));
    expect(findStyleClashes(scene, lib)).toHaveLength(0);
    switchStyle(scene, lib, 'moonlit');
    expect(scene.nodes.filter((n) => n.kind === 'effect')).toHaveLength(1);
  });
});

/**
 * The tests above use a synthetic library so they stay fast. These check the
 * library that actually ships, because a broken manifest entry is exactly the
 * kind of thing a synthetic fixture cannot catch.
 */
describe('the published library', () => {
  function shipped() {
    const lib = new AssetLibrary();
    lib.manifest = JSON.parse(fs.readFileSync(
      path.join(path.resolve(import.meta.dirname, '..'), 'public/library/manifest.json'), 'utf8'));
    return lib;
  }

  it('every registered style is complete and internally consistent', () => {
    const lib = shipped();
    expect(lib.styles.length).toBeGreaterThanOrEqual(3);
    for (const style of lib.styles) {
      expect(style.complete, `${style.id} is registered but incomplete`).toBe(true);
      const refs = referenceCollection(lib, style);
      expect(refs, `${style.id} reference collection`).toHaveLength(5);
      expect(refs.every((r) => r.style === style.id)).toBe(true);
      expect(refs.map((r) => r.layer)).toEqual(
        ['background', 'middle', 'middle', 'foreground', 'foreground']);
      // Every declared reference id must resolve, and to the right style.
      for (const id of Object.values(style.reference)) {
        const asset = lib.get(id as string);
        expect(asset, `${style.id} reference ${id} is missing`).toBeTruthy();
        expect(asset!.style).toBe(style.id);
      }
      const stats = styleStats(lib, style.id);
      expect(stats.background, `${style.id} backgrounds`).toBeGreaterThanOrEqual(1);
      expect(stats.middle, `${style.id} middle-ground`).toBeGreaterThanOrEqual(3);
      expect(stats.foreground, `${style.id} foreground`).toBeGreaterThanOrEqual(3);
    }
  });

  it('meets the starter library targets and includes room-view overlays in every style', () => {
    const lib = shipped();
    const count = (layer: string) => lib.assets.filter((a) => a.layer === layer).length;
    expect(count('background')).toBeGreaterThanOrEqual(5);
    expect(count('middle')).toBeGreaterThanOrEqual(8);
    expect(count('foreground')).toBeGreaterThanOrEqual(8);
    expect(EFFECTS.length).toBeGreaterThanOrEqual(10);
    for (const style of lib.styles) {
      const room = lib.get(`${style.id}.foreground.lounge-window`);
      expect(room, `${style.id} lounge window`).toBeTruthy();
      expect(room!.alpha).toBe(true);
      expect(room!.rig?.type).toBe('window-overlay');
      expect(room!.tags).toContain('window');
    }
  });

  it('every asset declares a known origin and points at a real file', () => {
    const lib = shipped();
    const root = path.resolve(import.meta.dirname, '..');
    const origins = new Set(['painted', 'graded', 'composed', 'derived', 'imported']);
    for (const a of lib.assets) {
      expect(origins.has(a.origin), `${a.id} has unknown origin "${a.origin}"`).toBe(true);
      expect(fs.existsSync(path.join(root, 'public/library', a.file)), `${a.id} file missing`).toBe(true);
      expect(fs.existsSync(path.join(root, 'public/library', a.thumb)), `${a.id} thumb missing`).toBe(true);
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
    }
  });

  it('keeps detailed close-up flower varieties intact when switching palettes', () => {
    const lib = shipped();
    const scene = createScene('enchanted');
    const ids = ['woodland-foxgloves', 'wild-roses', 'woodland-anemones',
      'wild-poppies', 'rose-peonies', 'golden-irises', 'lotus-flowers'];
    for (const id of ids) {
      const meta = lib.get(`enchanted.foreground.${id}`)!;
      expect(meta.origin).toBe('painted');
      expect(meta.width).toBeGreaterThan(600);
      expect(meta.height).toBeGreaterThan(500);
      expect(meta.animations).toContain('stem-bend');
      const node = createAssetNode(meta, scene);
      node.animation!.enabled = true;
      scene.nodes.push(node);
    }
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const id of ids) {
        const node = scene.nodes.find((n) => n.assetId === `${style}.foreground.${id}`);
        expect(node, `${style} ${id}`).toBeDefined();
        expect(node!.animation?.enabled).toBe(true);
        expect(node!.animation?.type).toBe('stem-bend');
      }
    }
  });

  it('keeps landmark sets paired with their story backdrops across palettes', () => {
    const lib = shipped();
    const stories = [
      ['enchanted.background.fairy-court', 'fairy', 'enchanted.middle.fairy-tree', 'enchanted.foreground.fae-mushrooms'],
      ['enchanted.background.norse-worldtree', 'norse', 'enchanted.middle.norse-rune-stones', 'enchanted.foreground.norse-frost-pine'],
      ['enchanted.background.chinese-mist-mountains', 'chinese', 'enchanted.middle.chinese-pavilion', 'enchanted.foreground.chinese-peach-blossoms'],
      ['enchanted.background.japanese-moon-garden', 'japanese', 'enchanted.middle.japanese-torii', 'enchanted.foreground.japanese-moon-moss'],
      ['enchanted.background.celestial-observatory', 'observatory', 'enchanted.middle.celestial-arch', 'enchanted.foreground.starflowers'],
      ['enchanted.background.mythic-waterside', 'waterside', 'enchanted.middle.lantern-bridge', 'enchanted.foreground.river-reeds'],
      ['enchanted.background.lotus-sanctuary', 'lotus-sanctuary', 'enchanted.middle.lotus-pavilion', 'enchanted.foreground.lotus-flowers'],
    ] as const;
    for (const [backgroundId, story, expectedId, expectedForegroundId] of stories) {
      const scene = createScene('enchanted');
      const bg = lib.get(backgroundId)!;
      const bgNode = createAssetNode(bg, scene);
      bgNode.locked = true;
      scene.nodes.push(bgNode);
      autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 4242, setBackground: false });
      expect(scene.nodes.some((node) => node.assetId === expectedId), `${story} landmark missing`).toBe(true);
      expect(scene.nodes.some((node) => node.assetId === expectedForegroundId), `${story} foreground accent missing`).toBe(true);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      if (story === 'waterside' || story === 'lotus-sanctuary') {
        expect(bgNode.animation?.type).toBe('water-shimmer');
        expect(bgNode.animation?.enabled).toBe(true);
        expect(scene.nodes.some((node) => lib.get(node.assetId)?.rig?.type === 'fall')).toBe(false);
        const landmark = scene.nodes.find((node) => node.assetId === expectedId)!;
        if (story === 'waterside') expect(landmark.x / scene.canvas.width).toBeCloseTo(0.5, 1);
        else {
          expect(landmark.x / scene.canvas.width < 0.25 || landmark.x / scene.canvas.width > 0.75).toBe(true);
          expect(scene.nodes.filter((node) => node.layer === 'foreground').every((node) =>
            landmark.x < scene.canvas.width / 2 ? node.x > scene.canvas.width / 2 : node.x < scene.canvas.width / 2)).toBe(true);
        }
        expect(scene.nodes.filter((node) => node.layer === 'foreground').every((node) =>
          node.x / scene.canvas.width < 0.25 || node.x / scene.canvas.width > 0.75)).toBe(true);
      }
      for (const targetStyle of ['moonlit', 'autumn', 'enchanted']) {
        switchStyle(scene, lib, targetStyle);
        expect(findStyleClashes(scene, lib), `${story} clashes in ${targetStyle}`).toEqual([]);
        if (story === 'waterside' || story === 'lotus-sanctuary') {
          const id = story === 'waterside' ? 'mythic-waterside' : 'lotus-sanctuary';
          const fresh = createAssetNode(lib.get(`${targetStyle}.background.${id}`)!, scene);
          expect(fresh.animation?.type).toBe('water-shimmer');
          expect(fresh.animation?.enabled).toBe(true);
          expect(bgNode.animation?.enabled).toBe(true);
        }
        for (const originalId of [backgroundId, expectedId, expectedForegroundId]) {
          const counterpartId = originalId.replace('enchanted.', `${targetStyle}.`);
          expect(scene.nodes.some((node) => node.assetId === counterpartId),
            `${story} counterpart ${counterpartId} missing`).toBe(true);
        }
      }
    }
  });

  it('auto-composes a coherent scene in every shipped style', () => {
    const lib = shipped();
    for (const style of lib.styles) {
      const scene = createScene(style.id);
      autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 4242 });
      expect(scene.nodes.length, `${style.id} composed nothing`).toBeGreaterThan(5);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      expect(scene.nodes.filter((n) => n.layer === 'background')).toHaveLength(1);
      // Grounded objects must actually sit on the ground, not float.
      for (const n of scene.nodes) {
        const meta = lib.get(n.assetId);
        if (!meta || meta.layer === 'background') continue;
        expect(Number.isFinite(n.x) && Number.isFinite(n.y), `${meta.id} NaN position`).toBe(true);
      }
    }
  });
});
