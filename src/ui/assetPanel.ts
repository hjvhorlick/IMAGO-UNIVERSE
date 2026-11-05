/**
 * RAIL / Assets - the artwork browser for whichever layer is active.
 *
 * Artwork is gated by the active artistic style, including Layer 4 rooms.
 * Layer 4 effects are universal and remain available in every style.
 *
 * Placement is by drag onto the canvas. Click is a convenience that places the
 * same object at a sensible default position - it still creates an object, it
 * is never an on/off toggle, so the scene only ever contains what you put there.
 */
import type { AssetLibrary } from '../assets/library';
import { WORLD_COLLECTIONS, collectionId, inWorldCollection } from '../assets/worldCollections';
import type { Store } from '../core/store';
import type { LayerId } from '../core/types';
import { LAYER_LABEL } from '../core/types';
import { EFFECTS, FAMILY_LABEL, THEME_PRESETS } from '../animation/effects';
import type { EffectDef } from '../animation/effects';
import { SPIRITUAL_SUBCATEGORIES } from '../animation/spiritualOverlays';
import { escapeHtml, icon, on, qsa, qs } from './dom';

export interface AssetPanelCallbacks {
  onAddAsset: (assetId: string) => void;
  onAddEffect: (effectId: string) => void;
  onImport: () => void;
  onChooseStyle: (styleId: string) => void;
  onChooseWorld: (world: string) => void;
}

export class AssetPanel {
  layer: LayerId = 'background';
  query = '';
  category = 'all';
  subcategory = 'all';
  favouritesOnly = false;
  /** Artwork columns in the grid: 2 for large thumbnails, 3 or 4 to see more at once. */
  columns = 3;
  active = false;
  private atmosphereTab: 'effects' | 'rooms' = 'effects';
  private previews = new Map<string, HTMLCanvasElement>();
  private renderedStyle = '';
  private renderedWorld = '';

  constructor(
    private root: HTMLElement,
    private store: Store,
    private library: AssetLibrary,
    private cb: AssetPanelCallbacks,
    private categoryPicker: HTMLSelectElement,
  ) {
    store.on('library', () => { if (this.active) this.render(); });
    store.on('scene', () => {
      if (!this.active) return;
      if (this.renderedStyle !== store.scene.styleId || this.renderedWorld !== collectionId(store.scene.theme)) this.render();
    });
  }

  setLayer(layer: LayerId) {
    if (this.layer === layer) return;
    this.layer = layer;
    this.category = 'all';
    this.subcategory = 'all';
    if (layer === 'atmosphere') this.atmosphereTab = 'effects';
    if (this.active) this.render();
  }

  setQuery(query: string) { this.query = query; if (this.active) this.renderGrid(); }
  setCategory(category: string) {
    this.category = category;
    this.subcategory = 'all';
    if (this.active) { this.renderChips(); this.renderGrid(); }
  }

  get title() {
    return this.layer === 'atmosphere' ? 'Atmosphere effects' : `${LAYER_LABEL[this.layer]} artwork`;
  }

  render() {
    const scroll = qs<HTMLElement>('.asset-scroll', this.root)?.scrollTop ?? 0;
    this.renderedStyle = this.store.scene.styleId;
    this.renderedWorld = collectionId(this.store.scene.theme);
    this.root.innerHTML = `
      <div class="library-start">
        <div class="library-pickers">
          <label>Season / look<select aria-label="Season or look">
            ${this.library.styles.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === this.renderedStyle ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select></label>
          <label>World<select aria-label="World collection">
            <option value="all">All worlds</option>
            ${WORLD_COLLECTIONS.map((w) => `<option value="${w.id}"${w.id === this.renderedWorld ? ' selected' : ''}>${escapeHtml(w.label)}</option>`).join('')}
          </select></label>
          <button class="btn icon${this.favouritesOnly ? ' active' : ''}" data-fav title="Favourites only" aria-label="Favourites only">${icon('star', 13)}</button>
          <button class="btn icon" data-density title="Change how many artworks show per row" aria-label="Artworks per row">${this.columns}×</button>
          <button class="btn icon" data-import title="Import your own artwork" aria-label="Import artwork">${icon('upload', 13)}</button>
        </div>
      </div>
      ${this.layer === 'atmosphere' ? `<div class="library-tabs" role="tablist" aria-label="Layer 4 collections">
        <button role="tab" data-library-tab="effects" aria-selected="${this.atmosphereTab === 'effects'}" class="${this.atmosphereTab === 'effects' ? 'active' : ''}">Atmosphere</button>
        <button role="tab" data-library-tab="rooms" aria-selected="${this.atmosphereTab === 'rooms'}" class="${this.atmosphereTab === 'rooms' ? 'active' : ''}">Rooms &amp; interiors</button>
      </div>` : ''}
      <div id="spiritual-subcategories"></div>
      <div class="asset-scroll"><div class="asset-grid big" id="asset-grid"></div></div>
    `;

    const styleSelect = qs<HTMLSelectElement>('[aria-label="Season or look"]', this.root)!;
    on(styleSelect, 'change', () => this.cb.onChooseStyle(styleSelect.value));
    const worldSelect = qs<HTMLSelectElement>('[aria-label="World collection"]', this.root)!;
    on(worldSelect, 'change', () => { this.category = 'all'; this.cb.onChooseWorld(worldSelect.value); this.render(); });
    qsa<HTMLElement>('[data-library-tab]', this.root).forEach((tab) => on(tab, 'click', () => {
      this.atmosphereTab = tab.dataset.libraryTab as 'effects' | 'rooms';
      this.category = 'all'; this.subcategory = 'all'; this.render();
    }));
    on(qs('[data-fav]', this.root), 'click', () => { this.favouritesOnly = !this.favouritesOnly; this.render(); });
    on(qs('[data-density]', this.root), 'click', () => {
      this.columns = this.columns === 2 ? 3 : this.columns === 3 ? 4 : 2;
      this.render();
    });
    on(qs('[data-import]', this.root), 'click', () => this.cb.onImport());

    this.renderChips();
    this.renderGrid();
    const scroller = qs<HTMLElement>('.asset-scroll', this.root);
    if (scroller) scroller.scrollTop = scroll;
  }

  private renderChips() {
    const effects = this.layer === 'atmosphere' && this.atmosphereTab === 'effects';
    const rooms = this.layer === 'atmosphere' && this.atmosphereTab === 'rooms';
    const cats = rooms ? ['room-views', 'furniture'] : effects
      ? Array.from(new Set(EFFECTS.map((e) => e.family)))
      : this.library.categories(this.store.scene.styleId, this.layer).filter((c) => c !== 'interiors');
    const label = (c: string) => rooms ? (c === 'room-views' ? 'Room views' : 'Furniture & props')
      : effects ? FAMILY_LABEL[c as keyof typeof FAMILY_LABEL] : c.charAt(0).toUpperCase() + c.slice(1);
    this.categoryPicker.innerHTML = `<option value="all">All categories</option>`
      + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(label(c))}</option>`).join('');
    this.categoryPicker.value = this.category;
    const subs = qs<HTMLElement>('#spiritual-subcategories', this.root);
    if (subs) {
      subs.innerHTML = effects && this.category === 'spiritual'
        ? `<label class="spiritual-filter">Collection <select aria-label="Spiritual overlay subcategory">
            <option value="all">All spiritual overlays</option>
            ${SPIRITUAL_SUBCATEGORIES.map((name) => `<option value="${escapeHtml(name)}"${this.subcategory === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
          </select></label>` : '';
      const select = qs<HTMLSelectElement>('select', subs);
      on(select, 'change', () => { this.subcategory = select!.value; this.renderGrid(); });
    }
  }

  private renderGrid() {
    const grid = qs<HTMLElement>('#asset-grid', this.root);
    if (!grid) return;
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `repeat(${this.columns}, minmax(0, 1fr))`;
    grid.classList.toggle('dense', this.columns > 2);
    this.previews.clear();

    const rooms = this.layer === 'atmosphere' && this.atmosphereTab === 'rooms';
    if (this.layer === 'atmosphere' && !rooms) {
      const q = this.query.toLowerCase();
      const list = EFFECTS.filter((e) =>
        (this.category === 'all' || e.family === this.category)
        && (this.category !== 'spiritual' || this.subcategory === 'all' || e.subcategory === this.subcategory)
        && (!q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.family.includes(q) || e.subcategory?.toLowerCase().includes(q)));
      if (!list.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>No effects match</strong>Try a different search or category.</div>`;
        return;
      }
      for (const def of list) grid.appendChild(this.effectCard(def));
      return;
    }

    const list = this.library.search(this.store.scene.styleId, rooms ? 'foreground' : this.layer, {
      query: this.query, category: rooms ? 'interiors' : this.category, favouritesOnly: this.favouritesOnly,
    }).filter((asset) => inWorldCollection(asset, this.renderedWorld))
      .filter((asset) => rooms || asset.category !== 'interiors')
      .filter((asset) => !rooms || this.category === 'all' ||
        (this.category === 'room-views' ? asset.rig?.type === 'window-overlay' : asset.rig?.type !== 'window-overlay'));
    if (rooms) {
      // Full room views first, followed by the loose furniture and props.
      list.sort((a, b) => Number(b.rig?.type === 'window-overlay') - Number(a.rig?.type === 'window-overlay'));
    }
    if (!list.length) {
      const style = this.library.style(this.store.scene.styleId);
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <strong>No matching artwork</strong>
        Nothing matches these filters in ${escapeHtml(style?.name ?? 'this look')}.
        Try All worlds, All categories, or a different search.</div>`;
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
      <div class="effect-family">${escapeHtml(def.subcategory ?? FAMILY_LABEL[def.family])} - ${def.defaultLoop}s</div>`;
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
