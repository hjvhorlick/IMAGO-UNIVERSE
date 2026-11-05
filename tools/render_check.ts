/**
 * Headless render verification.
 *
 * Runs the *real* compositor, animation engine, Loop Manager and effect library
 * against a native canvas so the rendering pipeline can be checked without a
 * browser. Writes PNGs to `.render-check/` and asserts that the master cycle
 * boundary is pixel-identical.
 *
 *   npx tsx tools/render_check.ts
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { Compositor } from '../src/render/compositor';
import { LoopManager } from '../src/animation/loopManager';
import { buildDemoScene } from '../src/scene/demoScene';
import { EFFECTS } from '../src/animation/effects';
import { makeEffectNode } from '../src/ui/inspector';
import { createAssetNode, createScene, fitBackground } from '../src/scene/sceneModel';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import type { AssetMeta } from '../src/core/types';

/* -------------------------------------------------- browser API shims */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
g.OffscreenCanvas = function (w: number, h: number) { return createCanvas(w, h); };
g.document = { createElement: (tag: string) => (tag === 'canvas' ? createCanvas(1, 1) : {}) };
g.performance = g.performance ?? { now: () => Date.now() };

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.render-check');
fs.mkdirSync(OUT, { recursive: true });

/** File-backed image cache with the same interface the compositor uses. */
class NodeImageCache {
  private map = new Map<string, { bitmap: unknown; width: number; height: number }>();
  constructor(private lib: AssetLibrary) {}
  async load(id: string) {
    if (this.map.has(id)) return this.map.get(id)!;
    const meta = this.lib.get(id);
    if (!meta) return null;
    const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
    const entry = { bitmap: img, width: img.width, height: img.height };
    this.map.set(id, entry);
    return entry;
  }
  peek(id: string | undefined) { return id ? this.map.get(id) ?? null : null; }
  async ensure(ids: (string | undefined)[]) {
    for (const id of ids) if (id) await this.load(id);
  }
  get stats() { return { count: this.map.size, bytes: 0, pending: 0 }; }
}

async function main() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  const images = new NodeImageCache(lib);
  const loops = new LoopManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comp = new Compositor(lib, images as any, loops);

  const scene = buildDemoScene(lib, { withEffects: true });
  await images.ensure(scene.nodes.map((n) => n.assetId));
  const report = loops.analyse(scene);
  console.log(`scene: ${scene.nodes.length} nodes, ${report.animated} animated, master cycle ${report.master}s, exact=${report.exact}`);
  console.log('cycles:', report.cycles.map((c) => `${c.name}=${c.adjusted}`).join(', '));

  const scale = 1280 / scene.canvas.width;
  const W = Math.round(scene.canvas.width * scale), H = Math.round(scene.canvas.height * scale);

  const renderAt = (t: number) => {
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    const t0 = performance.now();
    comp.render(ctx as never, scene, { scale, quality: 'export', time: t, masterCycle: report.master });
    return { cv, ms: performance.now() - t0 };
  };

  for (const [name, t] of [['t0', 0], ['t-half', report.master / 2], ['t-loop', report.master]] as const) {
    const { cv, ms } = renderAt(t);
    fs.writeFileSync(path.join(OUT, `demo-${name}.png`), cv.toBuffer('image/png'));
    console.log(`rendered demo-${name}.png at t=${t.toFixed(2)}s in ${ms.toFixed(0)}ms`);
  }

  // A transparent foreground room frame should reveal the user's world through
  // its window while replacing the surrounding canvas with an interior view.
  const roomMeta = lib.get(`${scene.styleId}.foreground.lounge-window`);
  if (roomMeta) {
    await images.ensure([roomMeta.id]);
    scene.nodes.push(createAssetNode(roomMeta, scene));
    const { cv } = renderAt(0);
    fs.writeFileSync(path.join(OUT, 'lounge-window-view.png'), cv.toBuffer('image/png'));
    scene.nodes.pop();
    console.log('rendered lounge-window-view.png with the composed world visible through the window');
  }

  // Review both new rooms with the composed world visible and a separately
  // positioned steaming cup on their tables.
  for (const [id, cupX, cupY] of [
    ['hearth-reading-room', 0.59, 0.88],
    ['window-seat-room', 0.64, 0.80],
  ] as const) {
    const room = lib.get(`enchanted.foreground.${id}`);
    const coffee = lib.get('enchanted.foreground.coffee-cup');
    if (!room || !coffee) continue;
    const interior = buildDemoScene(lib, { withEffects: false });
    const roomNode = createAssetNode(room, interior);
    const cup = createAssetNode(coffee, interior);
    cup.width = roomNode.width * 0.055;
    cup.height = cup.width * coffee.height / coffee.width;
    cup.x = roomNode.x - roomNode.width / 2 + roomNode.width * cupX;
    cup.y = roomNode.y - roomNode.height / 2 + roomNode.height * cupY;
    interior.nodes.push(roomNode, cup);
    await images.ensure(interior.nodes.map((n) => n.assetId));
    loops.invalidate();
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, interior, {
      scale, quality: 'export', time: 1.5, masterCycle: loops.analyse(interior).master,
    });
    fs.writeFileSync(path.join(OUT, `${id}.png`), cv.toBuffer('image/png'));
    console.log(`rendered ${id}.png with an animated hearth, coffee and the composed world`);
  }

  // Review the larger contemporary windows against the same composed world.
  for (const id of ['modern-penthouse', 'future-sky-lounge', 'timber-great-room', 'oak-window-lounge', 'brick-timber-corner-room']) {
    const room = lib.get(`enchanted.foreground.${id}`);
    if (!room) continue;
    const interior = buildDemoScene(lib, { withEffects: false });
    interior.nodes.push(createAssetNode(room, interior));
    await images.ensure(interior.nodes.map((n) => n.assetId));
    loops.invalidate();
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, interior, {
      scale, quality: 'export', time: 1.5, masterCycle: loops.analyse(interior).master,
    });
    fs.writeFileSync(path.join(OUT, `${id}.png`), cv.toBuffer('image/png'));
    console.log(`rendered ${id}.png with the composed world through its panoramic window`);
  }

  // Show the separately movable interior props together in a room.
  {
    const interior = buildDemoScene(lib, { withEffects: false });
    const room = lib.get('enchanted.foreground.oak-window-lounge')!;
    interior.nodes.push(createAssetNode(room, interior));
    for (const [id, x, y, h] of [
      ['oak-bookshelf', 0.13, 0.72, 0.48],
      ['indoor-fig', 0.31, 0.78, 0.36],
      ['oak-floor-lamp', 0.96, 0.66, 0.46],
    ] as const) {
      const meta = lib.get(`enchanted.foreground.${id}`)!;
      const node = createAssetNode(meta, interior);
      node.x = interior.canvas.width * x;
      node.y = interior.canvas.height * y;
      node.height = interior.canvas.height * h;
      node.width = node.height * meta.width / meta.height;
      interior.nodes.push(node);
    }
    await images.ensure(interior.nodes.map((n) => n.assetId));
    loops.invalidate();
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, interior, {
      scale, quality: 'export', time: 1.5, masterCycle: loops.analyse(interior).master,
    });
    fs.writeFileSync(path.join(OUT, 'interior-loose-furnishings.png'), cv.toBuffer('image/png'));
    console.log('rendered interior-loose-furnishings.png with three independently placed props');
  }

  // Inspect the placeable gate, lit lantern and floating boat against their own vistas.
  for (const [id, bgId, x, y, height] of [
    ['chinese-moon-gate', 'chinese-mist-mountains', 0.5, 0.56, 0.63],
    ['japanese-stone-lantern', 'japanese-moon-garden', 0.23, 0.66, 0.58],
    ['norse-dragon-boat', 'mythic-waterside', 0.50, 0.78, 0.24],
    ['fairy-mushroom-cottage', 'fairy-court', 0.50, 0.61, 0.52],
    ['japanese-garden-bridge', 'japanese-moon-garden', 0.50, 0.70, 0.30],
    ['norse-stone-well', 'fairy-court', 0.72, 0.63, 0.38],
  ] as const) {
    const detailScene = createScene('enchanted');
    const bg = lib.get(`enchanted.background.${bgId}`)!;
    const detail = lib.get(`enchanted.middle.${id}`)!;
    await images.ensure([bg.id, detail.id]);
    const bgNode = createAssetNode(bg, detailScene);
    fitBackground(bgNode, detailScene, bg.width, bg.height);
    detailScene.nodes.push(bgNode);
    const node = createAssetNode(detail, detailScene);
    node.x = detailScene.canvas.width * x; node.y = detailScene.canvas.height * y;
    node.height = detailScene.canvas.height * height; node.width = node.height * detail.width / detail.height;
    detailScene.nodes.push(node);
    loops.invalidate();
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, detailScene, {
      scale, quality: 'export', time: 1.5, masterCycle: loops.analyse(detailScene).master,
    });
    fs.writeFileSync(path.join(OUT, `${id}.png`), cv.toBuffer('image/png'));
  }
  console.log('rendered six independently placeable garden and cultural details');

  // Review the close-up flowers individually over a background, not as a flattened arrangement.
  for (const [id, x, y, height] of [
    ['scarlet-dahlias', 0.30, 0.70, 0.60],
    ['golden-sunflowers', 0.70, 0.68, 0.65],
    ['white-orchids', 0.50, 0.68, 0.62],
    ['tulips', 0.32, 0.74, 0.62],
    ['daffodils', 0.68, 0.74, 0.60],
    ['cosmos', 0.50, 0.72, 0.58],
  ] as const) {
    const flowers = createScene('enchanted');
    const bg = lib.get('enchanted.background.enchanted-lake')!;
    const meta = lib.get(`enchanted.foreground.${id}`)!;
    await images.ensure([bg.id, meta.id]);
    flowers.nodes.push(createAssetNode(bg, flowers));
    const node = createAssetNode(meta, flowers);
    node.x = flowers.canvas.width * x; node.y = flowers.canvas.height * y;
    node.height = flowers.canvas.height * height; node.width = node.height * meta.width / meta.height;
    flowers.nodes.push(node);
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, flowers, { scale, quality: 'export', time: 0 });
    fs.writeFileSync(path.join(OUT, `${id}.png`), cv.toBuffer('image/png'));
  }
  console.log('rendered six independently placeable close-up flowers');

  // Review each animal on its own, then all of them together in one scene.
  const CREATURE_PLACEMENTS: Array<[string, string, number, number, number]> = [
    ['white-stag', 'middle', 0.30, 0.60, 0.46],
    ['red-fox', 'foreground', 0.68, 0.82, 0.30],
    ['mute-swans', 'middle', 0.62, 0.72, 0.34],
    ['koi-fish', 'foreground', 0.34, 0.86, 0.26],
    ['butterflies', 'foreground', 0.50, 0.52, 0.22],
    ['great-owl', 'middle', 0.78, 0.48, 0.26],
    ['rabbit', 'foreground', 0.16, 0.86, 0.16],
    ['red-squirrel', 'foreground', 0.86, 0.84, 0.18],
    ['mallard-ducks', 'middle', 0.46, 0.70, 0.26],
    ['hedgehog', 'foreground', 0.24, 0.92, 0.13],
    ['deer-fawn', 'middle', 0.70, 0.66, 0.24],
    ['moor-frog', 'foreground', 0.56, 0.94, 0.12],
    ['songbird-flock', 'middle', 0.50, 0.30, 0.30],
  ];
  for (const [id, layer, x, y, height] of CREATURE_PLACEMENTS) {
    const scene = createScene('enchanted');
    const bg = lib.get('enchanted.background.enchanted-lake')!;
    const meta = lib.get(`enchanted.${layer}.${id}`)!;
    await images.ensure([bg.id, meta.id]);
    scene.nodes.push(createAssetNode(bg, scene));
    const node = createAssetNode(meta, scene);
    node.x = scene.canvas.width * x; node.y = scene.canvas.height * y;
    node.height = scene.canvas.height * height; node.width = node.height * meta.width / meta.height;
    scene.nodes.push(node);
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, scene, { scale, quality: 'export', time: 0 });
    fs.writeFileSync(path.join(OUT, `${id}.png`), cv.toBuffer('image/png'));
  }

  const wildlife = createScene('enchanted');
  const wildBg = lib.get('enchanted.background.enchanted-lake')!;
  await images.ensure([wildBg.id, ...CREATURE_PLACEMENTS.map(([id, layer]) => `enchanted.${layer}.${id}`)]);
  const wildBgNode = createAssetNode(wildBg, wildlife);
  fitBackground(wildBgNode, wildlife, wildBg.width, wildBg.height);
  wildlife.nodes.push(wildBgNode);
  for (const [id, layer, x, y, height] of CREATURE_PLACEMENTS) {
    const meta = lib.get(`enchanted.${layer}.${id}`)!;
    const node = createAssetNode(meta, wildlife);
    node.x = wildlife.canvas.width * x; node.y = wildlife.canvas.height * y;
    node.height = wildlife.canvas.height * height; node.width = node.height * meta.width / meta.height;
    node.animation!.enabled = true;      // the animals are the point of the check
    node.animation!.seed = 100 + wildlife.nodes.length * 37;
    wildlife.nodes.push(node);
  }
  loops.invalidate();
  const wildCv = createCanvas(W, H);
  comp.render(wildCv.getContext('2d') as never, wildlife, {
    scale, quality: 'export', time: 1.4, masterCycle: loops.analyse(wildlife).master,
  });
  fs.writeFileSync(path.join(OUT, 'wildlife-scene.png'), wildCv.toBuffer('image/png'));
  console.log(`rendered ${CREATURE_PLACEMENTS.length} independently placeable creatures and wildlife-scene.png`);

  // The winter look is painted, not graded, so it gets its own composed sample.
  const winter = createScene('winter');
  autoCompose(winter, lib, { ...DEFAULT_COMPOSE, seed: 99 });
  await images.ensure(winter.nodes.map((n) => n.assetId));
  loops.invalidate();
  const winterCv = createCanvas(W, H);
  comp.render(winterCv.getContext('2d') as never, winter, {
    scale, quality: 'export', time: 1.2, masterCycle: loops.analyse(winter).master,
  });
  fs.writeFileSync(path.join(OUT, 'winter-world.png'), winterCv.toBuffer('image/png'));
  console.log(`rendered winter-world.png with ${winter.nodes.length} painted winter objects`);

  // The realistic look, and a look at the sparkle on its own.
  const real = createScene('realistic');
  autoCompose(real, lib, { ...DEFAULT_COMPOSE, seed: 7 });
  for (const node of real.nodes) {
    if (node.kind === 'effect' || !node.animation) continue;
    const meta = lib.get(node.assetId);
    if (meta?.animations.includes('sparkle')) { node.animation.enabled = true; node.animation.type = 'sparkle'; }
  }
  await images.ensure(real.nodes.map((n) => n.assetId));
  loops.invalidate();
  const realCv = createCanvas(W, H);
  comp.render(realCv.getContext('2d') as never, real, {
    scale, quality: 'export', time: 1.05, masterCycle: loops.analyse(real).master,
  });
  fs.writeFileSync(path.join(OUT, 'clearwater-world.png'), realCv.toBuffer('image/png'));

  const glint = createScene('realistic');
  const surface = lib.get('realistic.foreground.water-surface')!;
  await images.ensure([surface.id]);
  const gNode = createAssetNode(surface, glint);
  gNode.x = glint.canvas.width / 2; gNode.y = glint.canvas.height * 0.78;
  gNode.height = glint.canvas.height * 0.62; gNode.width = gNode.height * surface.width / surface.height;
  gNode.animation!.enabled = true;
  gNode.animation!.type = 'sparkle';
  gNode.animation!.amplitude = 1;
  glint.nodes = [gNode];
  loops.invalidate();
  for (const [name, t] of [['sparkle-a', 0.9], ['sparkle-b', 1.6]] as const) {
    const cv = createCanvas(W, H);
    comp.render(cv.getContext('2d') as never, glint, {
      scale, quality: 'export', time: t, masterCycle: loops.analyse(glint).master,
    });
    fs.writeFileSync(path.join(OUT, `${name}.png`), cv.toBuffer('image/png'));
  }
  console.log('rendered clearwater-world.png with sparkle, and two sparkle phases');

  /* ---- acceptance: the master cycle boundary must be pixel-identical ---- */
  const a = renderAt(0).cv.getContext('2d').getImageData(0, 0, W, H).data;
  const b = renderAt(report.master).cv.getContext('2d').getImageData(0, 0, W, H).data;
  let diff = 0, maxDelta = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) { diff++; if (d > maxDelta) maxDelta = d; }
  }
  const pct = (diff / a.length) * 100;
  console.log(`LOOP BOUNDARY: ${diff} differing subpixels (${pct.toFixed(4)}%), max delta ${maxDelta}`);
  if (pct > 0.05) { console.error('FAIL: loop boundary is not seamless'); process.exitCode = 1; }
  else console.log('PASS: master cycle returns to its exact initial state');

  /* ---- motion check: mid-cycle must actually differ ---- */
  const mid = renderAt(report.master / 2).cv.getContext('2d').getImageData(0, 0, W, H).data;
  let moved = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - mid[i]) > 6) moved++;
  console.log(`MOTION: ${((moved / (a.length / 4)) * 100).toFixed(2)}% of pixels changed mid-cycle`);
  if (moved / (a.length / 4) < 0.005) { console.error('FAIL: nothing appears to animate'); process.exitCode = 1; }

  /* ---- one composed world per background plate ---- */
  // Proves auto-composition produces a coherent scene for every environment,
  // not just the one the demo happens to open on.
  const backgrounds = lib.assets.filter((x) => x.layer === 'background');
  const wcols = 2, ww = 640, wh = 360;
  const wrows = Math.ceil(backgrounds.length / wcols);
  const worldSheet = createCanvas(wcols * ww, wrows * wh);
  const wctx = worldSheet.getContext('2d');
  for (let i = 0; i < backgrounds.length; i++) {
    const bgMeta = backgrounds[i];
    const ws = buildDemoScene(lib, { styleId: bgMeta.style, withEffects: true });
    const bgNode = ws.nodes.find((n) => n.layer === 'background');
    if (bgNode) {
      await images.ensure([bgMeta.id]);
      const entry = images.peek(bgMeta.id)!;
      bgNode.assetId = bgMeta.id;
      bgNode.name = bgMeta.name;
      fitBackground(bgNode, ws, entry.width, entry.height);
      // Re-compose around the swapped plate. The background is locked, so it
      // survives; everything else is re-grounded against the new ground line.
      autoCompose(ws, lib, { ...DEFAULT_COMPOSE, seed: 20261103, density: 'balanced', foreground: 0.62 });
    }
    await images.ensure(ws.nodes.map((n) => n.assetId));
    loops.invalidate();
    const wscale = ww / ws.canvas.width;
    const cv = createCanvas(ww, wh);
    comp.render(cv.getContext('2d') as never, ws, {
      scale: wscale, quality: 'export', time: 0, masterCycle: loops.analyse(ws).master,
    });
    wctx.drawImage(cv as never, (i % wcols) * ww, Math.floor(i / wcols) * wh);
    wctx.fillStyle = 'rgba(0,0,0,0.55)';
    wctx.fillRect((i % wcols) * ww, Math.floor(i / wcols) * wh, ww, 22);
    wctx.fillStyle = '#fff';
    wctx.font = '13px sans-serif';
    wctx.fillText(`${bgMeta.style} / ${bgMeta.name}  (${ws.nodes.length} nodes)`, (i % wcols) * ww + 8, Math.floor(i / wcols) * wh + 15);
    if (bgMeta.id === 'enchanted.background.lotus-sanctuary') {
      fs.writeFileSync(path.join(OUT, 'lotus-sanctuary-world.png'), cv.toBuffer('image/png'));
      console.log('rendered lotus-sanctuary-world.png');
    }
    if (bgMeta.id === 'enchanted.background.mythic-waterside') {
      fs.writeFileSync(path.join(OUT, 'waterside-world.png'), cv.toBuffer('image/png'));
      const room = lib.get(`${bgMeta.style}.foreground.lounge-window`);
      if (room) {
        await images.ensure([room.id]);
        ws.nodes.push(createAssetNode(room, ws));
        const roomCanvas = createCanvas(ww, wh);
        comp.render(roomCanvas.getContext('2d') as never, ws, {
          scale: wscale, quality: 'export', time: 0, masterCycle: loops.analyse(ws).master,
        });
        fs.writeFileSync(path.join(OUT, 'waterside-lounge.png'), roomCanvas.toBuffer('image/png'));
        ws.nodes.pop();
        console.log('rendered waterside-world.png and waterside-lounge.png');
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'worlds.png'), worldSheet.toBuffer('image/png'));
  console.log(`rendered worlds.png (${backgrounds.length} composed environments)`);

  /* ---- effect contact sheet ---- */
  const cols = 4, cw = 320, ch = 200;
  const rows = Math.ceil(EFFECTS.length / cols);
  const sheet = createCanvas(cols * cw, rows * ch);
  const sctx = sheet.getContext('2d');
  const fxScene = createScene('enchanted', 'effects');
  fxScene.canvas.width = cw; fxScene.canvas.height = ch;
  for (let i = 0; i < EFFECTS.length; i++) {
    const def = EFFECTS[i];
    const node = makeEffectNode(def.id, fxScene, 0);
    node.effect!.seed = 42;
    const params = node.effect!.params;
    if (typeof params.density === 'number') params.density = Math.min(params.density, 80);
    const cv = createCanvas(cw, ch);
    const ctx = cv.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, ch);
    grad.addColorStop(0, '#16203a'); grad.addColorStop(1, '#070a11');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.globalCompositeOperation = def.blend;
    def.draw(ctx as never, { w: cw, h: ch, u: 0.37, t: 0.37 * def.defaultLoop, params, seed: 42, scale: 1 });
    ctx.restore();
    sctx.drawImage(cv, (i % cols) * cw, Math.floor(i / cols) * ch);
    sctx.fillStyle = 'rgba(0,0,0,0.55)';
    sctx.fillRect((i % cols) * cw, Math.floor(i / cols) * ch + ch - 22, cw, 22);
    sctx.fillStyle = '#dbe4f2';
    sctx.font = '13px sans-serif';
    sctx.fillText(`${def.name}  (${def.family})`, (i % cols) * cw + 9, Math.floor(i / cols) * ch + ch - 7);
  }
  fs.writeFileSync(path.join(OUT, 'effects.png'), sheet.toBuffer('image/png'));
  console.log(`rendered effects.png (${EFFECTS.length} effects)`);

  /* ---- effect determinism / loop check ---- */
  let fxFailed = 0;
  for (const def of EFFECTS) {
    const node = makeEffectNode(def.id, fxScene, 0);
    const params = node.effect!.params;
    const draw = (u: number) => {
      const cv = createCanvas(160, 100);
      const ctx = cv.getContext('2d');
      def.draw(ctx as never, { w: 160, h: 100, u, t: u * def.defaultLoop, params, seed: 99, scale: 1 });
      return ctx.getImageData(0, 0, 160, 100).data;
    };
    const d0 = draw(0), d1 = draw(1);
    let bad = 0;
    for (let i = 0; i < d0.length; i++) if (d0[i] !== d1[i]) bad++;
    if (bad > 0) { console.error(`  effect ${def.id}: ${bad} subpixels differ at u=0 vs u=1`); fxFailed++; }
  }
  console.log(fxFailed === 0
    ? `PASS: all ${EFFECTS.length} effects are exactly periodic`
    : `FAIL: ${fxFailed} effects are not exactly periodic`);
  if (fxFailed) process.exitCode = 1;

  /* ---- per-asset transparency sanity ---- */
  const metas = lib.assets as AssetMeta[];
  let halo = 0;
  const blueKeyed = new Set(['wild-poppies', 'rose-peonies', 'golden-irises']);
  for (const m of metas.filter((x) => x.layer !== 'background')) {
    const isBlueKeyed = blueKeyed.has(m.id.split('.').at(-1)!);
    const img = await loadImage(path.join(ROOT, 'public/library', m.file));
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    for (let i = 0; i < data.length; i += 4) {
      const [r, gg, bb, aa] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const keyResidue = isBlueKeyed ? bb - Math.max(r, gg) > 70 : Math.min(r, bb) - gg > 70;
      if (aa > 200 && keyResidue) { halo++; break; }
    }
  }
  console.log(halo === 0 ? 'PASS: no studio key residue in object artwork' : `WARN: ${halo} assets show key residue`);

  console.log(`\nOutput written to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
