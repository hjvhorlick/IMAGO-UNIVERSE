import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { inWorldCollection } from '../src/assets/worldCollections';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { drawFlyingFlock, flockBirdStates, flockFlapEnvelope, flockFormation, flockWingPose } from '../src/render/flock';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { switchStyle, findStyleClashes } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
/** layer, expected motion, worlds the creature should be offered in. */
const CREATURES: Array<[string, string, string, string[]]> = [
  ['middle.white-stag', 'creature-breathe', 'White Stag', ['fairy', 'nature']],
  ['foreground.red-fox', 'creature-breathe', 'Red Fox', ['nature']],
  ['middle.mute-swans', 'swim', 'Mute Swans', ['japanese', 'norse', 'waterside', 'lotus-sanctuary']],
  ['foreground.koi-fish', 'swim', 'Koi Fish', ['japanese', 'chinese']],
  ['foreground.butterflies', 'flutter', 'Butterflies', ['japanese', 'lotus-sanctuary']],
  ['middle.great-owl', 'creature-breathe', 'Great Owl', ['fairy']],
  ['foreground.rabbit', 'creature-breathe', 'Brown Rabbit', ['nature']],
  ['foreground.red-squirrel', 'creature-breathe', 'Red Squirrel', ['nature']],
  ['middle.mallard-ducks', 'swim', 'Mallard Ducks', ['japanese', 'waterside']],
  ['foreground.hedgehog', 'creature-breathe', 'Hedgehog', ['nature', 'chinese']],
  ['middle.deer-fawn', 'creature-breathe', 'Deer Fawn', ['nature']],
  ['foreground.moor-frog', 'creature-breathe', 'Moor Frog', ['japanese', 'lotus-sanctuary']],
  ['middle.songbird-flock', 'flutter', 'Songbird Flock', ['nature', 'japanese']],
];
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('placeable creatures', () => {
  it('ships every animal in all three looks, with the flying flock animated by default', () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const scene = createScene(style);
      for (const [key, motion, name, worlds] of CREATURES) {
        const meta = lib.get(`${style}.${key}`)!;
        expect(meta, `${style}.${key}`).toBeDefined();
        expect(meta.category).toBe('creatures');
        expect(meta.alpha).toBe(true);
        expect(meta.name).toContain(name);
        expect(meta.animations).toEqual([motion]);
        for (const world of worlds) {
          expect(inWorldCollection(meta, world), `${key} in ${world}`).toBe(true);
        }
        const node = createAssetNode(meta, scene);
        expect(node.animation?.type).toBe(motion);
        expect(node.animation?.enabled, `${key} placement motion`).toBe(key === 'middle.songbird-flock');
        if (key === 'middle.songbird-flock') {
          expect(meta.rig?.type).toBe('flying-flock');
          expect(meta.placement.grounded).toBe(false);
          expect(node.y / scene.canvas.height).toBeCloseTo(0.19);
          const moved = createAssetNode(meta, scene, { x: 123, y: 234 });
          expect([moved.x, moved.y]).toEqual([123, 234]);
        }
        scene.nodes.push(node);
      }
      // Each animal is its own object, not a group.
      expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(CREATURES.length);
    }
  });

  it('keeps animals transparent around their whole boundary in every palette', async () => {
    const lib = library();
    for (const [key] of CREATURES) {
      for (const style of ['enchanted', 'moonlit', 'autumn']) {
        const meta = lib.get(`${style}.${key}`)!;
        const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
        const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, img.width, img.height);
        let edge = 0;
        for (let x = 0; x < img.width; x++) {
          edge = Math.max(edge, data[x * 4 + 3], data[((img.height - 1) * img.width + x) * 4 + 3]);
        }
        for (let y = 0; y < img.height; y++) {
          edge = Math.max(edge, data[y * img.width * 4 + 3], data[(y * img.width + img.width - 1) * 4 + 3]);
        }
        expect(edge, `${style}.${key} touches its plate edge`).toBe(0);
      }
    }
  });

  it('keeps the bird flock crisp instead of veiled in keyed sky haze', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.middle.songbird-flock`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const al = ctx.getImageData(0, 0, img.width, img.height).data;
      let opaque = 0, haze = 0;
      for (let i = 3; i < al.length; i += 4) {
        if (al[i] > 250) opaque++;
        else if (al[i] > 5) haze++;
      }
      const total = al.length / 4;
      expect(opaque / total, `${style} flock too faint`).toBeGreaterThan(0.05);
      // A bird painted against open sky keys to a wide band of near-zero alpha;
      // that band must be ramped away or the plate arrives as a grey veil.
      expect(haze / total, `${style} flock haze`).toBeLessThan(0.05);
    }
  });

  it('forms eighteen level birds in a clustered, uneven group', async () => {
    const points = flockFormation();
    expect(points).toHaveLength(18); // original plate has nine birds
    expect(points.every(([x, y]) => x > 0 && x < 1 && y > 0 && y < 1)).toBe(true);
    // Neighbours keep a minimum gap but distances vary widely: sub-clusters,
    // pairs and stragglers, never an even grid.
    const nn = points.map(([x, y], i) => Math.min(...points
      .filter((_, j) => j !== i).map(([px, py]) => Math.hypot(x - px, y - py))));
    expect(Math.min(...nn)).toBeGreaterThanOrEqual(0.069);
    expect(Math.max(...nn) / Math.min(...nn)).toBeGreaterThan(1.6);
    const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
    const sd = Math.sqrt(nn.reduce((a, b) => a + (b - mean) ** 2, 0) / nn.length);
    expect(sd / mean).toBeGreaterThan(0.25);
    expect(flockFormation(77)).toEqual(flockFormation(77));
    expect(flockFormation(77)).not.toEqual(flockFormation(78));
    // Cruise flight: wings rest in a low glide, not the painted raised V.
    const resting = [0, 0.11, 0.23, 0.37, 0.51, 0.68, 0.84]
      .flatMap((phase) => [0, 1, 2, 3, 4, 5].map((i) => ({ i, phase, env: flockFlapEnvelope(phase, 0.9, i, 77) })))
      .filter((s) => s.env === 0);
    expect(resting.length).toBeGreaterThan(10); // most of the time, gliding
    for (const { i, phase } of resting.slice(0, 12)) {
      const pose = flockWingPose(phase, 10, 0.9, i, 77);
      expect(pose.fold).toBeLessThan(-1.2);      // wings level with the side
      expect(pose.fold).toBeGreaterThan(-1.7);   // of the body, never raised
      expect(pose.stretch).toBeGreaterThan(0.7); // extended, not vanished
      expect(pose.stretch).toBeLessThan(0.86);
    }
    // Flap bursts are intermittent and never synchronised across the group.
    let mixed = false;
    for (let phase = 0; phase < 1 && !mixed; phase += 0.01) {
      const envs = Array.from({ length: 18 }, (_, i) => flockFlapEnvelope(phase, 0.9, i, 77));
      mixed = envs.some((e) => e === 0) && envs.some((e) => e > 0.5);
    }
    expect(mixed, 'some birds flap while others glide').toBe(true);
    // A healthy share of the flock is mid-burst at any moment, not all gliding.
    for (const phase of [0, 0.13, 0.31, 0.58, 0.77]) {
      const beating = Array.from({ length: 18 }, (_, i) => flockFlapEnvelope(phase, 0.9, i, 77))
        .filter((e) => e > 0.05).length;
      expect(beating, `flock at phase ${phase} must include flappers`).toBeGreaterThanOrEqual(5);
      expect(beating).toBeLessThanOrEqual(14);
    }
    const p1 = flockWingPose(0.37, 10, 0.9, 4, 77), p2 = flockWingPose(1.37, 10, 0.9, 4, 77);
    expect(p2.fold).toBeCloseTo(p1.fold, 12);   // wing cycle closes with the loop
    expect(p2.stretch).toBeCloseTo(p1.stretch, 12);
    expect(flockWingPose(0.2, 10, 0, 4, 77)).toEqual(flockWingPose(0.7, 10, 0, 4, 77));
    // Bodies stay level - the painted climb is rotated out whatever the stroke.
    const attitudes = [0, 0.25, 0.5, 0.75]
      .flatMap((phase) => flockBirdStates(1000, 545, phase, 10, 0.9, 77).map((s) => s.attitude));
    expect(Math.min(...attitudes)).toBeGreaterThan(0.35);
    expect(Math.max(...attitudes)).toBeLessThan(0.8);
  });

  it('flies the group off the frame and back, at its own speeds', async () => {
    const xsOf = (phase: number) => flockBirdStates(1000, 545, phase, 10, 0.9, 77).map((s) => s.x);
    const centroid = (phase: number) => {
      const xs = xsOf(phase);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    // Starts on screen...
    expect(Math.min(...xsOf(0))).toBeGreaterThan(0);
    expect(Math.max(...xsOf(0))).toBeLessThan(1000);
    // ...leaves the frame entirely on the long leg...
    const phases = Array.from({ length: 48 }, (_, k) => k / 48);
    expect(phases.some((p) => Math.min(...xsOf(p)) > 1000), 'flock exits the frame').toBe(true);
    expect(phases.some((p) => Math.min(...xsOf(p)) < 0 && Math.max(...xsOf(p)) < 300),
      'and pushes past the other edge before returning').toBe(true);
    // ...and keeps coming back through the middle in both directions.
    expect(phases.filter((p) => Math.abs(centroid(p) - 500) < 250).length).toBeGreaterThan(6);
    expect(flockBirdStates(1000, 545, 0.1, 10, 0.9, 77).every((s) => s.heading === 1)).toBe(true);
    expect(flockBirdStates(1000, 545, 0.4, 10, 0.9, 77).every((s) => s.heading === -1)).toBe(true);
    // Individual speeds: over the loop, some bird overtakes another.
    let overtook = false;
    for (let i = 0; i < 6 && !overtook; i++)
      for (let j = i + 1; j < 6 && !overtook; j++) {
        const signs = new Set(phases.map((p) => Math.sign(xsOf(p)[i] - xsOf(p)[j])));
        overtook = signs.has(1) && signs.has(-1);
      }
    expect(overtook, 'birds overtake each other').toBe(true);
    const img = await loadImage(path.join(ROOT, 'public/library/enchanted/middle/songbird-flock.webp'));
    const frame = (phase: number, amplitude = 0.9, travel = true) => {
      const cv = createCanvas(1000, 545), ctx = cv.getContext('2d');
      drawFlyingFlock(ctx as never, img as never, img.width, img.height, 1000, 545,
        phase, 10, amplitude, 77, 0.45, travel);
      return ctx.getImageData(0, 0, 1000, 545).data;
    };
    const ink = (d: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    };
    expect(ink(frame(0))).toBeGreaterThan(2000);
    expect(phases.some((p) => ink(frame(p)) === 0), 'empty sky while the flock is away').toBe(true);
    expect(Buffer.from(frame(0)).equals(Buffer.from(frame(1))), 'the whole pass loops exactly').toBe(true);
    // With travel off the bodies hold station while the wings beat in place.
    const w0 = frame(0, 0.9, false), w1 = frame(0.02, 0.9, false);
    expect(Buffer.from(w0).equals(Buffer.from(w1)), 'wings beat in place').toBe(false);
    const hold = (phase: number) => flockBirdStates(1000, 545, phase, 10, 0.9, 77, 0.45, false)
      .map((s) => [s.x, s.y]);
    expect(hold(0.02)).toEqual(hold(0));          // no in-place flutter drift
    expect(hold(0.61)).toEqual(hold(0));
    const pose = (phase: number) => flockBirdStates(1000, 545, phase, 10, 0.9, 77, 0.45, false)
      .map((s) => [s.wingScale, s.fold]);
    expect(pose(0.02)).not.toEqual(pose(0));      // but the wings do move
    expect(Buffer.from(w0).equals(Buffer.from(frame(1, 0.9, false))), 'wing beats loop exactly').toBe(true);
    expect(Buffer.from(frame(0, 0)).equals(Buffer.from(frame(0.5, 0))), 'zero strength holds the flock still').toBe(true);
  });

  it('renders the high flock with a looping animation and supports disabling it', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.middle.songbird-flock`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
        ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
      const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
      const scene = createScene(style); scene.canvas.width = 800; scene.canvas.height = 450;
      const node = createAssetNode(meta, scene); node.animation!.seed = 77; node.animation!.amplitude = 0.85;
      scene.nodes = [node];
      const render = (time: number) => {
        const cv = createCanvas(800, 450), ctx = cv.getContext('2d');
        comp.render(ctx as never, scene, { scale: 1, quality: 'export', time, skipLighting: true });
        return Buffer.from(ctx.getImageData(0, 0, 800, 450).data);
      };
      const a = render(0), b = render(0.15);
      expect(a.equals(b), `${style} wings and flight must animate`).toBe(false);
      expect(a.equals(render(node.animation!.loop)), `${style} exact loop`).toBe(true);
      node.animation!.enabled = false; loops.invalidate();
      expect(render(0).equals(render(2.7)), `${style} animation can be disabled`).toBe(true);
    }
  });

  it('keeps flock transforms, crop, adjustments and other techniques usable', async () => {
    const lib = library(), meta = lib.get('enchanted.middle.songbird-flock')!;
    const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
    const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
      ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
    const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
    const scene = createScene('enchanted'); scene.canvas.width = 500; scene.canvas.height = 300;
    const node = createAssetNode(meta, scene, { x: 250, y: 150 });
    node.width = 320; node.height = 170; node.animation!.enabled = false;
    scene.nodes = [node];
    const frame = (time = 0) => {
      const cv = createCanvas(500, 300), ctx = cv.getContext('2d');
      comp.render(ctx as never, scene, { scale: 1, quality: 'export', time, skipLighting: true });
      return Buffer.from(ctx.getImageData(0, 0, 500, 300).data);
    };
    const original = frame();
    node.flipX = true;
    expect(frame().equals(original)).toBe(false);
    node.flipX = false; node.rotation = 15;
    expect(frame().equals(original)).toBe(false);
    node.rotation = 0; node.crop = { x: 0.15, y: 0.1, w: 0.7, h: 0.8 };
    const cropped = frame();
    expect(cropped.equals(original)).toBe(false);
    node.adjust.warmth = 0.7;
    expect(frame().equals(cropped)).toBe(false);
    node.animation!.enabled = true; node.animation!.type = 'swim'; node.animation!.amplitude = 1;
    loops.invalidate();
    expect(frame(0).equals(frame(1.2))).toBe(false);
    expect(frame(0).equals(frame(node.animation!.loop))).toBe(true);
  });

  it('animates each motion style and returns exactly to the first frame', async () => {
    const lib = library();
    for (const [key, motion] of CREATURES.filter((c) =>
      ['middle.white-stag', 'middle.mute-swans', 'foreground.butterflies'].includes(c[0]))) {
      expect(['creature-breathe', 'swim', 'flutter']).toContain(motion);
      const meta = lib.get(`enchanted.${key}`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const images = { peek: () => ({ bitmap: img, width: img.width, height: img.height }),
        ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
      const loops = new LoopManager(), comp = new Compositor(lib, images as never, loops);
      const scene = createScene('enchanted'); scene.canvas.width = 400; scene.canvas.height = 300;
      const node = createAssetNode(meta, scene); node.x = 200; node.y = 150;
      node.height = 220; node.width = node.height * meta.width / meta.height;
      node.animation!.seed = 77; node.animation!.amplitude = 1; node.animation!.turbulence = 0.5;
      scene.nodes = [node];
      const render = (t: number) => {
        const cv = createCanvas(400, 300), ctx = cv.getContext('2d');
        comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: t, skipLighting: true });
        return Buffer.from(ctx.getImageData(0, 0, 400, 300).data);
      };
      expect(render(0).equals(render(2.7)), `${key} still`).toBe(true);
      node.animation!.enabled = true;
      loops.invalidate();
      expect(render(0).equals(render(node.animation!.loop)), `${motion} exact loop`).toBe(true);
      expect(render(0).equals(render(node.animation!.loop * 0.31)), `${motion} moves`).toBe(false);
    }
  });

  it('carries animals and their motion across a look change', () => {
    const lib = library();
    const scene = createScene('enchanted');
    for (const [key] of CREATURES) {
      const node = createAssetNode(lib.get(`enchanted.${key}`)!, scene);
      node.animation!.enabled = true;
      scene.nodes.push(node);
    }
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const [key, motion] of CREATURES) {
        const node = scene.nodes.find((n) => n.assetId === `${style}.${key}`);
        expect(node, `${style}.${key}`).toBeDefined();
        expect(node!.animation?.type).toBe(motion);
        expect(node!.animation?.enabled).toBe(true);
      }
    }
  });
});
