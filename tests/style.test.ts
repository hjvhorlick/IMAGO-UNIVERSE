/** Acceptance tests for style consistency across layers 1-3 and universality of layer 4. */
import { describe, expect, it } from 'vitest';
import { findStyleClashes, referenceCollection, styleStats, switchStyle } from '../src/scene/styleManager';
import { createScene } from '../src/scene/sceneModel';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { makeEffectNode } from '../src/ui/inspector';
import { EFFECTS, THEME_PRESETS, effectDefaults } from '../src/animation/effects';
import { testLibrary } from './helpers';

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
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(6);
    for (const t of THEME_PRESETS) {
      expect(t.effects.length).toBeGreaterThan(1);
      for (const e of t.effects) expect(EFFECTS.some((x) => x.id === e.id)).toBe(true);
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
