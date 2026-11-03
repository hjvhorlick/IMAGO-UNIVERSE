/**
 * Acceptance tests for the long-video architecture.
 *
 * The encoder itself is a browser API, but the part that makes hour-long
 * exports possible - deciding which encoded frame goes where - is pure logic
 * and is tested exhaustively here.
 */
import { describe, expect, it } from 'vitest';
import { dimensionsFor } from '../src/export/exportManager';
import { MAX_VIDEO_PIXELS, tileSequence } from '../src/render/videoRenderer';
import { LoopManager } from '../src/animation/loopManager';
import { createScene } from '../src/scene/sceneModel';
import { makeEffectNode } from '../src/ui/inspector';
import { VideoRenderer } from '../src/render/videoRenderer';
import { Compositor } from '../src/render/compositor';
import { testLibrary } from './helpers';


describe('loop tiling', () => {
  it('writes exactly the requested number of frames', () => {
    for (const duration of [15, 60, 300, 600, 1800, 3600]) {
      const lm = new LoopManager();
      const plan = { ...lm.plan(duration, 12, 30), canTile: true };
      const seq = Array.from(tileSequence(plan));
      expect(seq.length, `duration ${duration}`).toBe(duration * 30);
      expect(seq[seq.length - 1].out).toBe(duration * 30 - 1);
    }
  });

  it('produces strictly increasing output timestamps with no gaps', () => {
    const lm = new LoopManager();
    const plan = { ...lm.plan(65, 12, 30), canTile: true };
    let last = -1;
    for (const { out } of tileSequence(plan)) {
      expect(out).toBe(last + 1);
      last = out;
    }
  });

  it('starts every repeat on source frame 0 (the key frame)', () => {
    const lm = new LoopManager();
    const plan = { ...lm.plan(60, 12, 30), canTile: true };
    const seq = Array.from(tileSequence(plan));
    for (let r = 0; r < plan.repeats; r++) {
      expect(seq[r * plan.cycleFrames].src).toBe(0);
    }
  });

  it('never references a frame outside the encoded cycle', () => {
    const lm = new LoopManager();
    const plan = { ...lm.plan(3600, 7.5, 24), canTile: true };
    for (const { src } of tileSequence(plan)) {
      expect(src).toBeGreaterThanOrEqual(0);
      expect(src).toBeLessThan(plan.cycleFrames);
    }
  });

  it('handles a partial final cycle correctly', () => {
    const lm = new LoopManager();
    const plan = { ...lm.plan(65, 12, 30), canTile: true };   // 5 cycles + 150 frames
    const seq = Array.from(tileSequence(plan));
    expect(plan.repeats).toBe(5);
    expect(plan.remainder).toBe(150);
    const tail = seq.slice(plan.repeats * plan.cycleFrames);
    expect(tail.length).toBe(150);
    expect(tail[0].src).toBe(0);
    expect(tail[149].src).toBe(149);
  });

  it('handles a video shorter than one cycle', () => {
    const lm = new LoopManager();
    const plan = { ...lm.plan(3, 12, 30), canTile: true };
    const seq = Array.from(tileSequence(plan));
    expect(seq.length).toBe(90);
    expect(seq.every((s, i) => s.src === i)).toBe(true);
  });

  it('falls back to one source frame per output frame when tiling is unsafe', () => {
    const lm = new LoopManager();
    const plan = { ...lm.plan(20, 12, 30), canTile: false };
    const seq = Array.from(tileSequence(plan));
    expect(seq.length).toBe(600);
    expect(seq.every((s) => s.src === s.out)).toBe(true);
  });

});

describe('export planning', () => {
  function renderer() {
    const lib = testLibrary();
    const loops = new LoopManager();
    const images = { peek: () => null, ensure: async () => {}, stats: { count: 0, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, loops);
    return { vr: new VideoRenderer(comp, images as never, lib, loops), loops };
  }

  const opts = (over: Record<string, unknown> = {}) => ({
    width: 1920, height: 1080, fps: 30, duration: 60, bitrate: 8e6, format: 'mp4' as const, ...over,
  });

  it('tiles one cycle when the scene is exactly periodic', () => {
    const { vr } = renderer();
    const scene = createScene('enchanted');
    for (const loop of [6, 8, 12]) {
      const n = makeEffectNode('sparkles', scene, scene.nodes.length);
      n.effect!.loop = loop;
      scene.nodes.push(n);
    }
    const plan = vr.plan(scene, opts({ duration: 1800 }));
    expect(plan.report.master).toBe(24);
    expect(plan.canTile).toBe(true);
    expect(plan.cycleFrames).toBe(720);
    expect(plan.totalFrames).toBe(54_000);
    expect(plan.framesToRender).toBe(720);          // 75x less work
    expect(plan.estimatedBytes).toBeCloseTo(1.8e9, -6);
  });

  it('refuses to tile when an animation has a start/stop window, and says why', () => {
    const { vr } = renderer();
    const scene = createScene('enchanted');
    const n = makeEffectNode('snow', scene, 0);
    n.effect!.start = 5;
    n.effect!.end = 20;
    scene.nodes.push(n);
    const plan = vr.plan(scene, opts({ duration: 300 }));
    expect(plan.windowed).toBe(true);
    expect(plan.canTile).toBe(false);
    expect(plan.framesToRender).toBe(plan.totalFrames);
  });

  it('keeps duration independent of the animation cycle', () => {
    const { vr } = renderer();
    const scene = createScene('enchanted');
    const n = makeEffectNode('sparkles', scene, 0);
    n.effect!.loop = 7;
    scene.nodes.push(n);
    for (const duration of [60, 300, 1800, 3600]) {
      const plan = vr.plan(scene, opts({ duration }));
      expect(plan.totalFrames).toBe(duration * 30);
      expect(plan.report.master).toBe(7);
    }
  });

  it('reports zero animation honestly for a static scene', () => {
    const { vr } = renderer();
    const scene = createScene('enchanted');
    const plan = vr.plan(scene, opts());
    expect(plan.report.animated).toBe(0);
  });
});

describe('output dimensions', () => {
  it('always produces even dimensions (required by H.264)', () => {
    for (const aspect of ['16:9', '9:16', '1:1', '4:3', '21:9']) {
      const scene = createScene('enchanted', 'x', aspect);
      for (const h of [720, 1080, 1440, 2160]) {
        const d = dimensionsFor(scene, h);
        expect(d.width % 2).toBe(0);
        expect(d.height % 2).toBe(0);
        expect(d.width).toBeGreaterThan(0);
      }
    }
  });

  it('keeps 4K inside the documented safe pixel budget', () => {
    const scene = createScene('enchanted', 'x', '16:9');
    const d = dimensionsFor(scene, 2160);
    expect(d.width * d.height).toBeLessThanOrEqual(MAX_VIDEO_PIXELS);
  });
});
