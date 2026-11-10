import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { EFFECT_MAP, effectDefaults, rainRippleCount, waterCrestCount } from '../src/animation/effects';
import { makeEffectNode } from '../src/ui/inspector';
import { createScene, createAssetNode } from '../src/scene/sceneModel';
import { readWaterShape, waterShapeFeather } from '../src/core/waterShape';
import { waterCrestPosition, waterCrestSpan, waterCrestStrokeWidths, waterMeshResolution, waterReflectionDisplacement, waterSurfaceWarp } from '../src/core/waterSurface';
import { packageProject, readProject } from '../src/project/projectFormat';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { testLibrary } from './helpers';

const ID = 'gentle-water-waves';

describe('gentle placeable water waves', () => {
  it('is a small, selectable overlay with gentle editable defaults in every look', () => {
    const def = EFFECT_MAP.get(ID)!;
    expect(def.family).toBe('natural');
    expect(def.bounded).toBe(true);
    for (const style of ['enchanted', 'moonlit', 'autumn', 'realistic']) {
      const scene = createScene(style);
      const node = makeEffectNode(ID, scene, 0);
      expect(node.width).toBeLessThan(scene.canvas.width);
      expect(node.height).toBeLessThan(scene.canvas.height * 0.3);
      expect(node.effect!.params.strength).toBeLessThan(0.5);
      expect(node.effect!.params.direction).toBeUndefined();
      expect(readWaterShape(node.effect!.params.waterShape)).toHaveLength(8);
      const river = makeEffectNode('river-water-flow', scene, 1);
      expect(river.effect!.params.direction).toBe('right');
      expect(EFFECT_MAP.get('river-water-flow')!.waterShape).toBe(true);
    }
  });

  it('makes saved rain ripples much denser and offers separate lake waves', () => {
    const rain = EFFECT_MAP.get(ID)!, waves = EFFECT_MAP.get('lake-water-waves')!;
    expect(rain.name).toBe('Rain Ripples');
    expect(rainRippleCount(9)).toBe(180);
    expect(rainRippleCount(3)).toBe(60);
    expect(rainRippleCount(30)).toBe(600);
    expect(waves.name).toBe('Lake Waves');
    expect(waves.waterDistortion).toBe('lake-waves');
    expect(waves.waterShape).toBe(true);
    expect(waves.params.find((p) => p.key === 'direction')).toBeUndefined();
    const frame = (id: string) => {
      const def = EFFECT_MAP.get(id)!, cv = createCanvas(320, 120), ctx = cv.getContext('2d');
      def.draw(ctx as never, { w: 320, h: 120, u: 0.3, t: 3.6,
        params: effectDefaults(id), seed: 42, scale: 1 });
      return Buffer.from(ctx.getImageData(0, 0, 320, 120).data);
    };
    expect(frame(ID).equals(frame('lake-water-waves'))).toBe(false);
  });

  it('triples saved lake and river crest counts and uses finer water meshes', () => {
    expect(waterCrestCount(56)).toBe(336); // previously 112
    expect(waterCrestCount(52)).toBe(312); // previously 104
    expect(waterCrestCount(4)).toBe(24);
    expect(waterMeshResolution('preview')).toEqual({ cols: 36, rows: 24 });
    expect(waterMeshResolution('export')).toEqual({ cols: 52, rows: 36 });
    // Less vertical bouncing, with small-scale detail retained.
    for (const mode of ['lake-waves', 'river'] as const) for (const direction of ['right', 'down']) {
      for (let i = 0; i < 100; i++) {
        const field = waterSurfaceWarp(0.43, 0.52, i / 100, 2, 1, mode, direction);
        expect(Math.abs(field.y)).toBeLessThan(0.06);
      }
    }
  });

  it('makes lake and river crests twice as long with thinner light edges', () => {
    for (const width of [200, 800]) for (const length of [0.4, 1, 2]) for (const v of [0, 0.5, 1]) {
      const formerSpan = width * (0.018 + 0.042 * v) * length;
      expect(waterCrestSpan(width, length, v)).toBeCloseTo(formerSpan * 2, 10);
    }
    for (const scale of [0.5, 1, 2]) for (const height of [1, 4, 20]) {
      const { edge, glint } = waterCrestStrokeWidths(height, scale);
      expect(edge).toBeLessThan(Math.max(0.65 / scale, height * 0.3));
      expect(glint).toBeLessThan(Math.max(0.45 / scale, height * 0.14));
      expect(glint).toBeLessThan(edge);
    }
  });

  it('keeps reflections subtle with less sideways movement for lakes and rivers', () => {
    for (const mode of ['lake-waves', 'river'] as const) for (const direction of ['left', 'right', 'up', 'down']) {
      let maxX = 0, maxY = 0;
      for (let u = 0; u < 1; u += 0.025) for (let x = 0.1; x < 0.9; x += 0.1) for (let y = 0.1; y < 0.9; y += 0.1) {
        const field = waterSurfaceWarp(x, y, u, 2, 1, mode, direction);
        const displacement = waterReflectionDisplacement(field, 200, 1, 1, 1);
        maxX = Math.max(maxX, Math.abs(displacement.dx));
        maxY = Math.max(maxY, Math.abs(displacement.dy));
        expect(Math.abs(displacement.dx)).toBeLessThan(200 * 0.005);
        expect(Math.abs(displacement.dy)).toBeLessThan(200 * 0.009);
        const still = waterReflectionDisplacement(field, 200, 0, 1, 1);
        expect(Math.abs(still.dx) + Math.abs(still.dy)).toBe(0);
      }
      expect(maxX).toBeGreaterThan(0.1);
      expect(maxY).toBeGreaterThan(maxX);
    }
  });

  it('sways lake crests sideways with only a small bob and loops smoothly', () => {
    const wave = (u: number) => waterCrestPosition(0.5, 0.5, 0.13, u, 1, 'lake-waves', 'right');
    const samples = Array.from({ length: 120 }, (_, i) => wave(i / 120));
    const xs = samples.map((p) => p.x), ys = samples.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.045);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.009);
    expect(Math.min(...xs)).toBeLessThan(0.48);
    expect(Math.max(...xs)).toBeGreaterThan(0.52);
    expect(wave(1).x).toBeCloseTo(wave(0).x, 12);
    expect(wave(1).y).toBeCloseTo(wave(0).y, 12);
    const surface = Array.from({ length: 120 }, (_, i) => waterSurfaceWarp(0.43, 0.48, i / 120, 1, 1, 'lake-waves', 'right'));
    const range = (values: number[]) => Math.max(...values) - Math.min(...values);
    expect(range(surface.map((p) => p.x))).toBeGreaterThan(range(surface.map((p) => p.y)) * 1.5);
    expect(waterSurfaceWarp(0.43, 0.48, 1, 1, 1, 'lake-waves', 'right').x)
      .toBeCloseTo(surface[0].x, 12);
  });

  it('uses the same wave for a river, with added travel in each chosen direction', () => {
    const lake = waterCrestPosition(0.5, 0.5, 0.13, 0, 1, 'lake-waves', 'right');
    const lakeField = waterSurfaceWarp(0.43, 0.48, 0, 1, 1, 'lake-waves', 'right');
    expect(waterSurfaceWarp(0.43, 0.48, 0, 1, 1, 'river', 'right')).toEqual(lakeField);
    for (const direction of ['left', 'right', 'up', 'down']) {
      const a = waterCrestPosition(0.5, 0.5, 0.13, 0, 1, 'river', direction);
      const b = waterCrestPosition(0.5, 0.5, 0.13, 0.1, 1, 'river', direction);
      const loop = waterCrestPosition(0.5, 0.5, 0.13, 1, 1, 'river', direction);
      expect(a.x).toBeCloseTo(lake.x, 12);
      expect(a.y).toBeCloseTo(lake.y, 12);
      const axis = direction === 'up' || direction === 'down' ? 'y' : 'x';
      const sign = direction === 'up' || direction === 'left' ? -1 : 1;
      expect((b[axis] - a[axis]) * sign, direction).toBeGreaterThan(0.07);
      expect(loop.x).toBeCloseTo(a.x, 12);
      expect(loop.y).toBeCloseTo(a.y, 12);
      const boundary = waterCrestPosition(0.5, 0.5, 0.13, 0.5, 1, 'river', direction);
      expect(boundary.life, 'crest fades out at the loop wrap').toBeCloseTo(0, 12);
    }
  });

  it('draws transparent, moving, softly bounded waves and loops exactly', () => {
    const def = EFFECT_MAP.get(ID)!;
    const params = effectDefaults(ID);
    const frame = (u: number, strength = 0.48, direction = 'right') => {
      const cv = createCanvas(320, 120), ctx = cv.getContext('2d');
      def.draw(ctx as never, { w: 320, h: 120, u, t: u * 12,
        params: { ...params, strength, direction }, seed: 42, scale: 1 });
      return ctx.getImageData(0, 0, 320, 120).data;
    };
    const a = frame(0), b = frame(0.37), seam = frame(1), disabled = frame(0.2, 0);
    let visible = 0, different = 0, edge = 0, maxAlpha = 0, disabledAlpha = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      if (a[i + 3] > 0) visible++;
      if (Math.abs(a[i + 3] - b[i + 3]) > 2) different++;
      if (x < 3 || x >= 317 || y < 3 || y >= 117) edge = Math.max(edge, a[i + 3]);
      maxAlpha = Math.max(maxAlpha, a[i + 3]);
      disabledAlpha = Math.max(disabledAlpha, disabled[i + 3]);
      expect(a[i + 3]).toBe(seam[i + 3]);
    }
    expect(visible).toBeGreaterThan(100);
    expect(different).toBeGreaterThan(100);
    expect(edge).toBe(0);
    expect(maxAlpha).toBeLessThan(255);
    expect(disabledAlpha).toBe(0);
    expect(Buffer.from(frame(0.3, 0.48, 'left')).equals(Buffer.from(frame(0.3, 0.48, 'right')))).toBe(true); // lake has no current
  });

  it('moves the underlying image, even without drawn highlights, and leaves the banks still', () => {
    const lib = testLibrary(), scene = createScene('enchanted');
    scene.canvas.width = 400; scene.canvas.height = 240;
    const plate = createCanvas(400, 240), pc = plate.getContext('2d');
    pc.fillStyle = '#1c5b68'; pc.fillRect(0, 0, 400, 240);
    for (let y = 0; y < 240; y += 12) {
      pc.strokeStyle = y % 24 === 0 ? '#85bcca' : '#366f80'; pc.lineWidth = 3;
      pc.beginPath(); pc.moveTo(0, y);
      for (let x = 0; x <= 400; x += 8) pc.lineTo(x, y + Math.sin(x / 19 + y / 31) * 4);
      pc.stroke();
    }
    const m = lib.get('enchanted.background.lake')!;
    const bg = createAssetNode(m, scene);
    bg.x = 200; bg.y = 120; bg.width = 400; bg.height = 240;
    bg.animation!.enabled = false;
    const fx = makeEffectNode(ID, scene, 0);
    fx.x = 200; fx.y = 150; fx.width = 230; fx.height = 86;
    const images = { peek: () => ({ bitmap: plate, width: 400, height: 240 }),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, new LoopManager());
    scene.nodes = [bg, fx];
    const draw = (t: number, solo = false) => {
      const cv = createCanvas(400, 240), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true, onlyNode: solo ? fx.id : undefined });
      return ctx.getImageData(0, 0, 400, 240).data;
    };
    const def = EFFECT_MAP.get(ID)!;
    const highlight = def.draw;
    try {
      // Isolate the water image: a moving line overlay alone cannot pass.
      def.draw = () => {};
      fx.effect!.params.strength = 0;
      const still = draw(0);
      fx.effect!.params.strength = 0.48;
      const a = draw(0), b = draw(2.3), loop = draw(12);
      expect(Buffer.from(draw(0, true)).equals(Buffer.from(a)), 'solo water preview needs the underlying image').toBe(true);
      fx.effect!.params.direction = 'left';
      const leftLake = draw(1.1);
      fx.effect!.params.direction = 'right';
      expect(Buffer.from(draw(1.1)).equals(Buffer.from(leftLake)), 'lake ripples must not become river flow').toBe(true);
      let moved = 0, outside = 0, seamDiff = 0;
      for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
        const i = (y * 400 + x) * 4;
        const change = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (change > 5) {
          if (x >= 85 && x < 315 && y >= 107 && y < 193) moved++;
          else outside++;
        }
        seamDiff = Math.max(seamDiff, Math.abs(a[i] - loop[i]));
      }
      expect(moved, 'the photographic texture itself should move').toBeGreaterThan(500);
      expect(outside, 'the surrounding banks should remain still').toBe(0);
      expect(seamDiff).toBe(0);
      fx.effect!.params.strength = 0;
      expect(Buffer.from(draw(1)).equals(Buffer.from(still))).toBe(true);
      // Turning and flipping the overlay still samples the same underlying
      // image, instead of sampling or drawing a displaced rectangular patch.
      fx.rotation = 25; fx.flipX = true;
      fx.effect!.params.strength = 0.001;
      const almostStill = draw(0.2);
      let total = 0;
      for (let i = 0; i < still.length; i += 4) total += Math.abs(still[i] - almostStill[i]);
      expect(total / (400 * 240), 'rotated sampling should not replace the image with the wrong area').toBeLessThan(1.5);
      fx.effect!.params.strength = 0.48;
      expect(Buffer.from(draw(0)).equals(Buffer.from(draw(2.3)))).toBe(false);
    } finally {
      def.draw = highlight;
    }
  });

  it('moves the lake image with small waves across the entire shaped area', () => {
    const lib = testLibrary(), scene = createScene('enchanted');
    scene.canvas.width = 400; scene.canvas.height = 240;
    const plate = createCanvas(400, 240), pc = plate.getContext('2d');
    pc.fillStyle = '#1a5261'; pc.fillRect(0, 0, 400, 240);
    for (let y = 0; y < 240; y += 8) {
      pc.strokeStyle = y % 16 ? '#5b9cab' : '#aed6da'; pc.lineWidth = 2;
      pc.beginPath(); pc.moveTo(0, y);
      for (let x = 0; x <= 400; x += 5) pc.lineTo(x, y + Math.sin(x / 15 + y / 23) * 3);
      pc.stroke();
    }
    const bg = createAssetNode(lib.get('enchanted.background.lake')!, scene);
    bg.x = 200; bg.y = 120; bg.width = 400; bg.height = 240; bg.animation!.enabled = false;
    const fx = makeEffectNode('lake-water-waves', scene, 0);
    fx.x = 200; fx.y = 130; fx.width = 260; fx.height = 120;
    scene.nodes = [bg, fx];
    const images = { peek: () => ({ bitmap: plate, width: 400, height: 240 }),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, new LoopManager());
    const def = EFFECT_MAP.get('lake-water-waves')!, original = def.draw;
    const draw = (time: number) => {
      const cv = createCanvas(400, 240), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time, skipLighting: true });
      return ctx.getImageData(0, 0, 400, 240).data;
    };
    try {
      def.draw = () => {}; // Verify movement of the water itself, not highlights.
      const a = draw(0.3), b = draw(1.8), seam = draw(12.3);
      const quadrants = [0, 0, 0, 0]; let outside = 0, loopError = 0;
      for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
        const i = (y * 400 + x) * 4;
        const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (delta > 5) {
          if (x >= 70 && x < 330 && y >= 70 && y < 190) quadrants[(x >= 200 ? 1 : 0) + (y >= 130 ? 2 : 0)]++;
          else outside++;
        }
        loopError = Math.max(loopError, Math.abs(a[i] - seam[i]));
      }
      for (const [i, count] of quadrants.entries()) expect(count, `quadrant ${i} must move`).toBeGreaterThan(200);
      expect(outside).toBe(0);
      expect(loopError).toBeLessThanOrEqual(1);
      fx.effect!.params.strength = 0;
      expect(Buffer.from(draw(0)).equals(Buffer.from(draw(2)))).toBe(true);
    } finally { def.draw = original; }
  });

  it('keeps the edited, concave eight-point outline through project save and reload', async () => {
    const lib = testLibrary(), scene = createScene('enchanted');
    const fx = makeEffectNode(ID, scene, 0);
    const points = [
      { x: 0.18, y: 0.14 }, { x: 0.62, y: 0.11 }, { x: 0.86, y: 0.28 },
      { x: 0.60, y: 0.46 }, { x: 0.84, y: 0.77 }, { x: 0.48, y: 0.9 },
      { x: 0.14, y: 0.72 }, { x: 0.26, y: 0.45 },
    ];
    fx.effect!.params.waterShape = JSON.stringify(points);
    scene.nodes = [fx];
    const saved = await packageProject(scene, lib);
    const loaded = await readProject(await saved.arrayBuffer(), testLibrary());
    expect(readWaterShape(loaded.scene.nodes[0].effect!.params.waterShape)).toEqual(points);
    expect(readWaterShape('invalid')).toHaveLength(8);
    expect(waterShapeFeather(50, 50, 100, 100, points)).toBeGreaterThan(0);
    expect(waterShapeFeather(95, 15, 100, 100, points)).toBe(0);
  });

  it('uses a separate directional river effect while lake ripples ignore direction', () => {
    const lake = EFFECT_MAP.get(ID)!, river = EFFECT_MAP.get('river-water-flow')!;
    expect(lake.waterDistortion).toBe('lake');
    expect(river.waterDistortion).toBe('river');
    expect(lake.params.find((p) => p.key === 'direction')).toBeUndefined();
    expect(river.params.find((p) => p.key === 'direction')).toBeDefined();
    const render = (direction: string) => {
      const cv = createCanvas(320, 120), ctx = cv.getContext('2d');
      river.draw(ctx as never, { w: 320, h: 120, u: 0.3, t: 3.6,
        params: { ...effectDefaults('river-water-flow'), direction }, seed: 42, scale: 1 });
      return Buffer.from(ctx.getImageData(0, 0, 320, 120).data);
    };
    expect(render('left').equals(render('right'))).toBe(false);
  });

  it('animates only inside the edited lake polygon, including a concave shoreline', () => {
    const lib = testLibrary(), scene = createScene('enchanted');
    scene.canvas.width = 400; scene.canvas.height = 240;
    const plate = createCanvas(400, 240), pc = plate.getContext('2d');
    pc.fillStyle = '#205969'; pc.fillRect(0, 0, 400, 240);
    for (let y = 0; y < 240; y += 9) {
      pc.strokeStyle = y % 18 ? '#609dae' : '#a7cfdb'; pc.lineWidth = 2;
      pc.beginPath(); pc.moveTo(0, y);
      for (let x = 0; x <= 400; x += 5) pc.lineTo(x, y + Math.sin(x / 15 + y / 20) * 4);
      pc.stroke();
    }
    const bg = createAssetNode(lib.get('enchanted.background.lake')!, scene);
    bg.x = 200; bg.y = 120; bg.width = 400; bg.height = 240; bg.animation!.enabled = false;
    const fx = makeEffectNode(ID, scene, 0);
    fx.x = 200; fx.y = 150; fx.width = 230; fx.height = 86;
    fx.effect!.params.waterShape = JSON.stringify([
      { x: 0.25, y: 0.1 }, { x: 0.65, y: 0.1 }, { x: 0.9, y: 0.3 }, { x: 0.6, y: 0.5 },
      { x: 0.9, y: 0.75 }, { x: 0.65, y: 0.9 }, { x: 0.25, y: 0.9 }, { x: 0.1, y: 0.5 },
    ]);
    scene.nodes = [bg, fx];
    const images = { peek: () => ({ bitmap: plate, width: 400, height: 240 }),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, new LoopManager());
    const draw = (t: number) => {
      const cv = createCanvas(400, 240), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
      return ctx.getImageData(0, 0, 400, 240).data;
    };
    const a = draw(0.3), b = draw(2.3);
    let inside = 0, notch = 0, outside = 0;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      const change = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (change < 5) continue;
      if (x > 165 && x < 230 && y > 120 && y < 180) inside++;
      if (x > 85 + 0.78 * 230 && x < 85 + 0.92 * 230 && y > 107 + 0.47 * 86 && y < 107 + 0.53 * 86) notch++;
      if (x < 85 || x >= 315 || y < 107 || y >= 193) outside++;
    }
    expect(inside, 'water inside the polygon must move').toBeGreaterThan(200);
    expect(notch, 'the concave shoreline must stay still').toBe(0);
    expect(outside).toBe(0);
  });

  it('heaves the river image without moving the banks in all four directions', () => {
    const lib = testLibrary(), scene = createScene('enchanted');
    scene.canvas.width = 400; scene.canvas.height = 240;
    const plate = createCanvas(400, 240), pc = plate.getContext('2d');
    pc.fillStyle = '#174959'; pc.fillRect(0, 0, 400, 240);
    for (let x = 0; x < 400; x += 12) {
      pc.fillStyle = x % 24 ? '#4e9bad' : '#9ac4ce';
      pc.fillRect(x, 0, 4, 240);
    }
    for (let y = 0; y < 240; y += 12) {
      pc.fillStyle = y % 24 ? '#427c8d' : '#8ebac7';
      pc.fillRect(0, y, 400, 3);
    }
    const bg = createAssetNode(lib.get('enchanted.background.lake')!, scene);
    bg.x = 200; bg.y = 120; bg.width = 400; bg.height = 240; bg.animation!.enabled = false;
    const fx = makeEffectNode('river-water-flow', scene, 0);
    fx.x = 200; fx.y = 120; fx.width = 260; fx.height = 120;
    fx.effect!.params.strength = 0.8;
    scene.nodes = [bg, fx];
    const images = { peek: () => ({ bitmap: plate, width: 400, height: 240 }),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, new LoopManager());
    const def = EFFECT_MAP.get('river-water-flow')!, highlight = def.draw;
    const draw = (t: number) => {
      const cv = createCanvas(400, 240), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
      return ctx.getImageData(0, 0, 400, 240).data;
    };
    try {
      def.draw = () => {};
      for (const direction of ['left', 'right', 'up', 'down']) {
        fx.effect!.params.direction = direction;
        const before = draw(0.4), after = draw(1.8);
        let moved = 0, outside = 0;
        for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
          const i = (y * 400 + x) * 4;
          const delta = Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
          if (delta > 8) {
            if (x >= 70 && x < 330 && y >= 60 && y < 180) moved++;
            else outside++;
          }
        }
        expect(moved, `${direction} must heave the image itself`).toBeGreaterThan(1000);
        expect(outside).toBe(0);
        expect(Buffer.from(draw(0)).equals(Buffer.from(draw(12)))).toBe(true);
      }
    } finally { def.draw = highlight; }
  });

  it('sends choppy river waves downstream while the water heaves in place', () => {
    for (const direction of ['left', 'right', 'up', 'down']) {
      const vertical = direction === 'up' || direction === 'down';
      const sign = direction === 'left' || direction === 'up' ? -1 : 1;
      let forwardError = 0, backwardError = 0;
      for (let x = 0.15; x < 0.85; x += 0.05) for (let y = 0.15; y < 0.85; y += 0.05) {
        const a = waterSurfaceWarp(x, y, 0.23, 2, 1, 'river', direction);
        const step = 0.004 * sign;
        const f = waterSurfaceWarp(x + (vertical ? 0 : step), y + (vertical ? step : 0), 0.232, 2, 1, 'river', direction);
        const b = waterSurfaceWarp(x - (vertical ? 0 : step), y - (vertical ? step : 0), 0.232, 2, 1, 'river', direction);
        forwardError += (a.x - f.x) ** 2 + (a.y - f.y) ** 2;
        backwardError += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      }
      expect(forwardError, direction).toBeLessThan(backwardError);
      const samples = Array.from({ length: 120 }, (_, i) => waterSurfaceWarp(0.5, 0.5, i / 120, 2, 1, 'river', direction));
      for (const axis of ['x', 'y'] as const) {
        const values = samples.map((p) => p[axis]);
        expect(Math.max(...values)).toBeGreaterThan(0.01);
        expect(Math.min(...values)).toBeLessThan(-0.01);
        expect(Math.abs(values.reduce((a, b) => a + b, 0) / values.length)).toBeLessThan(1e-10);
      }
    }
  });

  it('shows animated crests and troughs across flat lake and river water', () => {
    for (const id of ['lake-water-waves', 'river-water-flow']) {
      const def = EFFECT_MAP.get(id)!;
      const draw = (u: number) => {
        const cv = createCanvas(400, 160), ctx = cv.getContext('2d');
        ctx.fillStyle = '#236172'; ctx.fillRect(0, 0, 400, 160);
        def.draw(ctx as never, { w: 400, h: 160, u, t: u * 12, params: effectDefaults(id), seed: 42, scale: 1 });
        return ctx.getImageData(0, 0, 400, 160).data;
      };
      const a = draw(0.1), b = draw(0.3), seam = draw(1.1);
      let light = 0, dark = 0, changed = 0; const quadrants = [0, 0, 0, 0];
      for (let y = 0; y < 160; y++) for (let x = 0; x < 400; x++) {
        const i = (y * 400 + x) * 4;
        if (a[i] > 42) light++;
        if (a[i] < 35) dark++;
        if (Math.abs(a[i] - b[i]) > 5) { changed++; quadrants[(x >= 200 ? 1 : 0) + (y >= 80 ? 2 : 0)]++; }
        expect(Math.abs(a[i] - seam[i])).toBeLessThanOrEqual(1);
      }
      expect(light, `${id} crests`).toBeGreaterThan(300);
      expect(dark, `${id} subtle troughs`).toBeGreaterThan(100);
      expect(changed).toBeGreaterThan(1000);
      for (const q of quadrants) expect(q).toBeGreaterThan(100);
    }
  });

  it('composites on top of a scene without changing pixels outside its area', () => {
    const lib = testLibrary(), scene = createScene('enchanted');
    scene.canvas.width = 400; scene.canvas.height = 240;
    const fx = makeEffectNode(ID, scene, 0);
    fx.x = 200; fx.y = 160; fx.width = 220; fx.height = 60;
    scene.nodes = [fx];
    const images = { peek: () => null, ensure: async () => {}, stats: { count: 0, bytes: 0, pending: 0 } };
    const comp = new Compositor(lib, images as never, new LoopManager());
    const draw = (time: number) => {
      const cv = createCanvas(400, 240), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time, skipLighting: true });
      return ctx.getImageData(0, 0, 400, 240).data;
    };
    const a = draw(0), b = draw(2.3), loop = draw(12);
    let inside = 0, outside = 0, loopDiff = 0;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta > 3) {
        if (x >= 90 && x < 310 && y >= 130 && y < 190) inside++;
        else outside++;
      }
      loopDiff = Math.max(loopDiff, Math.abs(a[i] - loop[i]));
    }
    expect(inside).toBeGreaterThan(100);
    expect(outside).toBe(0);
    expect(loopDiff).toBe(0);
  });
});
