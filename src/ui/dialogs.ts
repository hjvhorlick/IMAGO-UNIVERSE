/** Modal dialogs: new world, style, export, projects, composition, crop, import. */
import type { AssetLibrary } from '../assets/library';
import type { Store } from '../core/store';
import type { AssetMeta, SceneNode } from '../core/types';
import { CANVAS_PRESETS } from '../scene/sceneModel';
import { DEFAULT_COMPOSE } from '../scene/composition';
import { WORLD_CATEGORIES, backgroundFor, listWorlds } from '../scene/worlds';
import type { ComposeOptions } from '../scene/composition';
import { referenceCollection, switchStyle } from '../scene/styleManager';
import { loopManager } from '../animation/loopManager';
import {
  DURATIONS, QUALITY_BITRATE, RESOLUTIONS, dimensionsFor, describeProgress,
} from '../export/exportManager';
import type { ExportManager } from '../export/exportManager';
import type { Capabilities, ExportProgress } from '../render/videoRenderer';
import type { ProjectShelf } from '../project/projectShelf';
import { formatBytes, clamp, downloadBlob } from '../core/util';
import { el, escapeHtml, icon, numberField, on, qs, qsa, rangeField, selectField, toggleField } from './dom';

/* ---------------------------------------------------------------- modal */

export interface ModalHandle { close: () => void; body: HTMLElement; root: HTMLElement }

export function openModal(opts: {
  title: string; subtitle?: string; size?: 'narrow' | 'wide' | '';
  body: HTMLElement; actions?: HTMLElement[]; onClose?: () => void; dismissable?: boolean;
}): ModalHandle {
  const root = qs<HTMLElement>('.modal-root')!;
  root.innerHTML = '';
  root.classList.add('open');
  const backdrop = el(`<div class="modal-backdrop"></div>`);
  const modal = el<HTMLElement>(`<div class="modal ${opts.size ?? ''}">
    <div class="modal-head">
      <div style="flex:1">
        <div class="modal-title">${escapeHtml(opts.title)}</div>
        ${opts.subtitle ? `<div class="modal-sub">${escapeHtml(opts.subtitle)}</div>` : ''}
      </div>
      <button class="btn icon ghost" data-close aria-label="Close">${icon('close', 15)}</button>
    </div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>
  </div>`);
  const body = qs<HTMLElement>('.modal-body', modal)!;
  body.appendChild(opts.body);
  const foot = qs<HTMLElement>('.modal-foot', modal)!;
  (opts.actions ?? []).forEach((a) => foot.appendChild(a));
  if (!opts.actions?.length) foot.remove();
  root.append(backdrop, modal);

  const close = () => {
    root.classList.remove('open');
    root.innerHTML = '';
    document.removeEventListener('keydown', esc);
    opts.onClose?.();
  };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && opts.dismissable !== false) close(); };
  document.addEventListener('keydown', esc);
  on(qs('[data-close]', modal), 'click', close);
  if (opts.dismissable !== false) on(backdrop, 'click', close);
  return { close, body, root: modal };
}

export function button(label: string, cls: string, fn: () => void, ic?: string): HTMLButtonElement {
  const b = el<HTMLButtonElement>(`<button class="btn ${cls}">${ic ? icon(ic, 13) : ''}${escapeHtml(label)}</button>`);
  on(b, 'click', fn);
  return b;
}

/* ------------------------------------------------------------ new world */

export type StartingPoint = 'background' | 'composed' | 'demo';

/**
 * Choose a world, then a look, then a canvas. A world starts with its background
 * only; the rest is up to the designer. The starting-point choice exists for
 * anyone who wants a pre-filled sketch instead.
 */
export function newWorldDialog(library: AssetLibrary, opts: {
  onCreate: (worldId: string, styleId: string, aspect: string, name: string, start: StartingPoint) => void;
  currentStyle?: string;
  title?: string;
  subtitle?: string;
  dismissable?: boolean;
}): ModalHandle {
  const worlds = listWorlds(library);
  const worldOf = (id: string) => worlds.find((w) => w.id === id);
  let worldId = worlds[0]?.id ?? '';
  const preferredLook = opts.currentStyle ?? library.styles[0]?.id ?? 'enchanted';
  let styleId = worldOf(worldId)?.looks.includes(preferredLook)
    ? preferredLook : (worldOf(worldId)?.looks[0] ?? preferredLook);
  let aspect = '16:9';
  let start: StartingPoint = 'background';
  let name = 'Untitled world';

  const body = el(`<div>
    <div class="welcome-hero">
      <div class="welcome-title">IMAGO UNIVERSE</div>
      <div class="welcome-tag">Create worlds. Bring them to life.</div>
      <div class="welcome-desc">Pick the place first. A world starts with its background and nothing else;
        you add trees, rocks, flowers and effects yourself, and as many of each as you like.</div>
    </div>
    <div class="section-title" style="margin-top:6px">1 - World</div>
    <div id="world-cats"></div>
    <div class="section-title" style="margin-top:14px">2 - Look</div>
    <div class="look-chips" id="look-chips"></div>
    <div class="section-title" style="margin-top:20px">3 - Canvas</div>
    <div class="aspect-grid" id="aspect-grid"></div>
    <div class="section-title" style="margin-top:20px">4 - Starting point</div>
    <div class="segmented" id="seed-seg">
      <button data-seed="background" class="active">Background only</button>
      <button data-seed="composed">Background + auto-composed objects</button>
      <button data-seed="demo">Demo with effects</button>
    </div>
    <div class="field" style="margin-top:16px">
      <div class="field-label"><span>Project name</span></div>
      <input type="text" id="world-name" value="Untitled world">
    </div>
  </div>`);

  const catHost = qs<HTMLElement>('#world-cats', body)!;
  const lookHost = qs<HTMLElement>('#look-chips', body)!;

  const bgThumb = (id: string, look: string) => {
    const meta = backgroundFor(library, id, look);
    return meta ? `<img src="${library.url(meta, true)}" alt="">` : '';
  };

  const paintLooks = () => {
    lookHost.innerHTML = '';
    const world = worldOf(worldId);
    for (const look of world?.looks ?? []) {
      const label = library.style(look)?.name ?? look;
      const chip = el<HTMLElement>(`<button class="chip${look === styleId ? ' active' : ''}" data-look="${look}">${escapeHtml(label)}</button>`);
      on(chip, 'click', () => { styleId = look; paintWorlds(); paintLooks(); });
      lookHost.appendChild(chip);
    }
  };

  const paintWorlds = () => {
    catHost.innerHTML = '';
    const categories = [...WORLD_CATEGORIES];
    const other = worlds.filter((w) => w.categoryId === 'other');
    if (other.length) categories.push({ id: 'other', name: 'Other', worlds: other.map((w) => w.id) });
    for (const cat of categories) {
      const inCat = worlds.filter((w) => w.categoryId === cat.id);
      const head = el<HTMLElement>(`<div class="world-cat-head">${escapeHtml(cat.name)}
        <span class="field-value">${inCat.length} ${inCat.length === 1 ? 'world' : 'worlds'}</span></div>`);
      catHost.appendChild(head);
      if (!inCat.length) {
        catHost.appendChild(el(`<div class="field-hint" style="margin:0 0 12px">${escapeHtml(
          WORLD_CATEGORIES.find((c) => c.id === cat.id)?.note ?? 'No worlds in this category yet.')}</div>`));
        continue;
      }
      const grid = el<HTMLElement>(`<div class="style-grid world-grid"></div>`);
      for (const w of inCat) {
        const look = w.looks.includes(styleId) ? styleId : w.looks[0];
        const card = el<HTMLElement>(`<button class="style-card world-card${w.id === worldId ? ' selected' : ''}" data-world="${w.id}">
          <div class="world-thumb">${bgThumb(w.id, look)}</div>
          <div class="style-info">
            <div class="style-name">${escapeHtml(w.name)}</div>
            <div class="field-hint" style="margin-top:4px">${w.looks.length} ${w.looks.length === 1 ? 'look' : 'looks'}</div>
          </div>
        </button>`);
        on(card, 'click', () => {
          worldId = w.id;
          if (!w.looks.includes(styleId)) styleId = w.looks[0];
          paintWorlds(); paintLooks();
        });
        grid.appendChild(card);
      }
      catHost.appendChild(grid);
    }
  };
  paintWorlds();
  paintLooks();

  const ag = qs<HTMLElement>('#aspect-grid', body)!;
  const paintAspects = () => {
    ag.innerHTML = '';
    for (const [key, p] of Object.entries(CANVAS_PRESETS)) {
      const [aw, ah] = key.split(':').map(Number);
      const boxW = 34, boxH = 34;
      const w = aw >= ah ? boxW : boxW * (aw / ah);
      const h = ah >= aw ? boxH : boxH * (ah / aw);
      const card = el<HTMLElement>(`<button class="aspect-card${key === aspect ? ' selected' : ''}" data-aspect="${key}">
        <div class="aspect-box" style="width:${w}px;height:${h}px"></div>
        <div class="aspect-label">${key}</div>
        <div class="field-value">${p.w}x${p.h}</div>
      </button>`);
      on(card, 'click', () => { aspect = key; paintAspects(); });
      ag.appendChild(card);
    }
  };
  paintAspects();

  qsa<HTMLElement>('[data-seed]', body).forEach((b) => on(b, 'click', () => {
    start = b.dataset.seed as StartingPoint;
    qsa<HTMLElement>('[data-seed]', body).forEach((x) => x.classList.toggle('active', x === b));
  }));
  on(qs<HTMLInputElement>('#world-name', body)!, 'input', (e) => { name = (e.target as HTMLInputElement).value; });

  const create = button('Create world', 'primary', () => {
    if (!worldId) return;
    opts.onCreate(worldId, styleId, aspect, name.trim() || 'Untitled world', start);
    handle.close();
  }, 'wand');
  const handle = openModal({
    title: opts.title ?? 'Choose a world',
    subtitle: opts.subtitle ?? 'Everything stays editable - nothing is ever flattened.',
    size: 'wide', body, dismissable: opts.dismissable,
    actions: [
      ...(opts.dismissable === false ? [] : [button('Cancel', 'ghost', () => handle.close())]),
      create,
    ],
  });
  return handle;
}

/* --------------------------------------------------------- change style */

export function changeStyleDialog(store: Store, library: AssetLibrary, onDone: () => void) {
  let style = store.scene.styleId;
  const body = el(`<div>
    <div class="info-box">Changing style swaps the artwork in layers 1-3 for matching pieces from the
      new collection and keeps every transform, animation and atmospheric effect. Objects with no
      counterpart in the new style are removed rather than left as a style clash.</div>
    <div class="style-grid" id="style-grid"></div>
  </div>`);
  const grid = qs<HTMLElement>('#style-grid', body)!;
  const paint = () => {
    grid.innerHTML = '';
    for (const s of library.styles) {
      const refs = referenceCollection(library, s);
      const card = el<HTMLElement>(`<button class="style-card${s.id === style ? ' selected' : ''}">
        <div class="style-ref">
          ${refs[0] ? `<img src="${library.url(refs[0], true)}" alt="">` : '<div class="ref-cell"></div>'}
          ${refs.slice(1, 5).map((r) => `<div class="ref-cell"><img src="${library.url(r, true)}" alt=""></div>`).join('')}
        </div>
        <div class="style-info">
          <div class="style-sub">${escapeHtml(s.subtitle)}</div>
          <div class="style-name">${escapeHtml(s.name)}</div>
          <div class="style-desc">${escapeHtml(s.description)}</div>
        </div>
      </button>`);
      on(card, 'click', () => { style = s.id; paint(); });
      grid.appendChild(card);
    }
  };
  paint();
  const handle = openModal({
    title: 'Artistic style', size: 'wide', body,
    actions: [
      button('Cancel', 'ghost', () => handle.close()),
      button('Apply style', 'primary', () => {
        store.pushHistory('Change artistic style');
        const report = switchStyle(store.scene, library, style);
        store.mutate(() => {});
        store.status(
          `Style set to ${report.style?.name ?? style}: ${report.swapped} objects swapped, `
          + `${report.keptEffects} effects kept${report.removed.length ? `, ${report.removed.length} removed` : ''}.`,
          report.removed.length ? 'warn' : 'success',
        );
        onDone();
        handle.close();
      }, 'check'),
    ],
  });
}

/* ------------------------------------------------------------ composition */

export function composeDialog(store: Store, onRun: (opts: ComposeOptions) => void) {
  const o: ComposeOptions = { ...DEFAULT_COMPOSE, seed: Math.floor(Math.random() * 1e6) };
  const body = el(`<div>
    <div class="info-box">The composer only uses artwork from the current style, grounds every object
      on its depth line, scales distant objects smaller, and lets foreground plants run off the canvas.
      <b>Locked objects are never touched.</b></div>
    <div id="compose-fields"></div>
  </div>`);
  const f = qs<HTMLElement>('#compose-fields', body)!;
  f.appendChild(selectField('Density', o.density, [
    { value: 'sparse', label: 'Sparse - open and calm' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'lush', label: 'Lush - dense vegetation' },
  ], (v) => { o.density = v as ComposeOptions['density']; }));
  f.appendChild(rangeField({
    label: 'Foreground amount', value: o.foreground, min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { o.foreground = v; },
  }));
  f.appendChild(rangeField({
    label: 'Position variation', value: o.jitterPosition, min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { o.jitterPosition = v; },
  }));
  f.appendChild(rangeField({
    label: 'Size variation', value: o.jitterSize, min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { o.jitterSize = v; },
  }));
  f.appendChild(rangeField({
    label: 'Rotation variation', value: o.jitterRotation, min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { o.jitterRotation = v; },
  }));
  f.appendChild(toggleField('Include structures', o.structures, (v) => { o.structures = v; }));
  f.appendChild(toggleField('Include water features (when the background has water)', o.water, (v) => { o.water = v; }));
  f.appendChild(toggleField('Choose a background if none is locked', o.setBackground, (v) => { o.setBackground = v; }));
  f.appendChild(toggleField('Suggest lighting to match the background', o.suggestLighting, (v) => { o.suggestLighting = v; }));
  f.appendChild(toggleField('Replace unlocked objects', o.replaceUnlocked, (v) => { o.replaceUnlocked = v; },
    'Off keeps everything already placed and only adds new pieces.'));
  const locked = store.scene.nodes.filter((n) => n.locked).length;
  f.appendChild(el(`<div class="field-hint">${locked} locked object${locked === 1 ? '' : 's'} will be preserved exactly.</div>`));

  const handle = openModal({
    title: 'Automatic composition', size: '', body,
    actions: [
      button('Cancel', 'ghost', () => handle.close()),
      button('Compose', 'primary', () => { onRun(o); handle.close(); }, 'wand'),
    ],
  });
}

/* ------------------------------------------------------------------ crop */

export function cropDialog(
  node: SceneNode, meta: AssetMeta, imageUrl: string,
  onApply: (crop: { x: number; y: number; w: number; h: number }) => void,
) {
  const crop = { ...node.crop };
  const body = el(`<div>
    <div class="info-box"><b>Image cropping.</b> Choose which part of the artwork is visible.
      This is different from canvas cropping, which simply lets an oversized object run past the
      canvas edge. The original file is never modified - only this rectangle is stored.</div>
    <div class="crop-stage"><canvas id="crop-canvas"></canvas></div>
    <div class="grid-4" style="margin-top:12px" id="crop-nums"></div>
  </div>`);
  const canvas = qs<HTMLCanvasElement>('#crop-canvas', body)!;
  const ctx = canvas.getContext('2d')!;
  const img = new Image();
  let scale = 1;
  let drag: { mode: string; sx: number; sy: number; start: typeof crop } | null = null;

  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.28;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    const x = crop.x * canvas.width, y = crop.y * canvas.height;
    const w = crop.w * canvas.width, h = crop.h * canvas.height;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.strokeStyle = '#5eead4'; ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#0b1017';
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      ctx.fillRect(hx - 5, hy - 5, 10, 10);
      ctx.strokeRect(hx - 5, hy - 5, 10, 10);
    }
    ctx.strokeStyle = 'rgba(94,234,212,0.28)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3); ctx.stroke();
    }
  };

  const nums = qs<HTMLElement>('#crop-nums', body)!;
  const refreshNums = () => {
    nums.innerHTML = '';
    (['x', 'y', 'w', 'h'] as const).forEach((k) => {
      nums.appendChild(numberField(k.toUpperCase(), Math.round(crop[k] * 1000) / 1000, (v) => {
        crop[k] = clamp(v, 0.01, 1);
        crop.w = Math.min(crop.w, 1 - crop.x);
        crop.h = Math.min(crop.h, 1 - crop.y);
        draw();
      }, { step: 0.01, min: 0.01, max: 1 }));
    });
  };

  img.onload = () => {
    const maxW = 780, maxH = 460;
    scale = Math.min(maxW / img.width, maxH / img.height, 1);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    draw(); refreshNums();
  };
  img.src = imageUrl;

  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  on(canvas, 'pointerdown', (e) => {
    const p = local(e as PointerEvent);
    const tol = 0.03;
    const corners: [string, number, number][] = [
      ['nw', crop.x, crop.y], ['ne', crop.x + crop.w, crop.y],
      ['sw', crop.x, crop.y + crop.h], ['se', crop.x + crop.w, crop.y + crop.h],
    ];
    let mode = 'move';
    for (const [id, cx, cy] of corners) if (Math.hypot(p.x - cx, p.y - cy) < tol) mode = id;
    if (mode === 'move' && (p.x < crop.x || p.x > crop.x + crop.w || p.y < crop.y || p.y > crop.y + crop.h)) {
      mode = 'new';
      crop.x = p.x; crop.y = p.y; crop.w = 0.02; crop.h = 0.02;
    }
    drag = { mode, sx: p.x, sy: p.y, start: { ...crop } };
    canvas.setPointerCapture((e as PointerEvent).pointerId);
  });
  on(canvas, 'pointermove', (e) => {
    if (!drag) return;
    const p = local(e as PointerEvent);
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    const s = drag.start;
    if (drag.mode === 'move') {
      crop.x = clamp(s.x + dx, 0, 1 - s.w);
      crop.y = clamp(s.y + dy, 0, 1 - s.h);
    } else {
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (drag.mode.includes('w') || drag.mode === 'new') x0 = clamp(s.x + dx, 0, x1 - 0.02);
      if (drag.mode.includes('e') || drag.mode === 'new') x1 = clamp(s.x + s.w + dx, x0 + 0.02, 1);
      if (drag.mode.includes('n') && drag.mode !== 'new') y0 = clamp(s.y + dy, 0, y1 - 0.02);
      if (drag.mode.includes('s') || drag.mode === 'new') y1 = clamp(s.y + s.h + dy, y0 + 0.02, 1);
      if (drag.mode === 'new') { x1 = clamp(p.x, x0 + 0.02, 1); y1 = clamp(p.y, y0 + 0.02, 1); }
      crop.x = x0; crop.y = y0; crop.w = x1 - x0; crop.h = y1 - y0;
    }
    draw();
  });
  on(canvas, 'pointerup', () => { drag = null; refreshNums(); });

  const handle = openModal({
    title: `Crop - ${meta.name}`, subtitle: 'Non-destructive: stored as a rectangle in the project.',
    size: 'wide', body,
    actions: [
      button('Reset to full image', 'ghost', () => { crop.x = 0; crop.y = 0; crop.w = 1; crop.h = 1; draw(); refreshNums(); }),
      button('Cancel', 'ghost', () => handle.close()),
      button('Apply crop', 'primary', () => { onApply({ ...crop }); handle.close(); }, 'crop'),
    ],
  });
}

/* --------------------------------------------------------------- replace */

export function replaceDialog(node: SceneNode, store: Store, library: AssetLibrary, onPick: (meta: AssetMeta) => void) {
  const current = library.get(node.assetId);
  const list = library.forStyle(store.scene.styleId, node.layer);
  const body = el(`<div>
    <div class="info-box">Replacing keeps position, size, rotation, colour, animation and layer order.
      Only artwork from <b>${escapeHtml(library.style(store.scene.styleId)?.name ?? '')}</b> is offered.</div>
    <div class="asset-grid" style="grid-template-columns:repeat(4,1fr)" id="replace-grid"></div>
  </div>`);
  const grid = qs<HTMLElement>('#replace-grid', body)!;
  for (const meta of list) {
    const card = el<HTMLElement>(`<div class="asset-card${meta.id === current?.id ? ' selected' : ''}" style="${meta.id === current?.id ? 'border-color:var(--accent)' : ''}">
      <div class="asset-thumb${meta.layer === 'background' ? ' bg' : ''}"><img src="${library.url(meta, true)}" alt=""></div>
      <div class="asset-label">${escapeHtml(meta.name)}</div>
    </div>`);
    on(card, 'click', () => { onPick(meta); handle.close(); });
    grid.appendChild(card);
  }
  const handle = openModal({ title: 'Replace artwork', size: 'wide', body });
}

/* ---------------------------------------------------------------- import */

export function importDialog(library: AssetLibrary, currentStyle: string, onDone: (meta: AssetMeta) => void) {
  let file: File | null = null;
  let layer: 'background' | 'middle' | 'foreground' = 'middle';
  let style = currentStyle;
  let category = 'imported';
  let name = '';
  const body = el(`<div>
    <div class="info-box">Imported artwork is stored locally and embedded inside every project that uses it,
      so your files stay portable. PNG or WebP with transparency works best for objects; JPEG is fine for backgrounds.</div>
    <div class="field">
      <div class="field-label"><span>Image file</span></div>
      <input type="file" accept="image/png,image/webp,image/jpeg" id="import-file">
    </div>
    <div id="import-fields"></div>
    <div class="field-hint">Tip: for grass and plants, make sure the base of the plant touches the bottom
      edge of the image so it grounds correctly.</div>
  </div>`);
  const f = qs<HTMLElement>('#import-fields', body)!;
  const paint = () => {
    f.innerHTML = '';
    f.appendChild(el(`<div class="field"><div class="field-label"><span>Display name</span></div>
      <input type="text" id="import-name" value="${escapeHtml(name)}"></div>`));
    on(qs<HTMLInputElement>('#import-name', f)!, 'input', (e) => { name = (e.target as HTMLInputElement).value; });
    f.appendChild(selectField('Layer', layer, [
      { value: 'background', label: '1 - Background' },
      { value: 'middle', label: '2 - Middle-ground' },
      { value: 'foreground', label: '3 - Foreground' },
    ], (v) => { layer = v as typeof layer; }));
    f.appendChild(selectField('Artistic style', style,
      library.styles.map((s) => ({ value: s.id, label: s.name })),
      (v) => { style = v; },
      'The asset will only appear in scenes using this style.'));
    f.appendChild(selectField('Category', category,
      ['trees', 'structures', 'rocks', 'water', 'grass', 'flowers', 'plants', 'ground', 'nature', 'imported']
        .map((c) => ({ value: c, label: c })),
      (v) => { category = v; }));
  };
  paint();
  on(qs<HTMLInputElement>('#import-file', body)!, 'change', (e) => {
    const input = e.target as HTMLInputElement;
    file = input.files?.[0] ?? null;
    if (file && !name) { name = file.name.replace(/\.[^.]+$/, ''); paint(); }
  });

  const handle = openModal({
    title: 'Import artwork', body,
    actions: [
      button('Cancel', 'ghost', () => handle.close()),
      button('Import', 'primary', async () => {
        if (!file) { return; }
        try {
          const meta = await library.importFile(file, { name: name || file.name, layer, style, category });
          onDone(meta);
          handle.close();
        } catch (err) {
          const box = el(`<div class="info-box error">${escapeHtml((err as Error).message)}</div>`);
          body.prepend(box);
        }
      }, 'upload'),
    ],
  });
}

/* --------------------------------------------------------------- projects */

export function projectsDialog(shelf: ProjectShelf, opts: {
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenFile: () => void;
  onSaveNow: () => void;
}) {
  const body = el(`<div>
    <div class="info-box">Projects are stored in this browser for convenience. The
      <b>.sceneproject</b> file you save to disk is the portable copy - it contains the artwork too.</div>
    <div class="row" style="margin-bottom:14px">
      <button class="btn small" data-open-file>${icon('folder', 12)} Open .sceneproject file</button>
      <button class="btn small" data-save-now>${icon('save', 12)} Save current to shelf</button>
    </div>
    <div id="project-list"><div class="empty-state">Loading...</div></div>
  </div>`);
  on(qs('[data-open-file]', body), 'click', () => { handle.close(); opts.onOpenFile(); });
  on(qs('[data-save-now]', body), 'click', () => { opts.onSaveNow(); });
  const list = qs<HTMLElement>('#project-list', body)!;
  const refresh = async () => {
    const items = await shelf.list();
    if (!items.length) {
      list.innerHTML = `<div class="empty-state"><strong>No saved projects yet</strong>
        Use Save to keep this world in the browser, or Save As to write a .sceneproject file.</div>`;
      return;
    }
    list.innerHTML = '';
    for (const p of items) {
      const card = el<HTMLElement>(`<div class="project-card">
        ${p.preview ? `<img src="${p.preview}" alt="">` : '<img alt="">'}
        <div class="project-card-info">
          <div class="project-card-name">${escapeHtml(p.name)}</div>
          <div class="project-card-meta">${escapeHtml(p.styleId)} - ${p.objectCount} objects - ${new Date(p.updatedAt).toLocaleString()}</div>
        </div>
        <button class="btn small" data-open>Open</button>
        <button class="btn small danger" data-del>${icon('trash', 12)}</button>
      </div>`);
      on(qs('[data-open]', card), 'click', () => { opts.onOpen(p.id); handle.close(); });
      on(qs('[data-del]', card), 'click', async () => { await opts.onDelete(p.id); void refresh(); });
      list.appendChild(card);
    }
  };
  const handle = openModal({ title: 'Projects', size: '', body });
  void refresh();
}

/* ---------------------------------------------------------------- history */

export function historyDialog(store: Store) {
  const body = el(`<div><div class="info-box">Every step is kept. Click any step to go to it - earlier or
    later. Steps ahead stay available until you make a new change.</div><div id="hist"></div></div>`);
  const host = qs<HTMLElement>('#hist', body)!;
  const paint = () => {
    host.innerHTML = '';
    if (!store.past.length && !store.future.length) {
      host.appendChild(el(`<div class="empty-state">No history yet.</div>`));
    }
    // Earlier steps, oldest first.
    store.past.forEach((h, i) => {
      const item = el<HTMLElement>(`<div class="history-item"><span class="history-index">${i + 1}</span>${escapeHtml(h.label)}</div>`);
      on(item, 'click', () => { store.jumpTo(i); paint(); });
      host.appendChild(item);
    });
    host.appendChild(el<HTMLElement>(`<div class="history-item current"><span class="history-index">${store.past.length + 1}</span>Current state</div>`));
    // Later steps, nearest first. future[last] is the nearest; future[0] the farthest.
    const ahead = store.future.length;
    for (let idx = ahead - 1; idx >= 0; idx--) {
      const distance = ahead - idx;               // redo presses needed to get there
      const h = store.future[idx];
      const item = el<HTMLElement>(`<div class="history-item ahead"><span class="history-index">${store.past.length + 1 + distance}</span>${escapeHtml(h.label)}<span class="history-tag">redo</span></div>`);
      on(item, 'click', () => { store.goForward(distance); paint(); });
      host.appendChild(item);
    }
  };
  paint();
  openModal({ title: 'History', body });
}

/* ----------------------------------------------------------------- export */

export function exportDialog(
  store: Store, manager: ExportManager, shelf: ProjectShelf,
  getPreview: () => Promise<Blob | undefined>,
  getTime: () => number,
) {
  const scene = store.scene;
  const ex = scene.exportSettings;
  let tab: 'still' | 'video' | 'project' = 'still';
  let caps: Capabilities | null = null;
  let running = false;
  let directToFile = false;
  let lastProgress: ExportProgress | null = null;

  const body = el(`<div>
    <div class="export-tabs">
      <button class="export-tab active" data-tab="still">
        <div class="export-tab-title">${icon('image', 13)} Still image</div>
        <div class="export-tab-desc">PNG, JPEG or WebP. Scene only - no editor controls.</div>
      </button>
      <button class="export-tab" data-tab="video">
        <div class="export-tab-title">${icon('film', 13)} Looping video</div>
        <div class="export-tab-desc">H.264 MP4 where supported, WebM fallback.</div>
      </button>
      <button class="export-tab" data-tab="project">
        <div class="export-tab-title">${icon('file', 13)} Editable project</div>
        <div class="export-tab-desc">.sceneproject - keeps every layer editable.</div>
      </button>
    </div>
    <div id="export-panel"></div>
  </div>`);

  const panel = qs<HTMLElement>('#export-panel', body)!;
  const actions = [
    button('Close', 'ghost', () => { if (!running) handle.close(); }),
    button('Export', 'primary', () => { void run(); }, 'download'),
  ];
  const runBtn = actions[1];

  const handle = openModal({
    title: 'Export', subtitle: 'Exporting never changes or flattens your editable project.',
    size: 'wide', body, actions, dismissable: true,
    onClose: () => { if (running) manager.cancel(); },
  });

  qsa<HTMLElement>('[data-tab]', body).forEach((b) => on(b, 'click', () => {
    if (running) return;
    tab = b.dataset.tab as typeof tab;
    qsa<HTMLElement>('[data-tab]', body).forEach((x) => x.classList.toggle('active', x === b));
    void paint();
  }));

  const baseName = () => (scene.name || 'imago-world').trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'imago-world';

  async function paint() {
    panel.innerHTML = '';
    runBtn.textContent = tab === 'project' ? 'Save project file' : tab === 'still' ? 'Export image' : 'Render video';
    runBtn.disabled = false;
    if (tab === 'still') paintStill();
    else if (tab === 'video') await paintVideo();
    else paintProject();
  }

  function paintStill() {
    const wrap = el(`<div></div>`);
    const dims = dimensionsFor(scene, ex.resolution);
    wrap.appendChild(el(`<div class="stat-grid">
      <div class="stat"><div class="stat-label">Output</div><div class="stat-value">${dims.width}x${dims.height}</div></div>
      <div class="stat"><div class="stat-label">Megapixels</div><div class="stat-value">${((dims.width * dims.height) / 1e6).toFixed(1)}</div></div>
      <div class="stat"><div class="stat-label">Frame time</div><div class="stat-value">${getTime().toFixed(2)}s</div></div>
    </div>`));
    wrap.appendChild(selectField('Resolution', String(ex.resolution),
      RESOLUTIONS.map((r) => ({ value: String(r.height), label: `${r.label} (${dimensionsFor(scene, r.height).width}x${dimensionsFor(scene, r.height).height})` })),
      (v) => { ex.resolution = Number(v); void paint(); }, 'Aspect ratio follows the canvas.'));
    wrap.appendChild(selectField('Format', ex.stillFormat, [
      { value: 'png', label: 'PNG - lossless, supports transparency' },
      { value: 'jpeg', label: 'JPEG - smaller, no transparency' },
      { value: 'webp', label: 'WebP - small, high quality' },
    ], (v) => { ex.stillFormat = v as typeof ex.stillFormat; void paint(); }));
    if (ex.stillFormat !== 'png') {
      wrap.appendChild(rangeField({
        label: 'Quality', value: ex.stillQuality, min: 0.5, max: 1, step: 0.01,
        format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { ex.stillQuality = v; },
      }));
    }
    wrap.appendChild(el(`<div class="info-box">The image is rendered from the scene at the current preview time
      (${getTime().toFixed(2)}s) with full export detail. Selection handles, guides and panels are on a separate
      canvas and can never appear in the file.</div>`));
    panel.appendChild(wrap);
  }

  async function paintVideo() {
    const wrap = el(`<div></div>`);
    const dims = dimensionsFor(scene, ex.resolution);
    const bitrate = QUALITY_BITRATE[ex.quality] ?? ex.bitrate;
    ex.bitrate = bitrate;
    caps = await manager.capabilities(dims.width, dims.height, ex.fps, bitrate);
    const plan = manager.video.plan(scene, { ...ex, ...dims, duration: ex.duration, bitrate });
    const estimated = (bitrate / 8) * ex.duration;

    wrap.appendChild(el(`<div class="stat-grid">
      <div class="stat"><div class="stat-label">Output</div><div class="stat-value">${dims.width}x${dims.height}</div></div>
      <div class="stat"><div class="stat-label">Duration</div><div class="stat-value">${ex.duration >= 60 ? `${(ex.duration / 60).toFixed(ex.duration % 60 ? 1 : 0)} min` : `${ex.duration}s`}</div></div>
      <div class="stat"><div class="stat-label">Total frames</div><div class="stat-value">${plan.totalFrames.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">Frames to render</div><div class="stat-value" style="color:var(--accent)">${plan.framesToRender.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">Master cycle</div><div class="stat-value">${plan.report.master}s</div></div>
      <div class="stat"><div class="stat-label">Est. file size</div><div class="stat-value">${formatBytes(estimated)}</div></div>
    </div>`));

    const method = caps.h264 ? (plan.canTile ? 'tile' : 'full') : 'fallback';
    wrap.appendChild(el(`<div class="info-box${method === 'fallback' ? ' warn' : ''}">
      <b>${method === 'tile' ? 'Seamless loop tiling' : method === 'full' ? 'Full frame render' : 'WebM fallback'}</b><br>
      ${method === 'tile'
        ? `This scene returns to its exact starting state every ${plan.report.master}s. Imago encodes
           ${plan.cycleFrames} frames once and repeats those identical encoded samples
           ${plan.repeats} time${plan.repeats === 1 ? '' : 's'}${plan.remainder ? ` plus a ${plan.remainder}-frame tail` : ''}.
           The loop is bit-exact, and an hour of video costs one cycle of rendering.`
        : method === 'full'
          ? `Every frame is rendered individually (${plan.totalFrames.toLocaleString()} frames) because
             ${plan.windowed ? 'some animations have start/stop windows' : 'the cycle lengths could not be harmonised exactly'}.
             Output is still streamed to disk, so memory stays flat.`
          : `This browser cannot encode H.264. The video will be recorded as WebM in real time, so it takes
             about as long as the video itself. MP4 export needs a browser with WebCodecs H.264 support
             (recent Chrome, Edge or Safari).`}
      ${caps.notes.length ? `<ul>${caps.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    </div>`));

    const grid = el(`<div class="grid-2"></div>`);
    const left = el(`<div></div>`);
    const right = el(`<div></div>`);
    left.appendChild(selectField('Resolution', String(ex.resolution),
      RESOLUTIONS.map((r) => ({ value: String(r.height), label: `${r.label} (${dimensionsFor(scene, r.height).width}x${dimensionsFor(scene, r.height).height})` })),
      (v) => { ex.resolution = Number(v); void paint(); },
      '4K depends on your device and encoder; Imago checks support before rendering.'));
    left.appendChild(selectField('Frame rate', String(ex.fps),
      [24, 30, 60].map((f) => ({ value: String(f), label: `${f} fps` })),
      (v) => { ex.fps = Number(v); void paint(); }));
    left.appendChild(selectField('Container', ex.format, [
      { value: 'mp4', label: 'MP4 / H.264 - editors, YouTube, social' },
      { value: 'webm', label: 'WebM - real-time fallback' },
    ], (v) => { ex.format = v as typeof ex.format; void paint(); }));
    right.appendChild(selectField('Duration', String(ex.duration),
      DURATIONS.map((d) => ({ value: String(d.value), label: d.label })).concat([{ value: 'custom', label: 'Custom...' }]),
      (v) => {
        if (v === 'custom') {
          const val = window.prompt('Video duration in seconds', String(ex.duration));
          const n = Number(val);
          if (Number.isFinite(n) && n > 0) ex.duration = clamp(Math.round(n), 1, 7200);
        } else ex.duration = Number(v);
        void paint();
      }, 'Independent of the animation cycle - the loop repeats to fill it.'));
    right.appendChild(selectField('Quality', ex.quality, [
      { value: 'draft', label: 'Draft - 3 Mbps' },
      { value: 'standard', label: 'Standard - 8 Mbps' },
      { value: 'high', label: 'High - 16 Mbps' },
      { value: 'master', label: 'Master - 32 Mbps' },
    ], (v) => { ex.quality = v as typeof ex.quality; void paint(); }));
    right.appendChild(rangeField({
      label: 'Bitrate', value: bitrate / 1e6, min: 1, max: 60, step: 0.5, unit: ' Mbps',
      onInput: (v) => { ex.bitrate = Math.round(v * 1e6); },
      onCommit: () => { void paint(); },
    }));
    grid.append(left, right);
    wrap.appendChild(grid);

    if (caps.filePicker) {
      wrap.appendChild(toggleField('Write straight to a file I choose', directToFile,
        (v) => { directToFile = v; },
        'Streams the video directly to a location on your disk. Recommended for very long exports - it does not use browser storage at all.'));
    } else {
      wrap.appendChild(el(`<div class="field-hint" style="margin-bottom:10px">
        This browser cannot write directly to a chosen file, so the video is streamed into browser
        storage and then downloaded. Very long exports may hit the storage quota.</div>`));
    }

    if (plan.report.animated === 0) {
      wrap.appendChild(el(`<div class="info-box warn">No animations are enabled, so this will be a static video.
        Select an object and use the Animate tab, or add atmospheric effects.</div>`));
    }
    wrap.appendChild(el(`<div id="video-progress"></div>`));
    panel.appendChild(wrap);
  }

  function paintProject() {
    const report = loopManager.analyse(scene);
    panel.appendChild(el(`<div>
      <div class="info-box"><b>.sceneproject</b> is a complete editable project, not a picture.
        It contains the full scene graph plus every piece of artwork it uses, so it opens correctly
        on another machine with no missing files.</div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Objects</div><div class="stat-value">${scene.nodes.length}</div></div>
        <div class="stat"><div class="stat-label">Effects</div><div class="stat-value">${scene.nodes.filter((n) => n.kind === 'effect').length}</div></div>
        <div class="stat"><div class="stat-label">Animated</div><div class="stat-value">${report.animated}</div></div>
        <div class="stat"><div class="stat-label">Style</div><div class="stat-value" style="font-size:11px">${escapeHtml(scene.styleId)}</div></div>
      </div>
      <div class="field-hint">Included: canvas settings, artistic style, every asset reference and its bytes,
        positions, sizes, rotations, crops, opacity, layer order, lighting, colour adjustments, animation
        settings, loop lengths, atmospheric effects, export settings and project metadata.</div>
      <div class="field-hint" style="margin-top:10px">Use <b>Save As</b> in the toolbar to create a variation
        without overwriting the original file.</div>
    </div>`));
  }

  function showProgress(p: ExportProgress) {
    lastProgress = p;
    let host = qs<HTMLElement>('#video-progress', panel);
    if (!host) {
      host = el(`<div id="video-progress"></div>`);
      panel.appendChild(host);
    }
    host.innerHTML = `<div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill" style="width:${Math.round(p.progress * 100)}%"></div></div>
      <div class="progress-text"><span>${escapeHtml(p.message)}</span><span>${describeProgress(p)}</span></div>
    </div>`;
  }

  async function run() {
    if (running) { manager.cancel(); return; }
    running = true;
    runBtn.textContent = 'Cancel';
    try {
      if (tab === 'project') {
        const preview = await getPreview();
        const blob = await manager.exportProject(scene, preview, baseName());
        await shelf.save(scene, preview);
        store.dirty = false;
        store.status(`Project saved - ${formatBytes(blob.size)}. Every layer stays editable.`, 'success');
        handle.close();
      } else if (tab === 'still') {
        const dims = dimensionsFor(scene, ex.resolution);
        const result = await manager.exportStill(scene, {
          ...dims, format: ex.stillFormat, quality: ex.stillQuality, time: getTime(),
        }, baseName());
        store.status(`Image exported - ${result.width}x${result.height}, ${formatBytes(result.blob.size)}.`, 'success');
        handle.close();
      } else {
        const dims = dimensionsFor(scene, ex.resolution);
        // Acquire the file handle first, while the click's user activation is
        // still fresh - showSaveFilePicker requires it.
        let fileHandle: FileSystemFileHandle | undefined;
        if (directToFile && typeof window.showSaveFilePicker === 'function') {
          const ext = ex.format === 'mp4' && (caps?.h264 ?? false) ? 'mp4' : 'webm';
          fileHandle = await window.showSaveFilePicker({
            suggestedName: `${baseName()}.${ext}`,
            types: [{ description: 'Video', accept: { [ext === 'mp4' ? 'video/mp4' : 'video/webm']: [`.${ext}`] } }],
          });
        }
        showProgress({ phase: 'preparing', progress: 0, message: 'Starting...' });
        const result = await manager.exportVideo(scene, {
          ...dims, fps: ex.fps, duration: ex.duration, bitrate: ex.bitrate, format: ex.format,
          onProgress: showProgress, fileHandle,
        }, baseName());
        if (!result.savedDirectly) downloadBlob(result.blob, result.filename);
        const host = qs<HTMLElement>('#video-progress', panel);
        if (host) {
          host.innerHTML = `<div class="info-box">
            <b>Export complete.</b> ${result.savedDirectly ? 'Written to the file you chose' : escapeHtml(result.filename)} - ${formatBytes(result.bytes)},
            ${result.duration.toFixed(1)}s, ${result.frames.toLocaleString()} frames,
            ${result.method === 'webcodecs-loop-tile' ? `encoded from ${result.encodedFrames} unique frames` : result.method}.
            ${result.warnings.length ? `<ul>${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
          </div>`;
        }
        store.status(`Video exported - ${formatBytes(result.bytes)}.`, 'success');
        void result.cleanup?.();
        runBtn.textContent = 'Done';
        runBtn.disabled = true;
      }
    } catch (err) {
      const e = err as Error;
      const cancelled = e.name === 'AbortError';
      const host = qs<HTMLElement>('#video-progress', panel) ?? panel;
      host.innerHTML = `<div class="info-box ${cancelled ? 'warn' : 'error'}">
        <b>${cancelled ? 'Export cancelled.' : 'Export failed.'}</b> ${escapeHtml(e.message)}
        ${cancelled ? '' : '<br>Your project is untouched - nothing was lost.'}</div>`;
      store.status(cancelled ? 'Export cancelled.' : `Export failed: ${e.message}`, cancelled ? 'warn' : 'error');
      runBtn.textContent = 'Retry';
      runBtn.disabled = false;
    } finally {
      running = false;
      if (lastProgress?.phase !== 'done') { /* leave the retry button enabled */ }
    }
  }

  void paint();
}

/* ------------------------------------------------------------------ about */

export function aboutDialog() {
  const body = el(`<div>
    <div class="welcome-hero">
      <div class="welcome-title">IMAGO UNIVERSE</div>
      <div class="welcome-tag">Create worlds. Bring them to life.</div>
    </div>
    <div class="section-title">Keyboard</div>
    <div class="shortcut-list">
      <div><span>Play / pause</span><span class="kbd">Space</span></div>
      <div><span>Pan canvas</span><span class="kbd">Space + drag</span></div>
      <div><span>Zoom</span><span class="kbd">Wheel</span></div>
      <div><span>Undo / redo</span><span class="kbd">Ctrl Z / Ctrl Y</span></div>
      <div><span>Duplicate</span><span class="kbd">Ctrl D</span></div>
      <div><span>Save project</span><span class="kbd">Ctrl S</span></div>
      <div><span>Delete</span><span class="kbd">Del</span></div>
      <div><span>Nudge</span><span class="kbd">Arrows</span></div>
      <div><span>Lock / hide</span><span class="kbd">L / H</span></div>
      <div><span>Free resize</span><span class="kbd">Alt + drag</span></div>
      <div><span>Constrain move</span><span class="kbd">Shift + drag</span></div>
      <div><span>Snap rotation</span><span class="kbd">Shift + rotate</span></div>
    </div>
    <div class="section-title" style="margin-top:20px">How it works</div>
    <div class="field-hint" style="font-size:11.5px">
      Four independent layers compose one environment. The compositor, the animation engine and the
      Loop Manager are separate modules, so animation never depends on export. Every built-in motion is
      built from whole harmonics of its own cycle, which is what makes the loop boundary exact rather
      than approximately seamless. Projects store the whole scene graph plus the artwork, and exporting
      never flattens or alters them. No generative AI, no paid APIs, no accounts - everything runs locally
      in your browser.
    </div>
  </div>`);
  openModal({ title: 'About Imago Universe', body });
}
