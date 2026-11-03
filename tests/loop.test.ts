/**
 * Acceptance tests for the seamless-loop system.
 * These are the mathematical guarantees the whole product rests on.
 */
import { describe, expect, it } from 'vitest';
import { LoopManager, LOOP_GRID } from '../src/animation/loopManager';
import { periodic, periodic2, frac } from '../src/core/util';
import { createScene } from '../src/scene/sceneModel';
import { makeEffectNode } from '../src/ui/inspector';
import type { Scene, SceneNode } from '../src/core/types';
import { makeAnimation } from '../src/core/types';

function sceneWith(loops: number[]): Scene {
  const scene = createScene('enchanted', 'test');
  loops.forEach((loop, i) => {
    const n = makeEffectNode('sparkles', scene, i);
    n.effect!.loop = loop;
    scene.nodes.push(n);
  });
  return scene;
}

describe('periodic noise', () => {
  it('returns to its exact starting value after one cycle', () => {
    for (let seed = 1; seed < 40; seed++) {
      expect(periodic(0, seed)).toBeCloseTo(periodic(1, seed), 12);
      expect(periodic(0.37, seed)).toBeCloseTo(periodic(1.37, seed), 12);
      expect(periodic2(0, 0.4, 0.8, seed)).toBeCloseTo(periodic2(1, 0.4, 0.8, seed), 12);
    }
  });

  it('stays inside -1..1 so amplitudes are predictable', () => {
    for (let i = 0; i < 500; i++) {
      const v = periodic(i / 500, 12345);
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });

  it('wraps particle lifetimes into 0..1', () => {
    expect(frac(0)).toBe(0);
    expect(frac(1)).toBe(0);
    expect(frac(2.25)).toBeCloseTo(0.25, 10);
    expect(frac(-0.25)).toBeCloseTo(0.75, 10);
  });
});

describe('LoopManager', () => {
  it('finds a master cycle every animation divides into', () => {
    const lm = new LoopManager();
    const scene = sceneWith([6, 8, 12]);
    const r = lm.analyse(scene);
    expect(r.master).toBe(24);
    expect(r.exact).toBe(true);
    for (const c of r.cycles) {
      const ratio = r.master / c.adjusted;
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9);
    }
  });

  it('keeps independent cycle lengths rather than forcing one speed', () => {
    const lm = new LoopManager();
    const r = lm.analyse(sceneWith([4, 6, 10]));
    expect(r.master).toBe(60);
    expect(r.cycles.map((c) => c.adjusted)).toEqual([4, 6, 10]);
    expect(r.snapped).toBe(0);
  });

  it('harmonises onto the grid when the exact LCM would be unusable, and stays exact', () => {
    const lm = new LoopManager();
    const r = lm.analyse(sceneWith([7, 11, 13]));
    expect(r.master).toBeLessThanOrEqual(60);
    expect(r.snapped).toBeGreaterThan(0);
    // Even after snapping, the boundary must still be exact.
    expect(r.exact).toBe(true);
    for (const c of r.cycles) {
      const ratio = r.master / c.adjusted;
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9);
      expect(c.adjusted % LOOP_GRID).toBeCloseTo(0, 9);
    }
  });

  it('reports no animation when nothing is enabled', () => {
    const lm = new LoopManager();
    const scene = createScene('enchanted');
    const r = lm.analyse(scene);
    expect(r.animated).toBe(0);
    expect(r.cycles).toHaveLength(0);
  });

  it('ignores disabled object animations', () => {
    const lm = new LoopManager();
    const scene = createScene('enchanted');
    const node: SceneNode = {
      ...makeEffectNode('sparkles', scene, 0),
      kind: 'asset', assetId: 'x', effect: undefined,
      animation: makeAnimation('grass-wind'),
    };
    node.animation!.enabled = false;
    scene.nodes.push(node);
    expect(lm.analyse(scene).animated).toBe(0);
    node.animation!.enabled = true;
    lm.invalidate();
    expect(lm.analyse(scene).animated).toBe(1);
  });

  it('phase at t=0 equals phase at t=master for every node', () => {
    const lm = new LoopManager();
    const scene = sceneWith([6, 8, 12, 5]);
    const r = lm.analyse(scene);
    for (const n of scene.nodes) {
      expect(lm.phaseAt(scene, n, 0)).toBeCloseTo(lm.phaseAt(scene, n, r.master), 10);
      expect(lm.phaseAt(scene, n, 1.7)).toBeCloseTo(lm.phaseAt(scene, n, r.master + 1.7), 10);
    }
  });

  it('plans arbitrary durations independently of the cycle', () => {
    const lm = new LoopManager();
    for (const duration of [15, 60, 300, 600, 1800, 3600]) {
      const plan = lm.plan(duration, 12, 30);
      expect(plan.cycleFrames).toBe(360);
      expect(plan.totalFrames).toBe(duration * 30);
      expect(plan.repeats * plan.cycleFrames + plan.remainder).toBe(plan.totalFrames);
      expect(plan.remainder).toBeLessThan(plan.cycleFrames);
    }
  });

  it('handles a duration shorter than one cycle', () => {
    const lm = new LoopManager();
    const plan = lm.plan(3, 12, 24);
    expect(plan.repeats).toBe(0);
    expect(plan.remainder).toBe(72);
    expect(plan.totalFrames).toBe(72);
  });

  it('handles a duration that is not a whole multiple of the cycle', () => {
    const lm = new LoopManager();
    const plan = lm.plan(65, 12, 30);
    expect(plan.repeats).toBe(5);
    expect(plan.remainder).toBe(150);
    expect(plan.repeats * plan.cycleFrames + plan.remainder).toBe(1950);
  });
});
