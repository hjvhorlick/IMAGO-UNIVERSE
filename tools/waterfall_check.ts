/**
 * Renders the shipped waterfall at six phases and tiles the crops side by side
 * so the direction of flow can be judged by eye, not just by assertion.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createScene, createAssetNode, fitBackground } from '../src/scene/sceneModel';
import { makeAnimation } from '../src/core/types';

// Same headless canvas shim the render-check harness uses.
const g = globalThis as any;
g.document = { createElement: (tag: string) => (tag === 'canvas' ? createCanvas(1, 1) : {}) };

const ROOT = process.cwd();
const OUT = path.join(ROOT, '.render-check');
fs.mkdirSync(OUT, { recursive: true });

const lib = new AssetLibrary();
lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
const falls = lib.assets.find((a) => a.animations.includes('waterfall-flow'))!;
const bg = lib.assets.find((a) => a.style === falls.style && a.layer === 'background')!;

const cache = new Map<string, { bitmap: unknown; width: number; height: number }>();
for (const m of [falls, bg]) {
  const img = await loadImage(path.join(ROOT, 'public/library', m.file));
  cache.set(m.id, { bitmap: img, width: img.width, height: img.height });
}
const images = {
  peek: (id?: string) => (id ? cache.get(id) ?? null : null),
  ensure: async () => {}, stats: { count: cache.size, bytes: 0, pending: 0 },
};
const loops = new LoopManager();
const comp = new Compositor(lib, images as never, loops);
const scene = createScene(falls.style);
const bn = createAssetNode(bg, scene);
const bimg = cache.get(bg.id)!;
fitBackground(bn, scene, bimg.width, bimg.height);
bn.locked = true;
scene.nodes.push(bn);
const node = createAssetNode(falls, scene);
node.animation = makeAnimation('waterfall-flow', 8);
node.animation.enabled = true;
node.animation.loop = 8;
scene.nodes.push(node);

const W = 480, H = 270, scale = W / scene.canvas.width;
const phases = [0, 0.6, 1.2, 1.8, 2.4, 3.0];
// Crop tightly around the water column so the streaks are actually visible.
const [rx, ry, rw, rh] = falls.rig!.region as number[];
const left = node.x - node.width / 2, top = node.y - node.height / 2;
const cx = Math.max(0, Math.round((left + rx * node.width) * scale) - 6);
const cy = Math.max(0, Math.round((top + ry * node.height) * scale) - 6);
const cw = Math.min(W - cx, Math.round(rw * node.width * scale) + 12);
const ch = Math.min(H - cy, Math.round(rh * node.height * scale) + 12);

const Z = 5;
const sheet = createCanvas(cw * Z * phases.length, ch * Z + 26);
const sc = sheet.getContext('2d');
sc.fillStyle = '#0a0d12'; sc.fillRect(0, 0, sheet.width, sheet.height);
phases.forEach((t, i) => {
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  comp.render(ctx as never, scene, { scale, quality: 'export', time: t, skipLighting: true });
  sc.drawImage(cv, cx, cy, cw, ch, i * cw * Z, 26, cw * Z, ch * Z);
  sc.fillStyle = '#9aa7bd'; sc.font = '13px sans-serif';
  sc.fillText(`t = ${t.toFixed(1)}s`, i * cw * Z + 6, 17);
});
fs.writeFileSync(path.join(OUT, 'waterfall-phases.png'), sheet.toBuffer('image/png'));
console.log('region px:', { cx, cy, cw, ch }, '-> .render-check/waterfall-phases.png');
