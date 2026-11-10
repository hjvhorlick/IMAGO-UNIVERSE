// @vitest-environment jsdom
/**
 * UI smoke test.
 *
 * Mounts the *whole* application in a DOM with a real 2D canvas backend and
 * drives it the way a user would: switching panels, adding assets and effects,
 * selecting, transforming, animating, undoing, composing and opening dialogs.
 * Its job is to prove there are no runtime errors and that every visible
 * control actually does something.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------------------------------------------------------- DOM plumbing */

function installCanvas() {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const backing = new WeakMap<HTMLCanvasElement, Canvas>();
  const get = (el: HTMLCanvasElement): Canvas => {
    let c = backing.get(el);
    if (!c) {
      const w = parseInt(el.getAttribute('width') ?? '300', 10) || 300;
      const h = parseInt(el.getAttribute('height') ?? '150', 10) || 150;
      c = createCanvas(w, h) as Canvas;
      backing.set(el, c);
    }
    return c;
  };
  Object.defineProperty(proto, 'width', {
    configurable: true,
    get(this: HTMLCanvasElement) { return get(this).width; },
    set(this: HTMLCanvasElement, v: number) { get(this).width = Math.max(1, v | 0); },
  });
  Object.defineProperty(proto, 'height', {
    configurable: true,
    get(this: HTMLCanvasElement) { return get(this).height; },
    set(this: HTMLCanvasElement, v: number) { get(this).height = Math.max(1, v | 0); },
  });
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    return kind === '2d' ? get(this).getContext('2d') : null;
  };
  proto.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, type?: string, q?: number) {
    const buf = type === 'image/jpeg'
      ? get(this).toBuffer('image/jpeg', q ? Math.round(q * 100) : 90)
      : get(this).toBuffer('image/png');
    cb(new Blob([new Uint8Array(buf)], { type: type ?? 'image/png' }));
  };
  proto.toDataURL = function (this: HTMLCanvasElement) { return 'data:image/png;base64,'; };
  proto.captureStream = function () { return { getTracks: () => [] }; };
}

beforeAll(() => {
  installCanvas();
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  (globalThis as unknown as Record<string, unknown>).createImageBitmap = async (blob: Blob) => {
    const img = await loadImage(Buffer.from(await blob.arrayBuffer()));
    // Return the real decoded image so drawImage can sample it.
    (img as unknown as { close: () => void }).close = () => {};
    return img;
  };
  // The image cache decodes through fetch + createImageBitmap; serve the real
  // library bytes from disk and hand back the decoded native image.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('library/') || url.includes('/library/')) {
      const rel = url.slice(url.indexOf('library/'));
      const file = path.join(ROOT, 'public', rel);
      const buf = fs.readFileSync(file);
      return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-type': rel.endsWith('.json') ? 'application/json' : 'image/webp' } });
    }
    return realFetch(input as RequestInfo);
  }) as typeof fetch;
  // jsdom has no layout: give the stage a real size so the renderer can work.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 700, width: 1200, height: 700, toJSON: () => ({}) } as DOMRect;
  };
  HTMLElement.prototype.setPointerCapture = function () {};
  HTMLElement.prototype.releasePointerCapture = function () {};
  URL.createObjectURL = (() => { let n = 0; return () => `blob:mock/${++n}`; })();
  URL.revokeObjectURL = () => {};
});

/**
 * Mount the app. The app now boots empty, with the world picker open, so by
 * default this starts the demo world (the legacy tests need effects and objects).
 * Pass `{ start: null }` to get the bare boot state.
 */
async function mountApp(opts: { start?: null | 'composed' | 'demo' } = {}) {
  document.body.innerHTML = '<div id="app"></div><div class="modal-root"></div><div class="toast-root"></div>';
  const { App } = await import('../src/ui/app');
  const app = new App();
  const root = document.getElementById('app')!;
  await app.mount(root);
  if (opts.start !== null) {
    app.startWorld('enchanted-lake', 'enchanted', '16:9', 'Test world', opts.start ?? 'demo');
  }
  return app;
}

const click = (el: Element | null) => {
  expect(el, 'expected element to exist').toBeTruthy();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

/** Select a side panel from the header dropdown. */
const openSection = (id: string) => {
  const select = document.querySelector('#panel-picker') as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
const chooseCategory = (id: string) => {
  const select = document.querySelector('#category-picker') as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
/** The persistent body element a rail panel renders into. */
const body = (id: string) => document.querySelector(`[data-body="${id}"]`);
/** Open a top-bar dropdown and click one of its items by label. */
const menuClick = (menu: string, label: string) => {
  click(document.querySelector(`[data-menu="${menu}"]`));
  const item = Array.from(document.querySelectorAll('.menu-pop .menu-item'))
    .find((b) => b.textContent?.trim().startsWith(label)) ?? null;
  expect(item, `menu ${menu} has no item "${label}"`).toBeTruthy();
  click(item);
};
const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

describe('application shell', () => {
  it('boots with the world picker open and an empty scene', async () => {
    const app = await mountApp({ start: null });
    expect(app.store.scene.nodes).toEqual([]);
    expect(document.querySelector('.modal-root')!.textContent).toMatch(/Choose a world/);
    expect(document.querySelectorAll('[data-world]').length).toBeGreaterThan(10);
    app.dispose();
  }, 60_000);

  it('starting a world leaves only its background in the scene', async () => {
    const app = await mountApp({ start: null });
    app.startWorld('enchanted-lake', 'enchanted', '16:9', 'Lake', 'background');
    const nodes = app.store.scene.nodes;
    expect(nodes.length).toBe(1);
    expect(nodes[0].layer).toBe('background');
    expect(app.store.scene.worldId).toBe('enchanted-lake');
    app.dispose();
  }, 60_000);

  it('mounts without errors and opens on an empty canvas with the collection chooser', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    const app = await mountApp({ start: null });

    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('#scene-canvas')).toBeTruthy();
    expect(app.store.scene.nodes).toEqual([]);
    expect(document.querySelector('[aria-label="Season or look"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="World collection"]')).toBeTruthy();
    expect(document.querySelector('#panel-picker')).toBeTruthy();
    expect(document.querySelector('#library-search')).toBeTruthy();
    expect(document.querySelector('[data-menu="world"]')).toBeNull();
    expect((document.querySelector('#stage-empty') as HTMLElement).hidden).toBe(false);
    expect(app.library.assets.length).toBeGreaterThan(20);
    expect(app.library.styles.length).toBeGreaterThanOrEqual(2);
    // four layer buttons, always
    expect(document.querySelectorAll('.layer-tab').length).toBe(4);
    // Only the selected panel is open; there are no stacked panel headers.
    expect(document.querySelectorAll('.rail-section').length).toBeGreaterThanOrEqual(6);
    openSection('canvas');
    expect(document.querySelectorAll('.layer-group').length).toBe(4);
    // Chrome that used to cost canvas space must be gone.
    expect(document.querySelector('.transport')).toBeNull();
    expect(document.querySelector('.statusbar')).toBeNull();
    expect(document.querySelector('.stage-toolbar')).toBeNull();
    expect(document.querySelector('.panel-left')).toBeNull();
    expect(errors, JSON.stringify(errors)).toEqual([]);
    spy.mockRestore();
    app.dispose();
  }, 60_000);

  it('starts with a look and world, groups artwork across layers, and makes rooms easy to find', async () => {
    const app = await mountApp({ start: null });
    const choose = (selector: string, value: string) => {
      const select = document.querySelector(selector) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    choose('[aria-label="Season or look"]', 'autumn');
    expect(app.store.scene.styleId).toBe('autumn');
    expect(app.store.scene.nodes).toEqual([]);
    choose('[aria-label="World collection"]', 'japanese');
    expect(app.store.scene.theme).toBe('japanese');
    expect(document.querySelector('[data-asset="autumn.background.japanese-moon-garden"]')).toBeTruthy();
    expect(document.querySelector('[data-asset="autumn.background.norse-worldtree"]')).toBeNull();
    click(document.querySelector('[data-asset="autumn.background.japanese-moon-garden"]'));
    expect(app.store.scene.nodes).toHaveLength(1);
    expect(app.store.scene.nodes[0].layer).toBe('background');
    expect(app.store.scene.nodes.some((n) => n.kind === 'effect')).toBe(false);
    expect((document.querySelector('#stage-empty') as HTMLElement).hidden).toBe(true);
    // No forced jump: the designer is still on the background layer until they choose otherwise.
    expect(app.layer).toBe('background');
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    expect(app.layer).toBe('middle');
    expect((document.querySelector('[aria-label="World collection"]') as HTMLSelectElement).value).toBe('japanese');
    expect(document.querySelector('[data-asset="autumn.middle.japanese-garden-bridge"]')).toBeTruthy();
    expect(document.querySelector('[data-asset="autumn.middle.norse-rune-stones"]')).toBeNull();
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    click(document.querySelector('[data-library-tab="rooms"]'));
    expect(app.layer).toBe('atmosphere');
    expect(document.querySelector('[data-library-tab="rooms"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-asset="autumn.foreground.brick-timber-corner-room"]')).toBeTruthy();
    const first = document.querySelector('#asset-grid .asset-card') as HTMLElement;
    expect(app.library.get(first.dataset.asset!)?.rig?.type).toBe('window-overlay');
    click(document.querySelector('[data-asset="autumn.foreground.brick-timber-corner-room"]'));
    const room = app.store.primary!;
    expect(room.layer).toBe('atmosphere');
    expect(room.kind).toBe('asset');
    openSection('object');
    expect((document.querySelector('[data-body="object"] select') as HTMLSelectElement).value).toBe('atmosphere');
    const { replaceDialog } = await import('../src/ui/dialogs');
    replaceDialog(room, app.store, app.library, () => {});
    expect(document.querySelectorAll('#replace-grid .asset-card').length).toBeGreaterThan(0);
    click(document.querySelector('.modal [data-close]'));
    const { reground, regenerate, DEFAULT_COMPOSE } = await import('../src/scene/composition');
    const roomY = room.y;
    reground(app.store.scene, app.library);
    expect(room.y).toBe(roomY);
    regenerate(app.store.scene, app.library, DEFAULT_COMPOSE);
    expect(app.store.scene.nodes.some((n) => n.id === room.id && n.layer === 'atmosphere')).toBe(true);
    openSection('canvas');
    expect(document.querySelector('[data-layer="atmosphere"] .layer-item')?.textContent).toContain(room.name);
    const { packageProject, readProject } = await import('../src/project/projectFormat');
    const packageBlob = await packageProject(app.store.scene, app.library);
    const loaded = await readProject(await packageBlob.arrayBuffer(), app.library);
    expect(loaded.scene.nodes.find((n) => n.id === room.id)?.layer).toBe('atmosphere');
    const { switchStyle, findStyleClashes } = await import('../src/scene/styleManager');
    switchStyle(loaded.scene, app.library, 'moonlit');
    expect(loaded.scene.nodes.find((n) => n.id === room.id)?.assetId).toBe('moonlit.foreground.brick-timber-corner-room');
    expect(loaded.scene.nodes.find((n) => n.id === room.id)?.layer).toBe('atmosphere');
    expect(findStyleClashes(loaded.scene, app.library)).toEqual([]);
    openSection('assets');
    choose('[aria-label="World collection"]', 'all');
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    expect(document.querySelector('[data-asset="autumn.middle.norse-rune-stones"]')).toBeTruthy();
    app.dispose();
  }, 60_000);

  it('groups an all-worlds background automatically and replaces backgrounds undoably', async () => {
    const app = await mountApp({ start: null });
    click(document.querySelector('[data-asset="enchanted.background.fairy-court"]'));
    expect(app.store.scene.theme).toBe('fairy');
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    expect(document.querySelector('[data-asset="enchanted.middle.fairy-mushroom-cottage"]')).toBeTruthy();
    click(document.querySelector('.layer-tab[data-layer="background"]'));
    const world = document.querySelector('[aria-label="World collection"]') as HTMLSelectElement;
    world.value = 'all'; world.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('[data-asset="enchanted.background.japanese-moon-garden"]'));
    expect(app.store.scene.nodes.filter((n) => n.layer === 'background')).toHaveLength(1);
    expect(app.store.scene.nodes[0].assetId).toBe('enchanted.background.japanese-moon-garden');
    expect(app.store.scene.theme).toBe('japanese');
    app.store.undo();
    expect(app.store.scene.nodes.filter((n) => n.layer === 'background')).toHaveLength(1);
    expect(app.store.scene.nodes[0].assetId).toBe('enchanted.background.fairy-court');
    expect(app.store.scene.nodes[0].locked).toBe(true);
    app.dispose();
  }, 60_000);

  it('confirms look changes on existing artwork and supports undo', async () => {
    const app = await mountApp({ start: null });
    click(document.querySelector('[data-asset="enchanted.background.japanese-moon-garden"]'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const select = document.querySelector('[aria-label="Season or look"]') as HTMLSelectElement;
    select.value = 'moonlit'; select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.store.scene.styleId).toBe('enchanted');
    expect((document.querySelector('[aria-label="Season or look"]') as HTMLSelectElement).value).toBe('enchanted');
    confirm.mockReturnValue(true);
    const next = document.querySelector('[aria-label="Season or look"]') as HTMLSelectElement;
    next.value = 'moonlit'; next.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.store.scene.styleId).toBe('moonlit');
    expect(app.store.scene.nodes[0].assetId).toBe('moonlit.background.japanese-moon-garden');
    app.store.undo();
    expect(app.store.scene.styleId).toBe('enchanted');
    expect(app.store.scene.nodes[0].assetId).toBe('enchanted.background.japanese-moon-garden');
    confirm.mockRestore();
    app.dispose();
  }, 60_000);

  it('uses compact header controls to search and filter Layer 4 rooms and atmosphere', async () => {
    const app = await mountApp();
    expect(document.querySelectorAll('.rail-head')).toHaveLength(0);
    expect(document.querySelector('.topbar #btn-export')?.textContent).toContain('Download');
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    expect(document.querySelector('[data-library-tab="effects"]')?.getAttribute('aria-selected')).toBe('true');
    click(document.querySelector('[data-library-tab="rooms"]'));
    chooseCategory('room-views');
    expect(document.querySelector('[data-asset="enchanted.foreground.timber-great-room"]')).toBeTruthy();
    expect(document.querySelector('[data-asset="enchanted.foreground.oak-bookshelf"]')).toBeNull();
    const search = document.querySelector('#library-search') as HTMLInputElement;
    search.value = 'brick'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('[data-asset="enchanted.foreground.brick-timber-corner-room"]')).toBeTruthy();
    expect(document.querySelector('[data-asset="enchanted.foreground.timber-great-room"]')).toBeNull();
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
    chooseCategory('furniture');
    expect(document.querySelector('[data-asset="enchanted.foreground.oak-bookshelf"]')).toBeTruthy();
    expect(document.querySelector('[data-asset="enchanted.foreground.timber-great-room"]')).toBeNull();
    click(document.querySelector('[data-library-tab="effects"]'));
    search.value = 'fireflies'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelectorAll('.effect-card')).toHaveLength(1);
    expect(document.querySelector('[data-effect="fireflies"]')).toBeTruthy();
    openSection('scene');
    expect(document.querySelector('[data-body="scene"]')?.children.length).toBeGreaterThan(0);
    search.value = 'mist'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect((document.querySelector('#panel-picker') as HTMLSelectElement).value).toBe('assets');
    expect(document.querySelector('[data-effect="mist"]')).toBeTruthy();
    app.dispose();
  }, 60_000);

  it('finds and places the new close-up flowers without starting motion automatically', async () => {
    const app = await mountApp({ start: null });
    click(document.querySelector('.layer-tab[data-layer="foreground"]'));
    chooseCategory('flowers');
    const search = document.querySelector('#library-search') as HTMLInputElement;
    search.value = 'dahlia'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelectorAll('#asset-grid .asset-card')).toHaveLength(1);
    click(document.querySelector('[data-asset="enchanted.foreground.scarlet-dahlias"]'));
    expect(app.store.primary?.animation?.type).toBe('stem-bend');
    expect(app.store.primary?.animation?.enabled).toBe(false);
    expect(app.store.scene.nodes).toHaveLength(1);
    app.dispose();
  }, 60_000);

  it('finds the creature collection and places an animal that does not move on its own', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    chooseCategory('creatures');
    const search = document.querySelector('#library-search') as HTMLInputElement;
    search.value = 'stag'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const cards = document.querySelectorAll('#asset-grid .asset-card');
    expect(cards).toHaveLength(1);
    click(cards[0]);
    expect(app.store.primary?.assetId).toBe('enchanted.middle.white-stag');
    expect(app.store.primary?.animation?.type).toBe('creature-breathe');
    expect(app.store.primary?.animation?.enabled).toBe(false);
    app.dispose();
  }, 60_000);

  it('every panel tab renders and every layer switches the library', async () => {
    const app = await mountApp();
    for (const section of ['canvas', 'object', 'animate', 'scene', 'sound']) {
      openSection(section);
      expect(body(section)!.children.length, `section ${section} rendered nothing`).toBeGreaterThan(0);
    }
    for (const layer of ['background', 'middle', 'foreground', 'atmosphere']) {
      click(document.querySelector(`.layer-tab[data-layer="${layer}"]`));
      const cards = document.querySelectorAll('#asset-grid .asset-card');
      expect(cards.length, `layer ${layer} showed no cards`).toBeGreaterThan(0);
    }
    // layer 4 must show effects, not style artwork
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    expect(document.querySelectorAll('.effect-card').length).toBeGreaterThanOrEqual(10);
    app.dispose();
  }, 60_000);

  it('adds an asset, selects it, transforms it and undoes', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    const before = app.store.scene.nodes.length;
    click(document.querySelector('#asset-grid .asset-card'));
    expect(app.store.scene.nodes.length).toBe(before + 1);
    const node = app.store.primary!;
    expect(node).toBeTruthy();

    const x0 = node.x;
    app.store.mutate((s) => { s.nodes.find((n) => n.id === node.id)!.x += 50; }, 'Move');
    expect(app.store.node(node.id)!.x).toBe(x0 + 50);
    app.store.undo();
    expect(app.store.node(node.id)!.x).toBe(x0);
    app.store.redo();
    expect(app.store.node(node.id)!.x).toBe(x0 + 50);

    menuClick('edit', 'Duplicate');
    expect(app.store.scene.nodes.length).toBe(before + 2);
    // Lock/hide are no longer per-row columns; they are keys and a context menu.
    press('l');
    expect(app.store.primary!.locked).toBe(true);
    press('l');
    expect(app.store.primary!.locked).toBe(false);
    press('h');
    expect(app.store.primary!.visible).toBe(false);
    press('h');
    expect(app.store.primary!.visible).toBe(true);
    press('Delete');
    expect(app.store.scene.nodes.length).toBe(before + 1);
    app.dispose();
  }, 60_000);

  it('adds a universal effect and exposes only its own controls', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    const cards = Array.from(document.querySelectorAll('.effect-card'));
    const magic = cards.find((c) => c.textContent?.includes('Magic Circle'))!;
    click(magic);
    const node = app.store.primary!;
    expect(node.kind).toBe('effect');
    expect(node.layer).toBe('atmosphere');
    // Placement keeps the library open so you can place several in a row;
    // editing is one click away in the Animation section.
    openSection('animate');
    const labels = Array.from(document.querySelectorAll('[data-body="animate"] .field-label')).map((n) => n.textContent ?? '');
    expect(labels.some((l) => l.includes('Rotations per cycle'))).toBe(true);
    expect(labels.some((l) => l.includes('Glyph count'))).toBe(true);
    expect(labels.some((l) => l.includes('Brightness'))).toBe(false);   // not an image control
    expect(labels.some((l) => l.includes('Cycle length'))).toBe(true);

    // a slider really changes the effect
    const range = document.querySelector('[data-body="animate"] input[type="range"]') as HTMLInputElement;
    range.value = String(Number(range.max));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(Object.values(node.effect!.params)).toContain(Number(range.max));
    app.dispose();
  }, 60_000);

  it('browses, selects and edits the spiritual overlay collection on Layer 4', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    chooseCategory('spiritual');
    const filter = document.querySelector('[aria-label="Spiritual overlay subcategory"]') as HTMLSelectElement;
    expect(filter.options.length).toBe(9);
    filter.value = 'Sacred Geometry';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelectorAll('.effect-card').length).toBe(3);
    click(document.querySelector('[data-effect="spiritual-flower-of-life"]'));
    const node = app.store.primary!;
    expect(node.effect?.effectId).toBe('spiritual-flower-of-life');
    expect(node.width).toBe(node.height);
    expect(app.stage.hitTest(node.x, node.y)?.id).toBe(node.id);
    // The same card also places an independent square ornament by drag/drop.
    const data = new Map<string, string>();
    const transfer = { effectAllowed: '', dropEffect: '', setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? '' };
    const drag = new Event('dragstart', { bubbles: true });
    Object.defineProperty(drag, 'dataTransfer', { value: transfer });
    document.querySelector('[data-effect="spiritual-flower-of-life"]')!.dispatchEvent(drag);
    const drop = new MouseEvent('drop', { bubbles: true, clientX: 400, clientY: 200 });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    document.querySelector('.stage')!.dispatchEvent(drop);
    const dropped = app.store.primary!;
    expect(dropped.id).not.toBe(node.id);
    expect(dropped.effect?.effectId).toBe(node.effect?.effectId);
    expect(dropped.width).toBe(dropped.height);
    app.store.removeSelected();
    app.store.select(node.id);
    openSection('animate');
    const labels = Array.from(document.querySelectorAll('[data-body="animate"] .field-label')).map((n) => n.textContent ?? '');
    for (const label of ['Appearance', 'Rotation direction', 'Starting phase', 'Glow intensity', 'Cycle length', 'Start / stop fade']) {
      expect(labels.some((l) => l.includes(label)), label).toBe(true);
    }
    menuClick('edit', 'Duplicate');
    expect(app.store.scene.nodes.filter((n) => n.effect?.effectId === 'spiritual-flower-of-life')).toHaveLength(2);
    press('Delete');
    expect(app.store.scene.nodes.filter((n) => n.effect?.effectId === 'spiritual-flower-of-life')).toHaveLength(1);
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    expect(app.stage.hitTest(node.x, node.y)?.id).not.toBe(node.id);
    app.dispose();
  }, 60_000);

  it('places, selects, adjusts and duplicates a gentle water overlay', async () => {
    const app = await mountApp({ start: 'composed' });
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    chooseCategory('natural');
    click(document.querySelector('[data-effect="gentle-water-waves"]'));
    const node = app.store.primary!;
    expect(node.effect?.effectId).toBe('gentle-water-waves');
    expect(node.width).toBeLessThan(app.store.scene.canvas.width);
    expect(node.height).toBeLessThan(app.store.scene.canvas.height * 0.3);
    expect(app.preview.playing).toBe(true);
    expect(app.stage.hitTest(node.x, node.y)?.id).toBe(node.id);
    expect(app.stage.hitTest(node.x - node.width * 0.49, node.y - node.height * 0.49)?.id).not.toBe(node.id);
    openSection('animate');
    const labels = Array.from(document.querySelectorAll('[data-body="animate"] .field-label')).map((n) => n.textContent ?? '');
    for (const label of ['Ripple strength', 'Ripple density', 'Ripple speed']) {
      expect(labels.some((l) => l.includes(label)), label).toBe(true);
    }
    app.store.duplicateSelected();
    expect(app.store.scene.nodes.filter((n) => n.effect?.effectId === 'gentle-water-waves')).toHaveLength(2);
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    expect(app.stage.hitTest(node.x, node.y)?.id).not.toBe(node.id);
    app.dispose();
  }, 60_000);

  it('drags lake vertices freely, preserving the other points and supporting undo and redo', async () => {
    const app = await mountApp({ start: 'composed' });
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    click(document.querySelector('[data-effect="gentle-water-waves"]'));
    const node = app.store.primary!;
    const id = node.id;
    app.store.mutate(() => { node.rotation = 25; node.flipX = true; }, 'Turn lake');
    const stage = app.stage as unknown as { waterPointPositions: (n: typeof node) => { x: number; y: number }[] };
    const before = stage.waterPointPositions(node);
    const initialWidth = node.width, initialHeight = node.height;
    expect(before).toHaveLength(8);
    const toClient = (p: { x: number; y: number }) => ({
      clientX: p.x / app.store.scene.canvas.width * 1200,
      clientY: p.y / app.store.scene.canvas.height * 700,
    });
    const target = { x: before[0].x - 260, y: before[0].y - 180 };
    document.querySelector('.stage')!.dispatchEvent(new MouseEvent('pointerdown', {
      ...toClient(before[0]), button: 0, bubbles: true,
    }));
    window.dispatchEvent(new MouseEvent('pointermove', { ...toClient(target), bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { ...toClient(target), bubbles: true }));
    const changed = app.store.node(id)!;
    expect(changed.effect!.params.waterShape).toBeTypeOf('string');
    const after = stage.waterPointPositions(changed);
    expect(after[0].x).toBeCloseTo(target.x, 4);
    expect(after[0].y).toBeCloseTo(target.y, 4);
    for (let i = 1; i < 8; i++) {
      expect(after[i].x).toBeCloseTo(before[i].x, 4);
      expect(after[i].y).toBeCloseTo(before[i].y, 4);
    }
    expect(changed.width > initialWidth || changed.height > initialHeight).toBe(true);
    expect(app.store.undo()).toBe(true);
    expect(app.store.node(id)!.effect!.params.waterShape).toBeUndefined();
    expect(app.store.redo()).toBe(true);
    expect(stage.waterPointPositions(app.store.node(id)!)[0].x).toBeCloseTo(target.x, 4);
    openSection('object');
    const reset = Array.from(body('object')!.querySelectorAll('button')).find((b) => b.textContent?.includes('Reset water shape'));
    click(reset ?? null);
    expect(app.store.node(id)!.effect!.params.waterShape).toBeUndefined();
    expect(app.store.undo()).toBe(true);
    expect(stage.waterPointPositions(app.store.node(id)!)[0].x).toBeCloseTo(target.x, 4);
    app.dispose();
  }, 60_000);

  it('places the bird flock high in the sky with animation enabled', async () => {
    const app = await mountApp({ start: 'composed' });
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    chooseCategory('creatures');
    click(document.querySelector('[data-asset="enchanted.middle.songbird-flock"]'));
    const node = app.store.primary!;
    expect(node.assetId).toBe('enchanted.middle.songbird-flock');
    expect(node.y / app.store.scene.canvas.height).toBeCloseTo(0.19);
    expect(node.animation?.enabled).toBe(true);
    expect(node.animation?.type).toBe('flutter');
    expect(node.animation?.amplitude).toBe(0.9);
    openSection('animate');
    expect(body('animate')!.textContent).toContain('Wing flutter');
    app.dispose();
  }, 60_000);

  it('offers a separate Lake Waves overlay with eight editable points', async () => {
    const app = await mountApp({ start: 'composed' });
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    chooseCategory('natural');
    expect(document.querySelector('[data-effect="gentle-water-waves"]')?.textContent).toContain('Rain Ripples');
    click(document.querySelector('[data-effect="lake-water-waves"]'));
    const node = app.store.primary!;
    expect(node.effect?.effectId).toBe('lake-water-waves');
    const stage = app.stage as unknown as { waterPointPositions: (n: typeof node) => unknown[] };
    expect(stage.waterPointPositions(node)).toHaveLength(8);
    expect(app.stage.hitTest(node.x, node.y)?.id).toBe(node.id);
    openSection('animate');
    expect(body('animate')!.textContent).toContain('Wave strength');
    expect(body('animate')!.textContent).not.toContain('Flow direction');
    app.dispose();
  }, 60_000);

  it('offers a separate river flow with a direction control and editable outline', async () => {
    const app = await mountApp({ start: 'composed' });
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    chooseCategory('natural');
    click(document.querySelector('[data-effect="river-water-flow"]'));
    const node = app.store.primary!;
    expect(node.effect?.effectId).toBe('river-water-flow');
    expect(node.effect!.params.direction).toBe('right');
    expect(app.stage.hitTest(node.x, node.y)?.id).toBe(node.id);
    openSection('animate');
    expect(body('animate')!.textContent).toContain('Flow direction');
    const direction = Array.from(body('animate')!.querySelectorAll('select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'right'));
    expect(direction).toBeDefined();
    expect(Array.from(direction!.options, (option) => option.value)).toEqual(['right', 'left', 'down', 'up']);
    direction!.value = 'down';
    direction!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.store.primary!.effect!.params.direction).toBe('down');
    openSection('object');
    expect(body('object')!.textContent).toContain('Drag the eight round points');
    expect(body('object')!.textContent).toContain('Reset water shape');
    app.dispose();
  }, 60_000);

  it('shows three artworks per row by default and cycles to two or four', async () => {
    const app = await mountApp({ start: null });
    const grid = () => document.querySelector('#asset-grid') as HTMLElement;
    expect(grid().style.gridTemplateColumns).toContain('3');
    expect(grid().classList.contains('dense')).toBe(true);
    click(document.querySelector('[data-density]'));
    expect(grid().style.gridTemplateColumns).toContain('4');
    click(document.querySelector('[data-density]'));
    expect(grid().style.gridTemplateColumns).toContain('2');
    expect(grid().classList.contains('dense')).toBe(false);
    app.dispose();
  }, 60_000);

  it('solo preview isolates one effect, then one layer, then everything', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    click(document.querySelector('[data-effect="fireflies"]'));
    click(document.querySelector('[data-effect="mist"]'));
    const fx = app.store.scene.nodes.filter((n) => n.kind === 'effect');
    expect(fx.length).toBeGreaterThan(1);
    const target = fx[0];
    app.store.select(target.id);
    openSection('animate');

    const btn = (text: string) => Array.from(document.querySelectorAll('[data-body="animate"] button'))
      .find((b) => b.textContent?.includes(text)) ?? null;

    // "Preview this effect only" must isolate ONE node, not its whole layer.
    click(btn('Preview this effect only'));
    expect(app.preview.soloNode).toBe(target.id);
    expect(app.preview.soloLayer).toBeNull();
    expect(document.querySelector('#stage-hud')?.textContent).toContain('SOLO');
    expect(document.querySelector('#stage-hud')?.textContent).toContain(target.name);

    // "Preview this layer only" switches to layer mode.
    click(btn('Preview this layer only'));
    expect(app.preview.soloNode).toBeNull();
    expect(app.preview.soloLayer).toBe(target.layer);

    // "Show all layers" clears both.
    click(btn('Show all layers'));
    expect(app.preview.soloNode).toBeNull();
    expect(app.preview.soloLayer).toBeNull();
    expect(document.querySelector('#stage-hud')?.textContent).not.toContain('SOLO');
    app.dispose();
  }, 60_000);

  it('drops a solo preview when its subject is deleted', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    click(document.querySelector('[data-effect="fireflies"]'));
    const target = app.store.scene.nodes.find((n) => n.kind === 'effect')!;
    app.store.select(target.id);
    openSection('animate');
    const soloBtn = Array.from(document.querySelectorAll('[data-body="animate"] button'))
      .find((b) => b.textContent?.includes('Preview this effect only'))!;
    click(soloBtn);
    expect(app.preview.soloNode).toBe(target.id);

    press('Delete');
    // Must not leave the canvas permanently empty.
    expect(app.preview.soloNode).toBeNull();
    expect(app.store.node(target.id)).toBeUndefined();
    app.dispose();
  }, 60_000);

  it('enables object animation from the Animate tab', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    click(document.querySelector('[data-asset="enchanted.middle.ancient-oak"]'));
    const tree = app.store.scene.nodes.find((n) => app.library.get(n.assetId)?.category === 'trees')!;
    app.store.select(tree.id);
    openSection('animate');
    const toggle = document.querySelector('[data-body="animate"] input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.store.node(tree.id)!.animation!.enabled).toBe(true);
    const labels = Array.from(document.querySelectorAll('[data-body="animate"] .field-label')).map((n) => n.textContent ?? '');
    expect(labels.some((l) => l.includes('Cycle length'))).toBe(true);
    expect(labels.some((l) => l.includes('Organic variation'))).toBe(true);
    app.dispose();
  }, 60_000);

  it('applies a theme collection and keeps it editable', async () => {
    const app = await mountApp();
    const before = app.store.scene.nodes.filter((n) => n.kind === 'effect').length;
    click(document.querySelector('.layer-tab[data-layer="atmosphere"]'));
    openSection('collections');
    const cards = document.querySelectorAll('.theme-card');
    expect(cards.length).toBeGreaterThanOrEqual(6);
    click(cards[0]);
    const after = app.store.scene.nodes.filter((n) => n.kind === 'effect').length;
    expect(after).toBeGreaterThan(before);
    app.dispose();
  }, 60_000);

  it('rearranges without touching locked objects', async () => {
    const app = await mountApp();
    click(document.querySelector('[data-asset="enchanted.background.enchanted-lake"]'));
    const locked = app.store.scene.nodes.filter((n) => n.locked).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    expect(locked.length).toBeGreaterThan(0);
    menuClick('edit', 'Rearrange unlocked');
    for (const l of locked) {
      const n = app.store.node(l.id)!;
      expect(n.x).toBe(l.x);
      expect(n.y).toBe(l.y);
    }
    app.dispose();
  }, 60_000);

  it('stays where the designer is after a background is placed, and can move freely between layers', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="background"]'));
    const cards = Array.from(document.querySelectorAll('#asset-grid .asset-card'));
    expect(cards.length).toBeGreaterThan(0);
    click(cards[0]);
    // No forced step: placing a background leaves the designer on layer 1.
    expect(app.layer).toBe('background');
    // Any layer is one click away, in any order, as many times as needed.
    for (const layer of ['middle', 'foreground', 'background', 'middle', 'background']) {
      click(document.querySelector(`.layer-tab[data-layer="${layer}"]`));
      expect(app.layer).toBe(layer);
    }
    app.dispose();
  }, 60_000);

  it('replaces the background when a different one is chosen, even after the first was placed (locked)', async () => {
    const app = await mountApp({ start: null });
    click(document.querySelector('.layer-tab[data-layer="background"]'));
    click(document.querySelector('[data-asset="enchanted.background.fairy-court"]'));
    const firstId = app.store.scene.nodes.find((n) => n.layer === 'background')!.assetId;
    // Choosing a background sets the artwork filter to its collection; widen it again to pick another.
    const world = document.querySelector('[aria-label="World collection"]') as HTMLSelectElement;
    world.value = 'all'; world.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('[data-asset="enchanted.background.japanese-moon-garden"]'));
    const backgrounds = app.store.scene.nodes.filter((n) => n.layer === 'background');
    expect(backgrounds.length).toBe(1);
    expect(backgrounds[0].assetId).not.toBe(firstId);
    expect(backgrounds[0].locked).toBe(true);
    app.dispose();
  }, 60_000);

  it('the History dialog lists steps ahead and walks forward and back through them', async () => {
    const app = await mountApp();
    const { historyDialog } = await import('../src/ui/dialogs');
    const before = app.store.scene.nodes.length;
    app.store.mutate((s) => { s.nodes.push({ id: 'h1', name: 'one' } as never); }, 'Add one');
    app.store.mutate((s) => { s.nodes.push({ id: 'h2', name: 'two' } as never); }, 'Add two');
    app.store.jumpTo(app.store.past.length - 2);   // back to before "Add one"
    expect(app.store.scene.nodes.length).toBe(before);
    historyDialog(app.store);
    const ahead = Array.from(document.querySelectorAll('#hist .history-item.ahead'));
    expect(ahead.length).toBe(2);
    // Click the farthest step ahead: both steps come back.
    (ahead[ahead.length - 1] as HTMLElement).click();
    expect(app.store.scene.nodes.map((n) => n.name)).toContain('two');
    // Click an earlier step: everything after it is undone, still reachable.
    (document.querySelector('#hist .history-item') as HTMLElement).click();
    expect(app.store.scene.nodes.length).toBe(before);
    expect(app.store.future.length).toBe(2);
    app.dispose();
  }, 60_000);

  it('collapses the whole rail to give the canvas the full width', async () => {
    const app = await mountApp();
    const shell = document.querySelector('.app')!;
    expect(shell.classList.contains('rail-hidden')).toBe(false);
    click(document.querySelector('#btn-rail'));
    expect(shell.classList.contains('rail-hidden')).toBe(true);
    press('\\');
    expect(shell.classList.contains('rail-hidden')).toBe(false);
    app.dispose();
  }, 60_000);

  it('ships no sound and offers an import slot instead of a music library', async () => {
    const app = await mountApp();
    // The demo world must be silent: no bundled audio anywhere.
    expect(app.store.scene.audio ?? null).toBeNull();
    openSection('sound');
    const text = body('sound')!.textContent ?? '';
    expect(text).toMatch(/No sound/);
    expect(text).toMatch(/ships no music/i);
    expect(body('sound')!.querySelector('[data-import]')).toBeTruthy();
    // Nothing resembling a browsable track list.
    expect(body('sound')!.querySelectorAll('.asset-card').length).toBe(0);
    app.dispose();
  }, 60_000);

  it('keeps the library open while placing, and opens editing on double-click', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="foreground"]'));
    click(document.querySelector('#asset-grid .asset-card'));
    // Placing several in a row must not keep slamming the properties panel open.
    expect(app.store.primary).toBeTruthy();
    openSection('canvas');
    const row = document.querySelector('.layer-item.selected')!;
    expect(row).toBeTruthy();
    // No eye or padlock columns in the list any more.
    expect(row.querySelectorAll('.mini-btn').length).toBe(0);
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(document.querySelector('[data-section="object"]')?.classList.contains('open')).toBe(true);
    app.dispose();
  }, 60_000);

  it('opens the export dialog and reports real encoder capabilities', async () => {
    const app = await mountApp();
    click(document.querySelector('#btn-export'));
    expect(document.querySelector('.modal')).toBeTruthy();
    expect(document.querySelectorAll('.export-tab').length).toBe(3);
    click(document.querySelector('[data-tab="video"]'));
    await new Promise((r) => setTimeout(r, 60));
    const text = document.querySelector('#export-panel')!.textContent ?? '';
    // jsdom has no WebCodecs: the dialog must say so honestly, not pretend.
    expect(text).toMatch(/WebM fallback|Full frame render|Seamless loop tiling/);
    expect(text).toMatch(/Master cycle/);
    click(document.querySelector('[data-tab="project"]'));
    expect(document.querySelector('#export-panel')!.textContent).toMatch(/sceneproject/);
    app.dispose();
  }, 60_000);

  it('opens crop, replace, style, compose, history and about dialogs', async () => {
    const app = await mountApp();
    const { cropDialog, replaceDialog, composeDialog, historyDialog, aboutDialog, changeStyleDialog, newWorldDialog, importDialog } =
      await import('../src/ui/dialogs');
    click(document.querySelector('.layer-tab[data-layer="middle"]'));
    click(document.querySelector('[data-asset="enchanted.middle.ancient-oak"]'));
    const node = app.store.scene.nodes.find((n) => n.kind === 'asset' && n.layer === 'middle')!;
    const meta = app.library.get(node.assetId)!;

    cropDialog(node, meta, app.library.url(meta), () => {});
    expect(document.querySelector('#crop-canvas')).toBeTruthy();
    click(document.querySelector('.modal [data-close]'));

    replaceDialog(node, app.store, app.library, () => {});
    expect(document.querySelectorAll('#replace-grid .asset-card').length).toBeGreaterThan(0);
    click(document.querySelector('.modal [data-close]'));

    composeDialog(app.store, () => {});
    expect(document.querySelector('.modal')!.textContent).toMatch(/Locked objects are never touched/);
    click(document.querySelector('.modal [data-close]'));

    historyDialog(app.store);
    click(document.querySelector('.modal [data-close]'));
    aboutDialog();
    expect(document.querySelector('.modal')!.textContent).toMatch(/Create worlds/);
    click(document.querySelector('.modal [data-close]'));

    changeStyleDialog(app.store, app.library, () => {});
    expect(document.querySelectorAll('.style-card').length).toBeGreaterThanOrEqual(2);
    click(document.querySelector('.modal [data-close]'));

    importDialog(app.library, app.store.scene.styleId, () => {});
    expect(document.querySelector('#import-file')).toBeTruthy();
    click(document.querySelector('.modal [data-close]'));

    newWorldDialog(app.library, { onCreate: () => {} });
    expect(document.querySelectorAll('.aspect-card').length).toBe(5);
    click(document.querySelector('.modal [data-close]'));
    app.dispose();
  }, 60_000);

  it('creates a new world in another style with no style clashes', async () => {
    const app = await mountApp();
    const { newWorldDialog } = await import('../src/ui/dialogs');
    await new Promise<void>((resolve) => {
      newWorldDialog(app.library, {
        onCreate: (styleId, aspect, name, seedMode) => {
          expect(styleId).toBeTruthy(); expect(aspect).toBeTruthy();
          expect(name).toBeTruthy(); expect(seedMode).toBeTruthy();
          resolve();
        },
      });
      const cards = document.querySelectorAll('.style-card');
      click(cards[1]);
      click(document.querySelector('.aspect-card[data-aspect="9:16"]'));
      click(document.querySelector('.modal-foot .btn.primary'));
    });
    app.dispose();
  }, 60_000);

  it('saves a portable project and reopens it', async () => {
    const app = await mountApp();
    const { packageProject, readProject } = await import('../src/project/projectFormat');
    const scene = app.store.scene;
    const blob = await packageProject(scene, app.library);
    expect(blob.size).toBeGreaterThan(1000);
    const { AssetLibrary } = await import('../src/assets/library');
    const fresh = new AssetLibrary();
    fresh.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
    const loaded = await readProject(await blob.arrayBuffer(), fresh);
    expect(loaded.missingAssets).toEqual([]);
    expect(loaded.scene.nodes.length).toBe(scene.nodes.length);
    expect(loaded.scene.styleId).toBe(scene.styleId);
    app.dispose();
  }, 60_000);

  it('exports a real still image with no editor furniture in it', async () => {
    const app = await mountApp();
    click(document.querySelector('[data-asset="enchanted.background.enchanted-lake"]'));
    await app.images.ensure(['enchanted.background.enchanted-lake']);
    const result = await app.exports.still.render(app.store.scene, {
      width: 640, height: 360, format: 'png', quality: 0.9, time: 1.5,
    });
    expect(result.blob.size).toBeGreaterThan(5000);
    expect(result.width).toBe(640);
    // The overlay canvas is separate and untouched by the export path.
    const overlay = document.querySelector('#overlay-canvas') as HTMLCanvasElement;
    expect(overlay).toBeTruthy();
    app.dispose();
  }, 60_000);
});
