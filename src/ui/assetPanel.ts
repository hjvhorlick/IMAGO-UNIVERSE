/**
 * LEFT PANEL - asset library, universal effects and theme collections.
 *
 * Layers 1-3 are gated by the active artistic style. Layer 4 is not: every
 * effect is listed regardless of style, which is the whole point of the
 * atmosphere layer.
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
  onApplyTheme: (themeId: string) => void;
  onImport: () => void;
  onChangeStyle: () => void;
}

const LAYER_SHORT = ['Back', 'Middle', 'Fore', 'Atmos'];

export class AssetPanel {
  layer: LayerId = 'middle';
  tab: 'assets' | 'themes' = 'assets';
  query = '';
  category = 'all';
  favouritesOnly = false;
  private previews = new Map<string, HTMLCanvasElement>();

  constructor(
    private root: HTMLElement,
    private store: Store,
    private library: AssetLibrary,
    private cb: AssetPanelCallbacks,
  ) {
    this.render();
    store.on('library', () => this.render());
    store.on('scene', () => this.syncStyleGate());
  }

  setLayer(layer: LayerId) {
    this.layer = layer;
    this.category = 'all';
    this.render();
  }

  private syncStyleGate() {
    const chip = qs<HTMLElement>('.style-gate-note', this.root);
    if (chip) {
      const style = this.library.style(this.store.scene.styleId);
      chip.textContent = this.layer === 'atmosphere'
        ? 'Universal - available in every style'
        : `Showing ${style?.name ?? this.store.scene.styleId} artwork only`;
    }
  }

  render() {
    const isAtmos = this.layer === 'atmosphere';
    this.root.innerHTML = `
      <div class="panel-tabs">
        <button class="panel-tab${this.tab === 'assets' ? ' active' : ''}" data-tab="assets">${isAtmos ? 'Effects' : 'Library'}</button>
        <button class="panel-tab${this.tab === 'themes' ? ' active' : ''}" data-tab="themes">Themes</button>
      </div>
      <div class="layer-tabs">
        ${([1, 2, 3, 4] as const).map((i) => {
          const id = (['background', 'middle', 'foreground', 'atmosphere'] as LayerId[])[i - 1];
          return `<button class="layer-tab${this.layer === id ? ' active' : ''}" data-layer="${id}" title="${escapeHtml(LAYER_LABEL[id])}">
            <span class="layer-num">${i}</span><span class="layer-name">${LAYER_SHORT[i - 1]}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="layer-hint">${escapeHtml(LAYER_HINT[this.layer])}</div>
      ${this.tab === 'themes' ? '<div class="panel-body" id="theme-list"></div>' : `
        <div class="search-row">
          <label class="search">${icon('search', 13)}<input type="text" placeholder="Search ${isAtmos ? 'effects' : 'artwork'}..." value="${escapeHtml(this.query)}"></label>
          <button class="btn icon${this.favouritesOnly ? ' active' : ''}" data-fav-toggle title="Favourites only">${icon('star', 13)}</button>
        </div>
        <div class="chips" id="category-chips"></div>
        <div class="layer-hint style-gate-note" style="padding-bottom:6px"></div>
        <div class="panel-body"><div class="asset-grid" id="asset-grid"></div></div>
        <div class="panel-footer">
          <div class="row">
            <button class="btn small block" data-import>${icon('upload', 12)} Import artwork</button>
            <button class="btn small" data-style title="Change artistic style">${icon('grid', 12)}</button>
          </div>
        </div>`}
    `;

    qsa<HTMLElement>('.panel-tab', this.root).forEach((b) =>
      on(b, 'click', () => { this.tab = b.dataset.tab as 'assets' | 'themes'; this.render(); }));
    qsa<HTMLElement>('.layer-tab', this.root).forEach((b) =>
      on(b, 'click', () => this.setLayer(b.dataset.layer as LayerId)));

    if (this.tab === 'themes') { this.renderThemes(); return; }

    const search = qs<HTMLInputElement>('.search input', this.root);
    on(search, 'input', () => { this.query = search!.value; this.renderGrid(); });
    on(qs('[data-fav-toggle]', this.root), 'click', () => { this.favouritesOnly = !this.favouritesOnly; this.render(); });
    on(qs('[data-import]', this.root), 'click', () => this.cb.onImport());
    on(qs('[data-style]', this.root), 'click', () => this.cb.onChangeStyle());

    this.renderChips();
    this.renderGrid();
    this.syncStyleGate();
  }

  private renderChips() {
    const host = qs<HTMLElement>('#category-chips', this.root);
    if (!host) return;
    let cats: string[];
    if (this.layer === 'atmosphere') {
      cats = Array.from(new Set(EFFECTS.map((e) => e.family)));
    } else {
      cats = this.library.categories(this.store.scene.styleId, this.layer);
    }
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
        ${escapeHtml(style?.name ?? 'This style')} has no assets in this category yet.
        Styles only show artwork that belongs to them, so nothing here can clash.</div>`;
      return;
    }
    for (const meta of list) {
      const card = document.createElement('div');
      card.className = 'asset-card';
      card.draggable = true;
      card.title = `${meta.name}\n${meta.width}x${meta.height} - ${meta.origin}${meta.animations.length ? `\nAnimatable: ${meta.animations.join(', ')}` : ''}`;
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
    card.title = `${def.name}\n${def.description}`;
    card.innerHTML = `
      <div class="effect-preview"><canvas width="150" height="104"></canvas></div>
      <div class="asset-label">${escapeHtml(def.name)}</div>
      <div class="effect-family">${escapeHtml(FAMILY_LABEL[def.family])} - ${def.defaultLoop}s loop</div>`;
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

  private renderThemes() {
    const host = qs<HTMLElement>('#theme-list', this.root);
    if (!host) return;
    host.innerHTML = `<div class="panel-section">
      <div class="section-title">Atmosphere collections</div>
      <div class="field-hint" style="margin-bottom:12px">
        Artistic interpretations, not claims of cultural authenticity. Each collection adds several
        universal effects with suggested settings - every parameter stays editable afterwards.
      </div>
      ${THEME_PRESETS.map((t) => `
        <div class="theme-card" data-theme="${t.id}">
          <div class="theme-name">${escapeHtml(t.name)}</div>
          <div class="theme-desc">${escapeHtml(t.description)}</div>
          <div class="theme-tags">${t.effects.map((e) => `<span class="theme-tag">${escapeHtml(EFFECTS.find((x) => x.id === e.id)?.name ?? e.id)}</span>`).join('')}</div>
        </div>`).join('')}
    </div>`;
    qsa<HTMLElement>('.theme-card', host).forEach((c) =>
      on(c, 'click', () => this.cb.onApplyTheme(c.dataset.theme!)));
  }
}
