import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';
import { LoopManager } from '../src/animation/loopManager';
import { Compositor } from '../src/render/compositor';
import { createAssetNode, createScene, fitBackground } from '../src/scene/sceneModel';
import { findStyleClashes, switchStyle } from '../src/scene/styleManager';

const ROOT = path.resolve(import.meta.dirname, '..');
function library() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

async function isolated(id: string) {
  const lib = library();
  const meta = lib.get(id)!;
  const image = await loadImage(path.join(ROOT, 'public/library', meta.file));
  const cache = new Map([[id, { bitmap: image, width: image.width, height: image.height }]]);
  const images = { peek: (key: string | undefined) => key ? cache.get(key) ?? null : null,
    ensure: async () => {}, stats: { count: 1, bytes: 0, pending: 0 } };
  const loops = new LoopManager();
  const comp = new Compositor(lib, images as never, loops);
  const scene = createScene(meta.style);
  scene.canvas.width = 640; scene.canvas.height = 360;
  const node = createAssetNode(meta, scene);
  node.x = 320; node.y = id.includes('coffee-cup') ? 230 : 180;
  node.width = id.includes('coffee-cup') ? 250 : 600;
  node.height = id.includes('coffee-cup') ? 200 : 340;
  node.animation!.seed = 42;
  scene.nodes = [node];
  const draw = (time: number) => {
    const cv = createCanvas(640, 360), ctx = cv.getContext('2d');
    comp.render(ctx as never, scene, { scale: 1, quality: 'export', time, skipLighting: true });
    return ctx.getImageData(0, 0, 640, 360).data;
  };
  return { lib, meta, scene, node, draw };
}

describe('indoor views and living details', () => {
  it('ships matching editable room, fireplace and coffee assets in all palettes', () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      for (const id of ['hearth-reading-room', 'window-seat-room', 'stone-fireplace', 'coffee-cup']) {
        const meta = lib.get(`${style}.foreground.${id}`)!;
        expect(meta, `${style}/${id}`).toBeTruthy();
        expect(meta.alpha).toBe(true);
        const node = createAssetNode(meta, createScene(style));
        expect(node.animation?.enabled).toBe(true);
        expect(node.animation?.type).toBe(id === 'coffee-cup' ? 'coffee-steam' : 'hearth-fire');
      }
    }
  });

  it('keeps the chosen room, fireplace and steaming cup when switching styles', () => {
    const lib = library();
    const scene = createScene('enchanted');
    const ids = ['hearth-reading-room', 'window-seat-room', 'stone-fireplace', 'coffee-cup'];
    for (const id of ids) scene.nodes.push(createAssetNode(lib.get(`enchanted.foreground.${id}`)!, scene));
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const id of ids) {
        const node = scene.nodes.find((n) => n.assetId === `${style}.foreground.${id}`);
        expect(node?.animation?.enabled, `${style}/${id}`).toBe(true);
        expect(node?.animation?.type).toBe(id === 'coffee-cup' ? 'coffee-steam' : 'hearth-fire');
      }
    }
  });

  it('ships distinct modern rooms and independently placeable furniture in every style', () => {
    const lib = library();
    const scene = createScene('enchanted');
    const ids = ['modern-penthouse', 'future-sky-lounge', 'modern-sectional', 'future-lounge-chair', 'modern-fireplace',
      'timber-great-room', 'oak-window-lounge', 'brick-timber-corner-room', 'contemporary-oak-door', 'contemporary-oak-chair', 'contemporary-oak-table',
      'oak-bookshelf', 'indoor-fig', 'oak-floor-lamp'];
    for (const id of ids) {
      const asset = lib.get(`enchanted.foreground.${id}`)!;
      expect(asset.category).toBe('interiors');
      expect(asset.alpha).toBe(true);
      scene.nodes.push(createAssetNode(asset, scene));
    }
    for (const style of ['moonlit', 'autumn', 'enchanted']) {
      switchStyle(scene, lib, style);
      expect(findStyleClashes(scene, lib)).toEqual([]);
      for (const id of ids) expect(scene.nodes.some((n) => n.assetId === `${style}.foreground.${id}`), `${style}/${id}`).toBe(true);
      const fire = scene.nodes.find((n) => n.assetId === `${style}.foreground.modern-fireplace`)!;
      expect(fire.animation?.type).toBe('hearth-fire');
      expect(fire.animation?.enabled).toBe(true);
      const timberFire = scene.nodes.find((n) => n.assetId === `${style}.foreground.timber-great-room`)!;
      expect(timberFire.animation?.type).toBe('hearth-fire');
      expect(timberFire.animation?.enabled).toBe(true);
    }
  });

  it('keeps the bookshelf, plant and lamp independently editable', () => {
    const lib = library();
    const scene = createScene('enchanted');
    const nodes = ['oak-bookshelf', 'indoor-fig', 'oak-floor-lamp'].map((id) =>
      createAssetNode(lib.get(`enchanted.foreground.${id}`)!, scene));
    scene.nodes.push(...nodes);
    const original = nodes[1].x;
    nodes[0].x += 100;
    expect(nodes[1].x).toBe(original);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(3);
  });

  it('retains see-through gaps between the bookshelf shelves in every palette', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.foreground.oak-bookshelf`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const alpha = (x: number, y: number) => ctx.getImageData(Math.floor(x * img.width), Math.floor(y * img.height), 1, 1).data[3];
      expect(alpha(0.5, 0.15), `${style} shelf gap`).toBeLessThan(5);
      expect(alpha(0.08, 0.15), `${style} oak frame`).toBeGreaterThan(250);
    }
  });

  it('places room overlays as centered, full-canvas views by default', () => {
    const lib = library();
    for (const id of ['lounge-window', 'hearth-reading-room', 'window-seat-room', 'modern-penthouse', 'future-sky-lounge',
      'timber-great-room', 'oak-window-lounge', 'brick-timber-corner-room']) {
      const scene = createScene('enchanted');
      const node = createAssetNode(lib.get(`enchanted.foreground.${id}`)!, scene);
      expect(node.x).toBe(scene.canvas.width / 2);
      expect(node.y).toBe(scene.canvas.height / 2);
      expect(node.width).toBeGreaterThanOrEqual(scene.canvas.width);
      expect(node.height).toBeGreaterThanOrEqual(scene.canvas.height);
    }
  });

  it('provides large transparent panoramic windows in the modern rooms', async () => {
    const lib = library();
    for (const id of ['modern-penthouse', 'future-sky-lounge', 'timber-great-room', 'oak-window-lounge']) {
      const meta = lib.get(`enchanted.foreground.${id}`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
      let transparent = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 5) transparent++;
      const minimum = id === 'timber-great-room' || id === 'oak-window-lounge' ? 0.14 : 0.18;
      expect(transparent / (img.width * img.height), `${id} window opening`).toBeGreaterThan(minimum);
    }
  });

  it('has two separately framed transparent windows on adjoining walls in every palette', async () => {
    const lib = library();
    for (const style of ['enchanted', 'moonlit', 'autumn']) {
      const meta = lib.get(`${style}.foreground.brick-timber-corner-room`)!;
      const img = await loadImage(path.join(ROOT, 'public/library', meta.file));
      const cv = createCanvas(img.width, img.height), ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const alpha = (x: number, y: number) => ctx.getImageData(Math.floor(x * img.width), Math.floor(y * img.height), 1, 1).data[3];
      expect(alpha(0.27, 0.43), `${style} left window`).toBeLessThan(5);
      expect(alpha(0.66, 0.43), `${style} right window`).toBeLessThan(5);
      expect(alpha(0.49, 0.43), `${style} dividing wall`).toBeGreaterThan(250);
    }
  });

  it('animates the painted fires locally and returns pixel-perfectly to the loop start', async () => {
    for (const id of ['hearth-reading-room', 'window-seat-room', 'stone-fireplace', 'modern-fireplace', 'timber-great-room']) {
      const { meta, node, draw } = await isolated(`enchanted.foreground.${id}`);
      const a = draw(0), b = draw(1.1), loop = draw(node.animation!.loop);
      expect(Buffer.from(a).equals(Buffer.from(loop)), `${id} loop`).toBe(true);
      const [rx, ry, rw, rh] = meta.rig.region!;
      const x0 = node.x - node.width / 2 + rx * node.width;
      const y0 = node.y - node.height / 2 + ry * node.height;
      const x1 = x0 + rw * node.width, y1 = y0 + rh * node.height;
      let inside = 0, steamPixels = 0, outside = 0;
      const steam = meta.rig.steamRegion;
      const steamX = steam ? node.x - node.width / 2 + steam[0] * node.width : 0;
      const steamY = steam ? node.y - node.height / 2 + steam[1] * node.height : 0;
      const steamW = steam ? steam[2] * node.width : 0;
      const steamH = steam ? steam[3] * node.height : 0;
      for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
        const i = (y * 640 + x) * 4;
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) < 5) continue;
        if (x >= Math.floor(x0) - 1 && x <= Math.ceil(x1) + 1 && y >= Math.floor(y0) - 1 && y <= Math.ceil(y1) + 1) inside++;
        else if (steam && Math.abs(x - steamX) < steamW && y >= steamY - steamH - 5 && y <= steamY + 5) steamPixels++;
        else outside++;
      }
      expect(inside, `${id} fire did not flicker`).toBeGreaterThan(10);
      if (steam) expect(steamPixels, `${id} coffee did not steam`).toBeGreaterThan(0);
      expect(outside, `${id} moved outside its fire and steam`).toBe(0);
    }
  });

  it('shows moving steam above the coffee and loops exactly', async () => {
    const { node, draw } = await isolated('enchanted.foreground.coffee-cup');
    const a = draw(0), b = draw(2.5), loop = draw(node.animation!.loop);
    expect(Buffer.from(a).equals(Buffer.from(loop))).toBe(true);
    const cupTop = node.y - node.height / 2;
    let changedAbove = 0;
    for (let y = 0; y < Math.floor(cupTop); y++) for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 3) changedAbove++;
    }
    expect(changedAbove).toBeGreaterThan(10);
  });

  it('reveals the composed background through each new room window', async () => {
    const lib = library();
    for (const [id, px, py] of [
      ['hearth-reading-room', 0.61, 0.40], ['window-seat-room', 0.30, 0.35],
      ['modern-penthouse', 0.50, 0.40], ['future-sky-lounge', 0.50, 0.40],
      ['timber-great-room', 0.50, 0.40], ['oak-window-lounge', 0.50, 0.40],
      ['brick-timber-corner-room', 0.27, 0.43], ['brick-timber-corner-room', 0.66, 0.43],
    ] as const) {
      const bg = lib.get('enchanted.background.enchanted-lake')!;
      const room = lib.get(`enchanted.foreground.${id}`)!;
      const bgImg = await loadImage(path.join(ROOT, 'public/library', bg.file));
      const roomImg = await loadImage(path.join(ROOT, 'public/library', room.file));
      const cache = new Map([[bg.id, { bitmap: bgImg, width: bgImg.width, height: bgImg.height }],
        [room.id, { bitmap: roomImg, width: roomImg.width, height: roomImg.height }]]);
      const images = { peek: (key: string | undefined) => key ? cache.get(key) ?? null : null,
        ensure: async () => {}, stats: { count: 2, bytes: 0, pending: 0 } };
      const scene = createScene('enchanted'); scene.canvas.width = 640; scene.canvas.height = 360;
      const bgNode = createAssetNode(bg, scene); fitBackground(bgNode, scene, bgImg.width, bgImg.height);
      const roomNode = createAssetNode(room, scene); roomNode.x = 320; roomNode.y = 180; roomNode.width = 640; roomNode.height = 360;
      const comp = new Compositor(lib, images as never, new LoopManager());
      const render = () => {
        const cv = createCanvas(640, 360), ctx = cv.getContext('2d');
        comp.render(ctx as never, scene, { scale: 1, quality: 'export', time: 0, skipLighting: true });
        return ctx.getImageData(0, 0, 640, 360).data;
      };
      scene.nodes = [bgNode]; const world = render();
      scene.nodes = [bgNode, roomNode]; const withRoom = render();
      const center = (Math.floor(py * 360) * 640 + Math.floor(px * 640)) * 4;
      expect(Array.from(withRoom.slice(center, center + 4)), `${id} opening`).toEqual(Array.from(world.slice(center, center + 4)));
      const wall = (180 * 640 + 20) * 4;
      expect(Array.from(withRoom.slice(wall, wall + 3)), `${id} interior`).not.toEqual(Array.from(world.slice(wall, wall + 3)));
    }
  });
});
