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

async function mountApp() {
  document.body.innerHTML = '<div id="app"></div><div class="modal-root"></div><div class="toast-root"></div>';
  const { App } = await import('../src/ui/app');
  const app = new App();
  const root = document.getElementById('app')!;
  await app.mount(root);
  // The shell replaces #app contents, so re-add the overlay roots it expects.
  return app;
}

const click = (el: Element | null) => {
  expect(el, 'expected element to exist').toBeTruthy();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

/** Open one accordion section in the right rail (exclusive). */
const openSection = (id: string) => click(document.querySelector(`[data-head="${id}"]`));
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
  it('mounts without errors and opens on a real composed world', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    const app = await mountApp();

    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('#scene-canvas')).toBeTruthy();
    expect(app.store.scene.nodes.length).toBeGreaterThan(10);
    expect(app.library.assets.length).toBeGreaterThan(20);
    expect(app.library.styles.length).toBeGreaterThanOrEqual(2);
    // four layer buttons, always
    expect(document.querySelectorAll('.layer-tab').length).toBe(4);
    // The rail is an exclusive accordion: only the open section has content.
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

  it('solo preview isolates one effect, then one layer, then everything', async () => {
    const app = await mountApp();
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
    const locked = app.store.scene.nodes.filter((n) => n.locked).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    expect(locked.length).toBeGreaterThan(0);
    menuClick('world', 'Rearrange unlocked');
    for (const l of locked) {
      const n = app.store.node(l.id)!;
      expect(n.x).toBe(l.x);
      expect(n.y).toBe(l.y);
    }
    app.dispose();
  }, 60_000);

  it('advances to the middle layer after a background is placed', async () => {
    const app = await mountApp();
    click(document.querySelector('.layer-tab[data-layer="background"]'));
    const cards = Array.from(document.querySelectorAll('#asset-grid .asset-card'));
    expect(cards.length).toBeGreaterThan(0);
    click(cards[0]);
    // Guided flow: a background is placed once, so move straight on to layer 2.
    expect(app.layer).toBe('middle');
    expect(document.querySelector('.layer-tab[data-layer="middle"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelectorAll('#asset-grid .asset-card').length).toBeGreaterThan(0);
    // Going back is always one click.
    click(document.querySelector('.layer-tab[data-layer="background"]'));
    expect(app.layer).toBe('background');
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
