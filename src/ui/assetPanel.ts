/**
 * RAIL / Assets - the artwork browser for whichever layer is active.
 *
 * Layers 1-3 are gated by the active artistic style. Layer 4 is not: every
 * effect is listed regardless of style, which is the whole point of the
 * atmosphere layer.
 *
 * Placement is by drag onto the canvas. Click is a convenience that places the
 * same object at a sensible default position - it still creates an object, it
 * is never an on/off toggle, so the scene only ever contains what you put there.
 */
import type { AssetLibrary } from '../assets/library';
import type { Store } from '../core/store';
import type { LayerId } from '../core/types';
import { LAYER_HINT, LAYER_LABEL } from '../core/types';
import { EFFECTS, FAMILY_LABEL, THEME_PRESETS } from '../animation/effects';
import type { EffectDef } from '../animation/effects';
import { escapeHtml, icon, on, qsa, qs } from './dom';

export interface AssetPanelCallbacks {
  onAddAsset: (assetId: string) => void;
  onAddEffect: (effectId: string) => void;
  onImport: () => void;
}

export class AssetPanel {
  layer: LayerId = 'background';
  query = '';
  category = 'all';
  favouritesOnly = false;
  active = false;
  private previews = new Map<string, HTMLCanvasElement>();

  constructor(
    private root: HTMLElement,
    private store: Store,
    private library: AssetLibrary,
    private cb: AssetPanelCallbacks,
  ) {
    store.on('library', () => { if (this.active) this.render(); });
    store.on('scene', () => { if (this.active) this.syncGate(); });
  }

  setLayer(layer: LayerId) {
    if (this.layer === layer) return;
    this.layer = layer;
    this.category = 'all';
    this.query = '';
    if (this.active) this.render();
  }

  get title() {
    return this.layer === 'atmosphere' ? 'Atmosphere effects' : `${LAYER_LABEL[this.layer]} artwork`;
  }

  private syncGate() {
    const note = qs<HTMLElement>('.gate-note', this.root);
    if (!note) return;
    const style = this.library.style(this.store.scene.styleId);
    note.textContent = this.layer === 'atmosphere'
      ? 'Universal - works in every style'
      : `${style?.name ?? this.store.scene.styleId} only`;
  }

  render() {
    const isAtmos = this.layer === 'atmosphere';
    const scroll = qs<HTMLElement>('.asset-scroll', this.root)?.scrollTop ?? 0;
    this.root.innerHTML = `
      <div class="rail-tools">
        <label class="search">${icon('search', 13)}<input type="text"
          placeholder="Search ${isAtmos ? 'effects' : 'artwork'}..." value="${escapeHtml(this.query)}"></label>
        <button class="btn icon${this.favouritesOnly ? ' active' : ''}" data-fav title="Favourites only">${icon('star', 13)}</button>
        <button class="btn icon" data-import title="Import your own artwork">${icon('upload', 13)}</button>
      </div>
      <div class="rail-hint">${escapeHtml(LAYER_HINT[this.layer])} <span class="gate-note"></span></div>
      <div class="chips" id="category-chips"></div>
      <div class="asset-scroll"><div class="asset-grid big" id="asset-grid"></div></div>
      <div class="rail-foot">Drag onto the canvas to place. Drag a corner handle to scale in proportion.</div>
    `;

    const search = qs<HTMLInputElement>('.search input', this.root);
    on(search, 'input', () => { this.query = search!.value; this.renderGrid(); });
    on(qs('[data-fav]', this.root), 'click', () => { this.favouritesOnly = !this.favouritesOnly; this.render(); });
    on(qs('[data-import]', this.root), 'click', () => this.cb.onImport());

    this.renderChips();
    this.renderGrid();
    this.syncGate();
    const scroller = qs<HTMLElement>('.asset-scroll', this.root);
    if (scroller) scroller.scrollTop = scroll;
  }

  private renderChips() {
    const host = qs<HTMLElement>('#category-chips', this.root);
    if (!host) return;
    const cats = this.layer === 'atmosphere'
      ? Array.from(new Set(EFFECTS.map((e) => e.family)))
      : this.library.categories(this.store.scene.styleId, this.layer);
    host.innerHTML = [`<button class="chip${this.category === 'all' ? ' active' : ''}" data-cat="all">All</button>`]
      .concat(cats.map((c) => `<button class="chip${this.category === c ? ' active' : ''}" data-cat="${c}">${escapeHtml(this.layer === 'atmosphere' ? FAMILY_LABEL[c as keyof typeof FAMILY_LABEL] : c)}</button>`))
      .join('');
    qsa<HTMLElement>('.chip', host).forEach((b) => on(b, 'click', () => {
      this.category = b.dataset.cat!;
      this.renderChips();
      this.renderGrid();
    }));
  }

  private renderGrid() {
    const grid = qs<HTMLElement>('#asset-grid', this.root);
    if (!grid) return;
    grid.innerHTML = '';
    this.previews.clear();

    if (this.layer === 'atmosphere') {
      const q = this.query.toLowerCase();
      const list = EFFECTS.filter((e) =>
        (this.category === 'all' || e.family === this.category)
        && (!q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.family.includes(q)));
      if (!list.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>No effects match</strong>Try a different search or category.</div>`;
        return;
      }
      for (const def of list) grid.appendChild(this.effectCard(def));
      return;
    }

    const list = this.library.search(this.store.scene.styleId, this.layer, {
      query: this.query, category: this.category, favouritesOnly: this.favouritesOnly,
    });
    if (!list.length) {
      const style = this.library.style(this.store.scene.styleId);
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <strong>No matching artwork</strong>
        ${escapeHtml(style?.name ?? 'This style')} has nothing in this category yet.
        Styles only show artwork that belongs to them, so nothing here can clash.</div>`;
      return;
    }
    for (const meta of list) {
      const card = document.createElement('div');
      card.className = 'asset-card';
      card.draggable = true;
      card.dataset.asset = meta.id;
      card.title = `${meta.name}\n${meta.width}x${meta.height} - ${meta.origin}${meta.animations.length ? `\nAnimatable: ${meta.animations.join(', ')}` : ''}\n\nDrag onto the canvas to place.`;
      card.innerHTML = `
        <div class="asset-thumb${meta.layer === 'background' ? ' bg' : ''}">
          <img loading="lazy" src="${this.library.url(meta, true)}" alt="${escapeHtml(meta.name)}">
        </div>
        ${meta.origin !== 'painted' ? `<span class="asset-badge">${meta.origin}</span>` : ''}
        ${meta.animations.length ? `<span class="asset-anim">${icon('wind', 11)}</span>` : ''}
        <button class="asset-fav${this.library.favourites.has(meta.id) ? ' on' : ''}" title="Favourite">${icon('star', 11)}</button>
        <div class="asset-label">${escapeHtml(meta.name)}</div>`;
      on(card, 'dragstart', (e) => {
        (e as DragEvent).dataTransfer?.setData('application/x-imago-asset', meta.id);
        (e as DragEvent).dataTransfer!.effectAllowed = 'copy';
      });
      on(card, 'click', (e) => {
        if ((e.target as HTMLElement).closest('.asset-fav')) return;
        this.cb.onAddAsset(meta.id);
      });
      on(qs('.asset-fav', card), 'click', (e) => {
        e.stopPropagation();
        this.library.toggleFavourite(meta.id);
        this.renderGrid();
      });
      grid.appendChild(card);
    }
  }

  private effectCard(def: EffectDef): HTMLElement {
    const card = document.createElement('div');
    card.className = 'asset-card effect-card';
    card.draggable = true;
    card.dataset.effect = def.id;
    card.title = `${def.name}\n${def.description}\n\nDrag onto the canvas to place.`;
    card.innerHTML = `
      <div class="effect-preview"><canvas width="220" height="140"></canvas></div>
      <div class="asset-label">${escapeHtml(def.name)}</div>
      <div class="effect-family">${escapeHtml(FAMILY_LABEL[def.family])} - ${def.defaultLoop}s</div>`;
    const canvas = qs<HTMLCanvasElement>('canvas', card)!;
    this.paintEffectPreview(canvas, def);
    this.previews.set(def.id, canvas);
    on(card, 'dragstart', (e) => {
      (e as DragEvent).dataTransfer?.setData('application/x-imago-effect', def.id);
      (e as DragEvent).dataTransfer!.effectAllowed = 'copy';
    });
    on(card, 'click', () => this.cb.onAddEffect(def.id));
    let raf = 0;
    on(card, 'pointerenter', () => {
      const start = performance.now();
      const tick = () => {
        const u = ((performance.now() - start) / 1000 / def.defaultLoop) % 1;
        this.paintEffectPreview(canvas, def, u);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    on(card, 'pointerleave', () => {
      cancelAnimationFrame(raf);
      this.paintEffectPreview(canvas, def);
    });
    return card;
  }

  private paintEffectPreview(canvas: HTMLCanvasElement, def: EffectDef, u = 0.35) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, '#141d31');
    g.addColorStop(1, '#080b12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.globalCompositeOperation = def.blend;
    const params: Record<string, number | string | boolean> = {};
    for (const p of def.params) params[p.key] = p.default;
    if (typeof params.density === 'number') params.density = Math.min(params.density, 45);
    if (typeof params.stars === 'number') params.stars = Math.min(params.stars, 9);
    try {
      def.draw(ctx, { w: canvas.width, h: canvas.height, u, t: u * def.defaultLoop, params, seed: 7, scale: 1 });
    } catch { /* preview only */ }
    ctx.restore();
  }
}

/** RAIL / Collections - the theme presets, only relevant to layer 4. */
export class ThemesPanel {
  active = false;
  constructor(
    private root: HTMLElement,
    private onApply: (themeId: string) => void,
  ) {}

  render() {
    this.root.innerHTML = `<div class="rail-pad">
      <div class="field-hint" style="margin-bottom:10px">
        Artistic interpretations, not claims of cultural authenticity. Each collection places several
        universal effects with suggested settings - every parameter stays editable afterwards.
      </div>
      ${THEME_PRESETS.map((t) => `
        <div class="theme-card" data-theme="${t.id}">
          <div class="theme-name">${escapeHtml(t.name)}</div>
          <div class="theme-desc">${escapeHtml(t.description)}</div>
          <div class="theme-tags">${t.effects.map((e) => `<span class="theme-tag">${escapeHtml(EFFECTS.find((x) => x.id === e.id)?.name ?? e.id)}</span>`).join('')}</div>
        </div>`).join('')}
    </div>`;
    qsa<HTMLElement>('.theme-card', this.root).forEach((c) =>
      on(c, 'click', () => this.onApply(c.dataset.theme!)));
  }
}
