/**
 * APPLICATION SHELL
 * =================
 * Builds the interface and wires the independent modules together. Nothing in
 * here contains rendering, animation or export logic - it only connects them.
 *
 * Layout philosophy: the canvas is the product. Chrome that can live behind a
 * click does. There is no left panel, no second toolbar row, no status bar and
 * no timeline strip - the motion is looping, so there is nothing to scrub to.
 * Commands live in top-bar menus; the four layers and a panel picker are in
 * the header, leaving the side rail for the selected content.
 */
import { AssetLibrary } from '../assets/library';
import { collectionId, worldForBackground } from '../assets/worldCollections';
import { Store } from '../core/store';
import type { StatusMessage } from '../core/store';
import type { AssetMeta, LayerId, Scene, SceneNode } from '../core/types';
import { LAYER_LABEL } from '../core/types';
import { clamp, downloadBlob } from '../core/util';
import { ImageCache } from '../render/imageCache';
import { Compositor } from '../render/compositor';
import { PreviewRenderer } from '../render/previewRenderer';
import { LoopManager, loopManager } from '../animation/loopManager';
import { EFFECTS, EFFECT_MAP, THEME_PRESETS, effectDefaults } from '../animation/effects';
import { ExportManager } from '../export/exportManager';
import { ProjectShelf, openProjectFromFile, saveProjectToFile } from '../project/projectShelf';
import type { LoadedProject } from '../project/projectFormat';
import { registerAudioBlob } from '../audio/audioStore';
import { autoCompose, DEFAULT_COMPOSE, regenerate } from '../scene/composition';
import { createAssetNode, createScene, nextOrder } from '../scene/sceneModel';
import { buildDemoScene } from '../scene/demoScene';
import { createWorldScene } from '../scene/worlds';
import { switchStyle } from '../scene/styleManager';
import { AssetPanel, ThemesPanel } from './assetPanel';
import { LayersPanel } from './layersPanel';
import { Inspector, makeEffectNode } from './inspector';
import { ScenePanel } from './scenePanel';
import { SoundPanel } from './soundPanel';
import { Stage } from './stage';
import { MenuBar } from './menubar';
import type { MenuDef } from './menubar';
import { Rail } from './rail';
import { el, escapeHtml, icon, on, qs, qsa } from './dom';
import {
  aboutDialog, composeDialog, cropDialog, exportDialog, historyDialog,
  importDialog, newWorldDialog, projectsDialog, replaceDialog,
} from './dialogs';
import type { ModalHandle, StartingPoint } from './dialogs';

const LAYERS: LayerId[] = ['background', 'middle', 'foreground', 'atmosphere'];
const LAYER_SHORT = ['Background', 'Middle', 'Foreground', 'Atmosphere & Rooms'];

const SHELL = `
<div class="app">
  <header class="topbar">
    <div class="brand-mark" title="Imago Universe - create worlds, bring them to life"></div>
    <nav class="menubar" id="menubar"></nav>
    <input class="project-name" id="project-name" value="Untitled world" spellcheck="false" aria-label="Project name">
    <div class="layer-tabs" id="layer-tabs" role="tablist">
      ${LAYERS.map((id, i) => `<button class="layer-tab${i === 0 ? ' active' : ''}" data-layer="${id}"
        role="tab" title="${escapeHtml(LAYER_LABEL[id])}">
        <span class="layer-num">${i + 1}</span><span class="layer-name">${LAYER_SHORT[i]}</span>
      </button>`).join('')}
    </div>
    <select id="panel-picker" class="header-select" aria-label="Panel"></select>
    <select id="category-picker" class="header-select" aria-label="Artwork category"></select>
    <label class="search topbar-search">${icon('search', 13)}<input id="library-search" type="search" aria-label="Search artwork and effects" placeholder="Search..."></label>
    <span class="topbar-spacer"></span>
    <button class="loop-chip" id="loop-chip" title="Loop analysis"><span class="loop-dot"></span><span id="loop-text">Loop</span></button>
    <button class="btn icon" id="btn-play" title="Play / pause (Space)">${icon('play', 14)}</button>
    <button class="btn icon" id="btn-restart" title="Restart from the beginning">${icon('restart', 14)}</button>
    <button class="btn icon" id="btn-rail" title="Show / hide the side panel (\\)">${icon('right', 14)}</button>
    <button class="btn primary" id="btn-export" title="Download or export">${icon('download', 13)} Download</button>
  </header>

  <main class="workspace">
    <section class="stage-wrap">
      <div class="stage">
        <div class="canvas-holder">
          <canvas id="scene-canvas"></canvas>
          <canvas id="overlay-canvas"></canvas>
        </div>
        <div class="stage-empty" id="stage-empty"><strong>Start with an empty world</strong><span>Choose a season or look and a world on the right, then pick a background.</span></div>
        <div class="stage-hud" id="stage-hud"></div>
        <div class="zoom-pill">
          <button class="zp-btn" id="btn-zoom-out" title="Zoom out">${icon('zoomOut', 12)}</button>
          <span class="zp-value" id="zoom-value">100%</span>
          <button class="zp-btn" id="btn-zoom-in" title="Zoom in">${icon('zoomIn', 12)}</button>
          <button class="zp-btn wide" id="btn-fit" title="Fit to view (F)">Fit</button>
        </div>
      </div>
    </section>
    <aside class="panel-rail" id="rail"></aside>
  </main>
</div>
<div class="modal-root"></div>
<div class="toast-root"></div>
`;

export class App {
  library = new AssetLibrary();
  store!: Store;
  images!: ImageCache;
  compositor!: Compositor;
  preview!: PreviewRenderer;
  exports!: ExportManager;
  shelf!: ProjectShelf;
  stage!: Stage;
  loops: LoopManager = loopManager;

  private assetPanel!: AssetPanel;
  private themesPanel!: ThemesPanel;
  private layersPanel!: LayersPanel;
  private objectPanel!: Inspector;
  private animatePanel!: Inspector;
  private scenePanel!: ScenePanel;
  private soundPanel!: SoundPanel;
  private rail!: Rail;
  private menubar!: MenuBar;
  private activeLayer: LayerId = 'background';
  private autosaveTimer = 0;
  private hudTimer = 0;
  private windowListeners: (() => void)[] = [];
  private soloNode: string | null = null;
  private worldDialog: ModalHandle | null = null;

  async mount(root: HTMLElement) {
    root.innerHTML = SHELL;
    await this.library.load();

    // Start empty. The designer chooses a world, and only its background appears.
    const scene = createScene(this.library.styles[0]?.id ?? 'enchanted', 'Untitled world');
    this.store = new Store(scene);
    this.images = new ImageCache(this.library);
    this.compositor = new Compositor(this.library, this.images, this.loops);
    const canvas = qs<HTMLCanvasElement>('#scene-canvas', root)!;
    this.preview = new PreviewRenderer(canvas, this.store, this.compositor, this.images);
    this.exports = new ExportManager(this.compositor, this.images, this.library, this.loops, this.library);
    this.shelf = new ProjectShelf(this.library);
    await this.shelf.init();

    this.buildRail(root);
    this.buildMenus(root);
    this.buildStage(root);
    this.wireTopbar(root);
    this.wireKeyboard();
    this.wireStore(root);

    await this.images.ensure(scene.nodes.map((n) => n.assetId));
    this.stage.refit();
    this.preview.invalidate();
    this.refreshChrome();
    this.preview.play();
    this.openWorldPicker(true);

    this.autosaveTimer = window.setInterval(() => { void this.autosave(); }, 45_000);
    this.hudTimer = window.setInterval(() => this.updateHud(), 500);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (this.store.dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    this.windowListeners.push(() => window.removeEventListener('beforeunload', beforeUnload));
  }

  /* ----------------------------------------------------------------- rail */

  private buildRail(root: HTMLElement) {
    this.rail = new Rail(qs<HTMLElement>('#rail', root)!, qs<HTMLSelectElement>('#panel-picker', root)!);

    const assetsBody = this.rail.add({
      id: 'assets',
      icon: 'image',
      title: 'Artwork',
      titleFn: () => `${LAYERS.indexOf(this.activeLayer) + 1} · ${LAYER_SHORT[LAYERS.indexOf(this.activeLayer)]}`,
      badge: () => this.activeLayer === 'atmosphere' ? `${EFFECTS.length} effects` : `${this.library.forStyle(this.store.scene.styleId, this.activeLayer).length}`,
      onToggle: (open) => { this.assetPanel.active = open; if (open) this.assetPanel.render(); },
    });
    this.assetPanel = new AssetPanel(assetsBody, this.store, this.library, {
      onAddAsset: (id) => this.addAsset(id),
      onAddEffect: (id) => this.addEffect(id),
      onChooseStyle: (styleId) => this.chooseStyle(styleId),
      onChooseWorld: (world) => {
        if (this.store.scene.theme !== world) this.store.mutate((scene) => { scene.theme = world; }, 'Choose world collection');
      },
      onImport: () => importDialog(this.library, this.store.scene.styleId, (meta) => {
        this.store.emit('library');
        this.store.status(`Imported "${meta.name}" into ${LAYER_LABEL[meta.layer]}.`, 'success');
      }),
    }, qs<HTMLSelectElement>('#category-picker', root)!);

    const themesBody = this.rail.add({
      id: 'collections',
      icon: 'sparkles',
      title: 'Theme collections',
      hidden: () => this.activeLayer !== 'atmosphere',
      badge: () => `${THEME_PRESETS.length}`,
      onToggle: (open) => { this.themesPanel.active = open; if (open) this.themesPanel.render(); },
    });
    this.themesPanel = new ThemesPanel(themesBody, (id) => this.applyTheme(id));

    const canvasBody = this.rail.add({
      id: 'canvas',
      icon: 'layers',
      title: 'On canvas',
      badge: () => `${this.store.scene.nodes.length}`,
      onToggle: (open) => { this.layersPanel.active = open; if (open) this.layersPanel.render(); },
    });
    this.layersPanel = new LayersPanel(canvasBody, this.store, this.library, {
      onInspect: (node) => this.inspect(node),
    });

    const inspectorCbs = {
      onCrop: (node: SceneNode) => this.openCrop(node),
      onReplace: (node: SceneNode) => replaceDialog(node, this.store, this.library, (meta) => this.replaceAsset(node, meta)),
      onSoloAnimation: (node: SceneNode | null) => this.setSolo(node),
      onSoloLayer: (layer: LayerId | null) => this.setSoloLayer(layer),
    };
    const objectBody = this.rail.add({
      id: 'object',
      icon: 'settings',
      title: 'Properties',
      badge: () => this.store.primary?.name ?? 'none selected',
      onToggle: (open) => { this.objectPanel.active = open; if (open) this.objectPanel.render(); },
    });
    this.objectPanel = new Inspector(objectBody, this.store, this.library, inspectorCbs);
    this.objectPanel.setMode('object');

    const animateBody = this.rail.add({
      id: 'animate',
      icon: 'wind',
      title: 'Animation',
      badge: () => this.store.primary?.name ?? 'none selected',
      onToggle: (open) => { this.animatePanel.active = open; if (open) this.animatePanel.render(); },
    });
    this.animatePanel = new Inspector(animateBody, this.store, this.library, inspectorCbs);
    this.animatePanel.setMode('animate');

    const sceneBody = this.rail.add({
      id: 'scene',
      icon: 'sun',
      title: 'World settings',
      onToggle: (open) => { this.scenePanel.active = open; if (open) this.scenePanel.render(); },
    });
    this.scenePanel = new ScenePanel(sceneBody, this.store, this.library, this.preview, this.images, {
      onCompose: () => this.openCompose(),
      onRegenerate: () => this.doRegenerate(),
    });

    const soundBody = this.rail.add({
      id: 'sound',
      icon: 'loop',
      title: 'Sound',
      badge: () => this.store.scene.audio?.name ?? 'none',
      onToggle: (open) => { this.soundPanel.active = open; if (open) this.soundPanel.render(); },
    });
    this.soundPanel = new SoundPanel(soundBody, this.store, this.preview);

    this.rail.build();
    this.rail.setOpen('assets');
    this.assetPanel.setLayer(this.activeLayer);
    this.assetPanel.render();
  }

  /* ---------------------------------------------------------------- menus */

  private buildMenus(root: HTMLElement) {
    const menus: MenuDef[] = [
      {
        id: 'file', label: 'File',
        items: () => [
          { label: 'New world…', icon: 'plus', action: () => this.newWorld() },
          { label: 'Open project…', icon: 'folder', shortcut: 'Ctrl+O', action: () => this.openProjects() },
          { label: 'Open .sceneproject file…', icon: 'file', action: () => this.openFile() },
          { separator: true },
          { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: () => { void this.save(false); } },
          { label: 'Save As…', icon: 'copy', shortcut: 'Ctrl+Shift+S', action: () => { void this.save(true); } },
          { separator: true },
          { label: 'Export image or video…', icon: 'download', shortcut: 'Ctrl+E', action: () => this.openExport() },
          { separator: true },
          { label: 'About & shortcuts', icon: 'info', action: () => aboutDialog() },
        ],
      },
      {
        id: 'edit', label: 'Edit',
        items: () => [
          { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', disabled: !this.store.past.length, action: () => { if (!this.store.undo()) this.store.status('Nothing to undo.', 'info'); } },
          { label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Y', disabled: !this.store.future.length, action: () => { if (!this.store.redo()) this.store.status('Nothing to redo.', 'info'); } },
          { label: 'History…', icon: 'history', action: () => historyDialog(this.store) },
          { separator: true },
          { label: 'Duplicate', icon: 'copy', shortcut: 'Ctrl+D', disabled: !this.store.selection.length, action: () => this.store.duplicateSelected() },
          { label: 'Delete', icon: 'trash', shortcut: 'Del', disabled: !this.store.selection.length, action: () => this.store.removeSelected() },
          { separator: true },
          { label: 'Select all artwork', shortcut: 'Ctrl+A', action: () => this.store.select(this.store.scene.nodes.filter((n) => !n.locked && n.kind === 'asset').map((n) => n.id)) },
          { label: 'Deselect', shortcut: 'Esc', action: () => { this.store.select([]); this.setSolo(null); } },
          { separator: true },
          { label: 'Auto-compose…', icon: 'wand', action: () => this.openCompose() },
          { label: 'Rearrange unlocked', icon: 'dice', action: () => this.doRegenerate() },
        ],
      },
      {
        id: 'view', label: 'View',
        items: () => [
          { label: 'Zoom in', icon: 'zoomIn', action: () => { this.stage.setZoom(this.stage.zoom * 1.25); this.updateHud(); } },
          { label: 'Zoom out', icon: 'zoomOut', action: () => { this.stage.setZoom(this.stage.zoom / 1.25); this.updateHud(); } },
          { label: 'Fit to view', icon: 'fit', shortcut: 'F', action: () => { this.stage.resetView(); this.stage.refit(); this.updateHud(); } },
          { separator: true },
          { label: 'Clip to canvas', icon: 'crop', checked: this.store.scene.canvas.clipToCanvas, action: () => { this.store.mutate((s) => { s.canvas.clipToCanvas = !s.canvas.clipToCanvas; }, 'Toggle canvas clipping'); this.refreshChrome(); } },
          { label: 'Show all layers', icon: 'layers', action: () => this.setSolo(null) },
          { separator: true },
          { label: 'Side panel', shortcut: '\\', checked: !this.railCollapsed, action: () => this.toggleRail() },
        ],
      },
    ];
    this.menubar = new MenuBar(qs<HTMLElement>('#menubar', root)!, menus);
  }

  private chooseStyle(styleId: string) {
    if (styleId === this.store.scene.styleId || !this.library.style(styleId)) return;
    if (this.store.scene.nodes.some((node) => node.kind === 'asset') &&
        !window.confirm('Changing the season or look swaps existing artwork to matching pieces. Some items may be replaced or removed. You can undo this change. Continue?')) {
      this.assetPanel.render();
      return;
    }
    this.store.pushHistory('Change season or look');
    const report = switchStyle(this.store.scene, this.library, styleId);
    this.store.mutate(() => {});
    this.afterSceneSwap();
    this.store.status(`Look set to ${report.style?.name ?? styleId}. ${report.swapped} artwork items swapped${report.removed.length ? `; ${report.removed.length} removed` : ''}.`, report.removed.length ? 'warn' : 'success');
  }

  private openCompose() {
    composeDialog(this.store, (opts) => {
      this.store.pushHistory('Auto-compose');
      const r = autoCompose(this.store.scene, this.library, opts);
      this.store.mutate(() => {});
      this.afterSceneSwap();
      this.store.status(`Composed ${r.added} objects, kept ${r.kept} locked.`, 'success');
    });
  }

  private openExport() {
    exportDialog(this.store, this.exports, this.shelf, () => this.preview.thumbnail(), () => this.preview.time);
  }

  /* ---------------------------------------------------------------- stage */

  private buildStage(root: HTMLElement) {
    this.stage = new Stage(root, this.store, this.preview, {
      onDropAsset: (id, x, y) => this.addAsset(id, { x, y }),
      onDropEffect: (id, x, y) => this.addEffect(id, { x, y }),
      onDoubleClick: (node) => { if (node) this.inspect(node); },
      canSelectSpiritual: () => this.activeLayer === 'atmosphere',
    });
  }

  /** Open the section that actually edits this object. */
  private inspect(node: SceneNode) {
    this.store.select(node.id);
    this.rail.setOpen(node.kind === 'effect' ? 'animate' : 'object');
  }

  /* --------------------------------------------------------------- topbar */

  private wireTopbar(root: HTMLElement) {
    const nameInput = qs<HTMLInputElement>('#project-name', root)!;
    on(nameInput, 'change', () => this.store.mutate((s) => { s.name = nameInput.value || 'Untitled world'; }, 'Rename project'));
    const search = qs<HTMLInputElement>('#library-search', root)!;
    on(search, 'input', () => {
      if (this.railCollapsed) this.toggleRail();
      this.rail.setOpen('assets');
      this.assetPanel.setQuery(search.value);
    });
    const category = qs<HTMLSelectElement>('#category-picker', root)!;
    on(category, 'change', () => {
      const chosen = category.value;
      if (this.railCollapsed) this.toggleRail();
      this.rail.setOpen('assets');
      this.assetPanel.setCategory(chosen);
    });
    on(qs('#panel-picker', root), 'change', () => { if (this.railCollapsed) this.toggleRail(); });

    qsa<HTMLElement>('.layer-tab', root).forEach((b) => on(b, 'click', () => {
      this.setLayer(b.dataset.layer as LayerId);
    }));

    on(qs('#btn-play', root), 'click', () => this.preview.toggle());
    on(qs('#btn-restart', root), 'click', () => this.preview.restart());
    on(qs('#btn-rail', root), 'click', () => this.toggleRail());
    on(qs('#btn-export', root), 'click', () => this.openExport());
    on(qs('#loop-chip', root), 'click', () => {
      const r = this.loops.analyse(this.store.scene);
      this.store.status(r.animated
        ? `${r.animated} animated objects. Master cycle ${r.master}s - ${r.exact ? 'returns exactly to its start, so it can be tiled seamlessly.' : 'harmonised, not an exact return; long exports render every frame.'}`
        : 'Nothing is animating yet.', r.exact ? 'info' : 'warn');
    });
    on(qs('#btn-zoom-in', root), 'click', () => { this.stage.setZoom(this.stage.zoom * 1.25); this.updateHud(); });
    on(qs('#btn-zoom-out', root), 'click', () => { this.stage.setZoom(this.stage.zoom / 1.25); this.updateHud(); });
    on(qs('#btn-fit', root), 'click', () => { this.stage.resetView(); this.stage.refit(); this.updateHud(); });

    this.store.on('playback', () => {
      const btn = qs<HTMLElement>('#btn-play', root);
      if (btn) btn.innerHTML = icon(this.preview.playing ? 'pause' : 'play', 14);
    });
  }

  setLayer(layer: LayerId) {
    this.activeLayer = layer;
    qsa<HTMLElement>('.layer-tab').forEach((b) => b.classList.toggle('active', b.dataset.layer === layer));
    this.assetPanel.setLayer(layer);
    this.rail.setOpen('assets');
    this.assetPanel.render();
    this.rail.sync();
  }

  get layer() { return this.activeLayer; }

  private get railCollapsed() {
    return qs('.app')?.classList.contains('rail-hidden') ?? false;
  }

  toggleRail() {
    const app = qs<HTMLElement>('.app');
    if (!app) return;
    app.classList.toggle('rail-hidden');
    const hidden = app.classList.contains('rail-hidden');
    const btn = qs<HTMLElement>('#btn-rail');
    if (btn) btn.innerHTML = icon(hidden ? 'left' : 'right', 14);
    // The canvas changed size, so re-fit the view rather than leaving it clipped.
    requestAnimationFrame(() => { this.stage.refit(); this.preview.invalidate(); this.updateHud(); });
  }

  /* ------------------------------------------------------------- keyboard */

  private wireKeyboard() {
    this.windowListeners.push(on(window, 'keydown', (e) => {
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        if (e.repeat) return;
        this.stage.setSpace(true);
        return;
      }
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.store.redo() : this.store.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.store.redo(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.store.duplicateSelected(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void this.save(e.shiftKey); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openProjects(); return; }
      if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); this.openExport(); return; }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.store.select(this.store.scene.nodes.filter((n) => !n.locked && n.kind === 'asset').map((n) => n.id));
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.store.removeSelected(); return; }
      if (e.key === 'Escape') { this.menubar.close(); this.store.select([]); this.setSolo(null); return; }
      if (e.key === '\\') { e.preventDefault(); this.toggleRail(); return; }
      if (e.key >= '1' && e.key <= '4') { this.setLayer(LAYERS[Number(e.key) - 1]); return; }
      if (e.key.toLowerCase() === 'l') { this.toggleSelected('locked'); return; }
      if (e.key.toLowerCase() === 'h') { this.toggleSelected('visible'); return; }
      if (e.key.toLowerCase() === 'f') { this.stage.resetView(); this.stage.refit(); this.updateHud(); return; }
      if (e.key.startsWith('Arrow')) {
        const sel = this.store.selected.filter((n) => !n.locked);
        if (!sel.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 20 : 2;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this.store.mutate(() => { sel.forEach((n) => { n.x += dx; n.y += dy; }); }, 'Nudge');
      }
    }));
    this.windowListeners.push(on(window, 'keyup', (e) => {
      if (e.code === 'Space') {
        this.stage.setSpace(false);
        if (!(e.target as HTMLElement)?.matches?.('input, textarea, select')) this.preview.toggle();
      }
    }));
  }

  private toggleSelected(key: 'locked' | 'visible') {
    const sel = this.store.selected;
    if (!sel.length) { this.store.status('Select an object first.', 'info'); return; }
    const value = !sel[sel.length - 1][key];
    this.store.mutate(() => { sel.forEach((n) => { n[key] = value; }); },
      key === 'locked' ? (value ? 'Lock' : 'Unlock') : (value ? 'Show' : 'Hide'));
  }

  /* ---------------------------------------------------------------- store */

  private wireStore(root: HTMLElement) {
    this.store.on('scene', () => {
      if (this.soloNode && !this.store.node(this.soloNode)) {
        this.soloNode = null;
        this.preview.soloNode = null;
        this.preview.invalidate();
      }
      this.refreshChrome();
      this.loops.invalidate();
      this.rail.sync();
    });
    this.store.on('selection', () => {
      if (this.objectPanel.active) this.objectPanel.render();
      if (this.animatePanel.active) this.animatePanel.render();
      this.refreshChrome();
      this.rail.sync();
    });
    this.store.on('status', (payload) => { if (payload) this.toast(payload as StatusMessage); });
    void root;
  }

  private refreshChrome() {
    const scene = this.store.scene;
    const nameInput = qs<HTMLInputElement>('#project-name');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = scene.name;
    const empty = qs<HTMLElement>('#stage-empty');
    if (empty) empty.hidden = scene.nodes.length > 0;
    this.updateHud();
  }

  private updateHud() {
    const report = this.loops.analyse(this.store.scene);
    const hud = qs<HTMLElement>('#stage-hud');
    if (hud) {
      const s = this.preview.stats;
      const style = this.library.style(this.store.scene.styleId);
      hud.innerHTML = `<span>${escapeHtml(style?.name ?? this.store.scene.styleId)}</span>
        <span>${this.store.scene.canvas.width}x${this.store.scene.canvas.height}</span>
        <span><b>${this.store.scene.nodes.length}</b> objects</span>
        <span><b>${s.renderMs.toFixed(1)}ms</b>/frame</span>
        <span>${this.store.dirty ? 'unsaved' : 'saved'}</span>
        ${this.soloLabel() ? `<span class="hud-solo"><b>SOLO</b> ${escapeHtml(this.soloLabel()!)}</span>` : ''}`;
    }
    const loopText = qs<HTMLElement>('#loop-text');
    const chip = qs<HTMLElement>('#loop-chip');
    if (loopText) {
      loopText.textContent = report.animated
        ? `${report.master}s ${report.exact ? 'exact' : 'harmonised'}`
        : 'static';
    }
    chip?.classList.toggle('warn', report.animated > 0 && !report.exact);
    const zoom = qs<HTMLElement>('#zoom-value');
    if (zoom) zoom.textContent = `${this.stage.zoomPercent}%`;
  }

  /* -------------------------------------------------------------- actions */

  private addAsset(assetId: string, at?: { x: number; y: number }) {
    const meta = this.library.get(assetId);
    if (!meta) { this.store.status('That artwork is not in the library.', 'error'); return; }
    const scene = this.store.scene;
    if (meta.style !== scene.styleId && meta.style !== 'universal') {
      this.store.status(`"${meta.name}" belongs to another style and cannot be mixed into layers 1-3.`, 'warn');
      return;
    }
    if (meta.layer === 'background') {
      const existing = scene.nodes.filter((n) => n.layer === 'background');
      this.store.pushHistory('Set background');
      // Choosing a background is an explicit decision, so it replaces the current
      // one whether or not it was locked. Nothing else is forced: the designer
      // stays on whichever layer they are working in.
      scene.nodes = scene.nodes.filter((n) => n.layer !== 'background');
      if (collectionId(scene.theme) === 'all') scene.theme = worldForBackground(meta);
      const node = createAssetNode(meta, scene);
      node.locked = true;
      scene.nodes.push(node);
      this.store.mutate(() => {});
      this.store.select(node.id);
      void this.images.ensure([meta.id]).then(() => this.preview.invalidate());
      this.store.status(`Background set to ${meta.name}${existing.length ? ' (replaced the previous background)' : ''}.`, 'success');
      return;
    }
    // Room views are full-frame overlays even when dragged from the library;
    // users can reposition them afterwards with the normal transform tools.
    const position = at && meta.rig?.type !== 'window-overlay'
      ? { x: at.x, y: at.y + node0Height(meta, scene) / 2 } : undefined;
    const node = createAssetNode(meta, scene, position);
    // Interiors share Layer 4 with atmosphere. Existing saved rooms retain
    // their original layer; newly placed rooms and props can be reordered
    // together with effects in the On canvas panel.
    if (meta.category === 'interiors') {
      node.layer = 'atmosphere';
      node.order = nextOrder(scene, 'atmosphere');
    }
    this.store.addNode(node, `Add ${meta.name}`);
    if (node.animation?.enabled && !this.preview.playing) this.preview.play();
    void this.images.ensure([meta.id]).then(() => this.preview.invalidate());
  }

  private addEffect(effectId: string, at?: { x: number; y: number }) {
    const def = EFFECT_MAP.get(effectId);
    if (!def) return;
    const scene = this.store.scene;
    const order = nextOrder(scene, 'atmosphere');
    const node = makeEffectNode(effectId, scene, order);
    if (at) {
      node.x = at.x; node.y = at.y;
      if (def.family !== 'spiritual') {
        node.width = scene.canvas.width * 0.5;
        node.height = scene.canvas.height * 0.5;
      }
    }
    this.store.addNode(node, `Add ${def.name}`);
    if (!this.preview.playing) this.preview.play();
    this.store.status(`${def.name} placed on layer 4. Double-click it to adjust. Effects work in every style.`, 'success');
  }

  private applyTheme(themeId: string) {
    const preset = THEME_PRESETS.find((t) => t.id === themeId);
    if (!preset) return;
    this.store.pushHistory(`Apply ${preset.name}`);
    let order = nextOrder(this.store.scene, 'atmosphere');
    for (const e of preset.effects) {
      if (!EFFECT_MAP.has(e.id)) continue;
      const node = makeEffectNode(e.id, this.store.scene, order++);
      node.effect!.params = { ...effectDefaults(e.id), ...(e.params ?? {}) };
      if (e.loop) node.effect!.loop = e.loop;
      this.store.scene.nodes.push(node);
    }
    this.store.mutate(() => {});
    if (!this.preview.playing) this.preview.play();
    this.store.status(`${preset.name}: ${preset.effects.length} effects placed. Every setting stays editable.`, 'success');
  }

  private replaceAsset(node: SceneNode, meta: AssetMeta) {
    this.store.pushHistory('Replace artwork');
    const ratio = meta.width / meta.height;
    node.assetId = meta.id;
    node.name = meta.name;
    node.width = node.height * ratio;
    node.crop = { x: 0, y: 0, w: 1, h: 1 };
    this.store.mutate(() => {});
    void this.images.ensure([meta.id]).then(() => this.preview.invalidate());
    this.store.status(`Replaced with ${meta.name}. Position, animation and colour settings kept.`, 'success');
  }

  private openCrop(node: SceneNode) {
    const meta = this.library.get(node.assetId);
    if (!meta) return;
    cropDialog(node, meta, this.library.url(meta), (crop) => {
      this.store.pushHistory('Crop image');
      const old = node.crop;
      const scaleX = node.width / old.w;
      const scaleY = node.height / old.h;
      const dcx = (crop.x + crop.w / 2) - (old.x + old.w / 2);
      const dcy = (crop.y + crop.h / 2) - (old.y + old.h / 2);
      const a = node.rotation * Math.PI / 180;
      const ox = dcx * scaleX, oy = dcy * scaleY;
      node.x += ox * Math.cos(a) - oy * Math.sin(a);
      node.y += ox * Math.sin(a) + oy * Math.cos(a);
      node.width = crop.w * scaleX;
      node.height = crop.h * scaleY;
      node.crop = crop;
      this.store.mutate(() => {});
    });
  }

  private soloLabel(): string | null {
    if (this.soloNode) return this.store.node(this.soloNode)?.name ?? 'object';
    if (this.preview.soloLayer) return `${LAYER_LABEL[this.preview.soloLayer as LayerId]} layer`;
    return null;
  }

  private setSolo(node: SceneNode | null) {
    this.soloNode = node?.id ?? null;
    this.preview.soloNode = this.soloNode;
    this.preview.soloLayer = null;
    this.preview.invalidate();
    this.updateHud();
    this.store.status(node ? `Previewing "${node.name}" on its own.` : 'Showing all four layers.', 'info');
  }

  private setSoloLayer(layer: LayerId | null) {
    this.soloNode = null;
    this.preview.soloNode = null;
    this.preview.soloLayer = layer;
    this.preview.invalidate();
    this.updateHud();
    this.store.status(layer ? `Previewing the ${LAYER_LABEL[layer]} layer only.` : 'Showing all four layers.', 'info');
  }

  private doRegenerate() {
    this.store.pushHistory('Rearrange unlocked');
    const r = regenerate(this.store.scene, this.library, { ...DEFAULT_COMPOSE, foreground: 0.6 });
    this.store.mutate(() => {});
    this.afterSceneSwap();
    this.store.status(`Rearranged: ${r.added} new placements, ${r.kept} locked objects untouched.`, 'success');
  }

  private afterSceneSwap() {
    this.assetPanel.render();
    void this.images.ensure(this.store.scene.nodes.map((n) => n.assetId)).then(() => this.preview.invalidate());
    this.loops.invalidate();
    this.stage.refit();
    if (this.layersPanel.active) this.layersPanel.render();
    if (this.scenePanel.active) this.scenePanel.render();
    if (this.objectPanel.active) this.objectPanel.render();
    if (this.animatePanel.active) this.animatePanel.render();
    this.rail.sync();
    this.refreshChrome();
  }

  /* -------------------------------------------------------------- projects */

  private newWorld() { this.openWorldPicker(false); }

  /**
   * The world picker. On first launch it cannot be dismissed with Escape or a
   * backdrop click, because the app starts with nothing in it.
   */
  private openWorldPicker(first: boolean) {
    this.worldDialog = newWorldDialog(this.library, {
      currentStyle: this.store.scene.styleId,
      title: first ? 'Choose a world' : 'New world',
      subtitle: 'Every world starts with its background only. Add the rest yourself.',
      dismissable: !first,
      onCreate: (worldId, styleId, aspect, name, start) => this.startWorld(worldId, styleId, aspect, name, start),
    });
  }

  /** Replace the scene with a new world. A plain background unless the designer asked for a sketch. */
  startWorld(worldId: string, styleId: string, aspect: string, name: string, start: StartingPoint = 'background') {
    const scene = start === 'background'
      ? createWorldScene(this.library, { worldId, styleId, aspect, name })
      : buildDemoScene(this.library, { styleId, aspect, name, withEffects: start === 'demo', composed: true, worldId });
    scene.name = name;
    this.store.replaceScene(scene);
    this.store.lastSavedName = name;
    this.worldDialog?.close();
    this.worldDialog = null;
    this.afterSceneSwap();
    this.setLayer('background');
    this.preview.restart();
    this.store.status(`"${name}" started with its background. Add trees, rocks, flowers and effects from the library.`, 'success');
  }

  private openProjects() {
    projectsDialog(this.shelf, {
      onOpen: async (id) => {
        try {
          const loaded = await this.shelf.open(id);
          if (!loaded) { this.store.status('That project could not be found.', 'error'); return; }
          await this.adoptProject(loaded);
        } catch (err) {
          this.store.status(`Could not open project: ${(err as Error).message}`, 'error');
        }
      },
      onDelete: async (id) => { await this.shelf.remove(id); },
      onOpenFile: () => this.openFile(),
      onSaveNow: async () => {
        await this.shelf.save(this.store.scene, await this.preview.thumbnail());
        this.store.status('Saved to the browser project shelf.', 'success');
      },
    });
  }

  private openFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sceneproject,application/zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const loaded = await openProjectFromFile(file, this.library);
        await this.adoptProject(loaded);
      } catch (err) {
        this.store.status(`Could not open file: ${(err as Error).message}`, 'error');
      }
    };
    input.click();
  }

  private async adoptProject(loaded: LoadedProject) {
    const { scene, missingAssets: missing, warnings } = loaded;
    // Put the embedded sound where the preview player looks for it, before the
    // scene swap triggers the player to load it.
    if (loaded.sound && scene.audio) await registerAudioBlob(scene.audio, loaded.sound);
    this.store.replaceScene(scene);
    this.afterSceneSwap();
    this.preview.restart();
    const notes = [...warnings];
    if (missing.length) notes.push(`${missing.length} asset(s) missing: ${missing.slice(0, 3).join(', ')}`);
    this.store.status(
      `Opened "${scene.name}" - ${scene.nodes.length} objects restored.${notes.length ? ` ${notes.join(' ')}` : ''}`,
      missing.length ? 'warn' : 'success',
    );
  }

  private async save(saveAs: boolean) {
    try {
      const scene = this.store.scene;
      if (saveAs) {
        const name = window.prompt('Save a copy as:', `${scene.name} v2`);
        if (!name) return;
        const copy = structuredClone(scene);
        copy.id = `scene_${Date.now().toString(36)}`;
        copy.name = name;
        copy.createdAt = new Date().toISOString();
        this.store.replaceScene(copy);
      }
      const preview = await this.preview.thumbnail();
      const blob = await saveProjectToFile(this.store.scene, this.library, preview);
      await this.shelf.save(this.store.scene, preview);
      this.store.dirty = false;
      this.store.lastSavedName = this.store.scene.name;
      this.refreshChrome();
      this.store.status(
        `${saveAs ? 'Saved a copy' : 'Project saved'} - ${this.store.scene.name}.sceneproject (${blob.size > 1e6 ? `${(blob.size / 1e6).toFixed(1)} MB` : `${Math.round(blob.size / 1024)} KB`}). Artwork included; every layer stays editable.`,
        'success',
      );
    } catch (err) {
      this.store.status(`Save failed: ${(err as Error).message}`, 'error');
    }
  }

  private async autosave() {
    if (!this.store.dirty || !this.shelf.available) return;
    try {
      await this.shelf.save(this.store.scene, await this.preview.thumbnail(320));
    } catch (err) {
      console.warn('[autosave] failed', err);
    }
  }

  /* --------------------------------------------------------------- toasts */

  private toast(msg: StatusMessage) {
    const root = qs<HTMLElement>('.toast-root');
    if (!root) return;
    const node = el<HTMLElement>(`<div class="toast ${msg.tone}">
      <span class="toast-dot"></span><span>${escapeHtml(msg.text)}</span>
    </div>`);
    root.appendChild(node);
    const life = msg.tone === 'error' ? 8000 : 4200;
    setTimeout(() => {
      node.style.transition = 'opacity 0.3s, transform 0.3s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 320);
    }, life);
    while (root.children.length > 4) root.firstElementChild?.remove();
  }

  dispose() {
    this.windowListeners.splice(0).forEach((remove) => remove());
    window.clearInterval(this.autosaveTimer);
    window.clearInterval(this.hudTimer);
    this.menubar?.dispose();
    this.soundPanel?.dispose();
    this.preview.dispose();
    this.stage.dispose();
    this.images.clear();
  }

  /** Exposed for debugging in the console and for automated checks. */
  debug() {
    return {
      scene: this.store.scene,
      loop: this.loops.analyse(this.store.scene),
      images: this.images.stats,
      preview: this.preview.stats,
      library: { styles: this.library.styles.length, assets: this.library.assets.length },
      switchStyle: (id: string) => switchStyle(this.store.scene, this.library, id),
      download: (blob: Blob, name: string) => downloadBlob(blob, name),
      clamp,
    };
  }
}

function node0Height(meta: AssetMeta, scene: Scene): number {
  return scene.canvas.height * meta.defaultScale;
}
