import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { EFFECTS, effectDefaults } from '../src/animation/effects';
import { makeEffectNode } from '../src/ui/inspector';
import { createScene } from '../src/scene/sceneModel';

const PIXIE = ['pixie-swirls', 'glitter-streamers', 'fairy-rings', 'dust-twirls', 'wandering-motes'];

function draw(id: string, u: number, seed = 777) {
  const def = EFFECTS.find((e) => e.id === id)!;
  const cv = createCanvas(320, 200);
  const ctx = cv.getContext('2d');
  ctx.globalCompositeOperation = def.blend;
  def.draw(ctx as never, {
    w: 320, h: 200, u, t: u * def.defaultLoop,
    params: effectDefaults(id), seed, scale: 1,
  });
  return Buffer.from(ctx.getImageData(0, 0, 320, 200).data);
}

describe('the pixie-dust atmosphere overlays', () => {
  it('ships five glitter overlays on layer 4', () => {
    for (const id of PIXIE) {
      const def = EFFECTS.find((e) => e.id === id);
      expect(def, id).toBeDefined();
      expect(def!.family).toBe('magical');
      expect(def!.blend).toBe('lighter');
      const scene = createScene('realistic');
      const node = makeEffectNode(id, scene, 0);
      expect(node.layer).toBe('atmosphere');
    }
  });

  it('paints visible glitter that moves through the cycle', () => {
    for (const id of PIXIE) {
      const a = draw(id, 0.13);
      let lit = 0;
      for (let i = 3; i < a.length; i += 4) if (a[i] > 12) lit++;
      expect(lit, `${id} paints glitter`).toBeGreaterThan(150);
      expect(a.equals(draw(id, 0.61)), `${id} moves`).toBe(false);
    }
  });

  it('loops exactly', () => {
    for (const id of PIXIE) {
      expect(draw(id, 0).equals(draw(id, 1)), `${id} loop boundary`).toBe(true);
      expect(draw(id, 0.25).equals(draw(id, 1.25)), `${id} wrapped time`).toBe(true);
    }
  });

  it('travels around the frame over the loop, not stuck in one corner', () => {
    for (const id of PIXIE) {
      const quad = [0, 0, 0, 0];
      for (const u of [0.1, 0.4, 0.7]) {
        const a = draw(id, u);
        for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
          if (a[(y * 320 + x) * 4 + 3] <= 12) continue;
          quad[(y < 100 ? 0 : 2) + (x < 160 ? 0 : 1)]++;
        }
      }
      const occupied = quad.filter((q) => q > 40).length;
      expect(occupied, `${id} visits most of the frame`).toBeGreaterThanOrEqual(3);
    }
  });
});
