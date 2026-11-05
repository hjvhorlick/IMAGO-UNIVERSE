import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { EFFECT_MAP, effectDefaults } from '../src/animation/effects';
import { SPIRITUAL_EFFECTS, SPIRITUAL_SUBCATEGORIES } from '../src/animation/spiritualOverlays';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { VideoRenderer } from '../src/render/videoRenderer';
import { createScene } from '../src/scene/sceneModel';
import { switchStyle } from '../src/scene/styleManager';
import { makeEffectNode } from '../src/ui/inspector';
import { packageProject, readProject } from '../src/project/projectFormat';
import { testLibrary } from './helpers';

function drawEffect(id: string, params: Record<string, number | string | boolean>, u: number) {
  const def = EFFECT_MAP.get(id)!;
  const cv = createCanvas(240, 240), ctx = cv.getContext('2d');
  def.draw(ctx as never, { w: 240, h: 240, u, t: u * def.defaultLoop, params, seed: 42, scale: 1 });
  return ctx.getImageData(0, 0, 240, 240).data;
}
function sceneRenderer(width = 320, height = 180) {
  const scene = createScene('enchanted'); scene.canvas.width = width; scene.canvas.height = height;
  const node = makeEffectNode('spiritual-flower-of-life', scene, 0); scene.nodes = [node];
  const lib = testLibrary(), loops = new LoopManager();
  const images = { peek: () => null, ensure: async () => {}, stats: { count: 0, bytes: 0, pending: 0 } };
  const comp = new Compositor(lib, images as never, loops);
  const render = (time: number, quality: 'preview' | 'export' = 'export') => {
    const cv = createCanvas(width, height), ctx = cv.getContext('2d');
    comp.render(ctx as never, scene, { scale: 1, time, quality, skipLighting: true });
    return ctx.getImageData(0, 0, width, height).data;
  };
  return { scene, node, lib, loops, images, comp, render };
}
const pixelsChanged = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let count = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
};

describe('Spiritual & Mystical Overlays', () => {
  it('provides multiple independently identified designs in every requested category', () => {
    expect(SPIRITUAL_SUBCATEGORIES).toHaveLength(8);
    expect(SPIRITUAL_EFFECTS).toHaveLength(25);
    expect(new Set(SPIRITUAL_EFFECTS.map((e) => e.id)).size).toBe(SPIRITUAL_EFFECTS.length);
    for (const subcategory of SPIRITUAL_SUBCATEGORIES) {
      expect(SPIRITUAL_EFFECTS.filter((e) => e.subcategory === subcategory).length, subcategory).toBeGreaterThanOrEqual(2);
    }
    expect(SPIRITUAL_EFFECTS.filter((e) => e.id.includes('chakra-'))).toHaveLength(7);
  });

  it('draws visibly different designs on transparency and loops without a seam', () => {
    const frames = new Set<string>();
    for (const def of SPIRITUAL_EFFECTS) {
      const params = effectDefaults(def.id);
      const start = drawEffect(def.id, params, 0), end = drawEffect(def.id, params, 1);
      expect(Buffer.from(start).equals(Buffer.from(end)), def.name).toBe(true);
      const frame = drawEffect(def.id, params, 0.31);
      expect(frame[3], `${def.name} background`).toBe(0);
      expect(frame.filter((v, i) => i % 4 === 3 && v > 5).length, def.name).toBeGreaterThan(80);
      frames.add(Buffer.from(frame).toString('base64'));
    }
    expect(frames.size).toBe(SPIRITUAL_EFFECTS.length);
  });

  it('renders all selectable materials distinctly, including translucent glass', () => {
    const id = 'spiritual-mandala-rosette';
    const frames = ['gold', 'metal', 'silver', 'white', 'blue', 'violet', 'glass', 'holographic', 'custom'].map((material) =>
      drawEffect(id, { ...effectDefaults(id), material, color: '#f36371', particles: false, glow: 0 }, 0.25));
    expect(new Set(frames.map((f) => Buffer.from(f).toString('base64'))).size).toBe(frames.length);
    const maxAlpha = (f: Uint8ClampedArray) => Math.max(...f.filter((_, i) => i % 4 === 3));
    expect(maxAlpha(frames[6])).toBeLessThan(maxAlpha(frames[3]));
  });

  it('responds to motion direction, starting phase, particles and trails', () => {
    const id = 'spiritual-lotus';
    const base = effectDefaults(id);
    const a = drawEffect(id, base, 0.17);
    const variations: Record<string, number | string | boolean>[] = [
      { direction: 'counterclockwise' }, { phase: 0.22 }, { particles: false }, { trails: true },
      { float: 0.2, sway: 0.2, depth: 0.3, tiltX: 0.6, tiltY: 0.5 },
    ];
    for (const changes of variations) {
      expect(pixelsChanged(a, drawEffect(id, { ...base, ...changes }, 0.17))).toBeGreaterThan(20);
    }
    expect(pixelsChanged(a, drawEffect(id, base, 0.42))).toBeGreaterThan(20);
  });

  it('renders through the same compositor at both landscape and portrait sizes', () => {
    for (const [w, h] of [[320, 180], [180, 320]]) {
      const { node, render } = sceneRenderer(w, h);
      expect(node.width).toBe(node.height);
      const a = render(0), loop = render(node.effect!.loop), mid = render(node.effect!.loop / 3);
      expect(Buffer.from(a).equals(Buffer.from(loop))).toBe(true);
      expect(pixelsChanged(a, mid)).toBeGreaterThan(20);
      expect(Buffer.from(mid).equals(Buffer.from(render(node.effect!.loop / 3, 'preview')))).toBe(true);
    }
  });

  it('fades timed effects in and out and disables unsafe video tiling', () => {
    const { scene, node, lib, loops, images, comp, render } = sceneRenderer();
    node.effect!.start = 2; node.effect!.end = 8; node.effect!.params.windowFade = 2;
    const before = render(1), atStart = render(2), halfway = render(3), active = render(4), end = render(8);
    expect(Buffer.from(before).equals(Buffer.from(atStart))).toBe(true);
    expect(Buffer.from(before).equals(Buffer.from(end))).toBe(true);
    expect(pixelsChanged(before, halfway)).toBeGreaterThan(20);
    expect(pixelsChanged(before, active)).toBeGreaterThan(20);
    const vr = new VideoRenderer(comp, images as never, lib, loops);
    const plan = vr.plan(scene, { width: 320, height: 180, fps: 30, duration: 60, bitrate: 1e6, format: 'mp4' });
    expect(plan.windowed).toBe(true);
    expect(plan.canTile).toBe(false);
  });

  it('survives style changes and editable project save / reload', async () => {
    const { scene, node, lib } = sceneRenderer();
    node.x = 66; node.y = 75; node.opacity = 0.48; node.rotation = 17;
    node.effect!.params.material = 'holographic'; node.effect!.params.direction = 'counterclockwise';
    node.effect!.params.depth = 0.23; node.effect!.params.windowFade = 1.5;
    node.effect!.loop = 18; node.effect!.start = 3; node.effect!.end = 42;
    const second = makeEffectNode('spiritual-chakra-heart', scene, 1); scene.nodes.push(second);
    switchStyle(scene, lib, 'moonlit');
    expect(scene.nodes).toHaveLength(2);
    const blob = await packageProject(scene, lib);
    const restored = await readProject(await blob.arrayBuffer(), testLibrary());
    const reopened = restored.scene.nodes.find((n) => n.id === node.id)!;
    expect(reopened.effect).toEqual(node.effect);
    expect([reopened.x, reopened.y, reopened.opacity, reopened.rotation]).toEqual([66, 75, 0.48, 17]);
    expect(restored.scene.nodes.find((n) => n.id === second.id)?.effect?.effectId).toBe('spiritual-chakra-heart');
  });
});
