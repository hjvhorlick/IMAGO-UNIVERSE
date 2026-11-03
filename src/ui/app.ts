/**
 * APPLICATION SHELL
 * =================
 * Builds the interface and wires the independent modules together. Nothing in
 * here contains rendering, animation or export logic - it only connects them.
 */
import { AssetLibrary } from '../assets/library';
import { Store } from '../core/store';
import type { StatusMessage } from '../core/store';
import type { AssetMeta, Scene, SceneNode } from '../core/types';
import { LAYER_LABEL } from '../core/types';
import { clamp, downloadBlob, formatTime } from '../core/util';
import { ImageCache } from '../render/imageCache';
import { Compositor } from '../render/compositor';
import { PreviewRenderer } from '../render/previewRenderer';
import { LoopManager, loopManager } from '../animation/loopManager';
import { EFFECT_MAP, THEME_PRESETS, effectDefaults } from '../animation/effects';
import { ExportManager } from '../export/exportManager';
import { ProjectShelf, openProjectFromFile, saveProjectToFile } from '../project/projectShelf';
import { autoCompose, DEFAULT_COMPOSE, regenerate } from '../scene/composition';
import { createAssetNode, createScene } from '../scene/sceneModel';
import { buildDemoScene } from '../scene/demoScene';
import { switchStyle } from '../scene/styleManager';
import { AssetPanel } from './assetPanel';
import { LayersPanel } from './layersPanel';
import { Inspector, makeEffectNode } from './inspector';
import { ScenePanel } from './scenePanel';
import { Stage } from './stage';
import { el, escapeHtml, icon, on, qs, qsa } from './dom';
import {
  aboutDialog, changeStyleDialog, composeDialog, cropDialog, exportDialog, historyDialog,
  importDialog, newWorldDialog, projectsDialog, replaceDialog,
} from './dialogs';

const SHELL = `
<div class="app">
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark"></div>
      <div class="brand-text">
        <span class="brand-title">IMAGO UNIVERSE</span>
        <span class="brand-sub">Create worlds</span>
      </div>
    </div>
    <div class="project-meta">
      <input class="project-name" id="project-name" value="Untitled world" spellcheck="false" aria-label="Project name">
      <button class="style-chip" id="style-chip" title="Change artistic style"></button>
    </div>
    <div class="topbar-actions">
      <button class="btn icon" id="btn-undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
      <button class="btn icon" id="btn-redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
      <button class="btn icon" id="btn-history" title="History">${icon('history')}</button>
      <span class="divider"></span>
      <button class="btn" id="btn-new" title="New world">${icon('plus', 13)} New</button>
      <button class="btn" id="btn-open" title="Open project">${icon('folder', 13)} Open</button>
      <button class="btn" id="btn-save" title="Save project file (Ctrl+S)">${icon('save', 13)} Save</button>
      <button class="btn" id="btn-saveas" title="Save a copy under a new name">${icon('copy', 13)} Save As</button>
      <span class="divider"></span>
      <button class="btn primary" id="btn-export">${icon('download', 13)} Export</button>
      <button class="btn icon ghost" id="btn-about" title="About and shortcuts">${icon('info')}</button>
    </div>
  </header>

  <main class="workspace">
    <aside class="panel panel-left" id="panel-left"></aside>

    <section class="stage-wrap">
      <div class="stage-toolbar">
        <div class="tool-group">
          <button class="btn small" id="btn-compose">${icon('wand', 12)} Auto-compose</button>
          <button class="btn small" id="btn-regen" title="Rearrange everything that is not locked">${icon('dice', 12)} Rearrange</button>
        </div>
        <span class="divider"></span>
        <div class="tool-group">
          <button class="btn icon small" id="btn-zoom-out" title="Zoom out">${icon('zoomOut', 12)}</button>
          <span class="zoom-value" id="zoom-value">100%</span>
          <button class="btn icon small" id="btn-zoom-in" title="Zoom in">${icon('zoomIn', 12)}</button>
          <button class="btn small" id="btn-fit" title="Fit to view">${icon('fit', 12)} Fit</button>
        </div>
        <span class="divider"></span>
        <div class="tool-group">
          <button class="btn small active" id="btn-clip" title="Canvas cropping: cut oversized objects at the canvas edge">${icon('crop', 12)} Clip to canvas</button>
          <button class="btn small" id="btn-solo-off" title="Show every layer">${icon('layers', 12)} All layers</button>
        </div>
        <span class="divider"></span>
        <div class="tool-group">
          <span class="tool-label">Selection</span>
          <button class="btn icon small" id="btn-dup" title="Duplicate (Ctrl+D)">${icon('copy', 12)}</button>
          <button class="btn icon small" id="btn-lock" title="Lock / unlock (L)">${icon('lock', 12)}</button>
          <button class="btn icon small" id="btn-hide" title="Hide / show (H)">${icon('eye', 12)}</button>
          <button class="btn icon small" id="btn-del" title="Delete (Del)">${icon('trash', 12)}</button>
        </div>
      </div>

      <div class="stage">
        <div class="canvas-holder">
          <canvas id="scene-canvas"></canvas>
          <canvas id="overlay-canvas"></canvas>
        </div>
        <div class="stage-hud" id="stage-hud"></div>
      </div>

      <div class="transport">
        <div class="transport-buttons">
          <button class="play-btn" id="btn-play" title="Play / pause (Space)">${icon('play', 15)}</button>
          <button class="btn icon" id="btn-restart" title="Restart">${icon('restart', 13)}</button>
        </div>
        <span class="time-readout" id="time-readout">0:00.0</span>
        <div class="scrub">
          <input type="range" id="scrubber" min="0" max="60" step="0.05" value="0" aria-label="Timeline">
        </div>
        <div class="loop-info" id="loop-info"><span class="loop-dot"></span><span id="loop-text">Loop ready</span></div>
      </div>
    </section>

    <aside class="panel panel-right">
      <div class="panel-tabs">
        <button class="panel-tab active" data-rtab="layers">Layers</button>
        <button class="panel-tab" data-rtab="object">Object</button>
        <button class="panel-tab" data-rtab="animate">Animate</button>
        <button class="panel-tab" data-rtab="scene">Scene</button>
      </div>
      <div class="panel-body" id="right-body"></div>
    </aside>
  </main>

  <div class="statusbar">
    <span class="status-item" id="status-style"></span>
    <span class="status-item" id="status-canvas"></span>
    <span class="status-item" id="status-objects"></span>
    <span class="spacer"></span>
    <span class="status-item" id="status-perf"></span>
    <span class="status-item" id="status-saved"></span>
  </div>
</div>
<div class="modal-root"></div>
<div class="toast-root"></div>
`;

export class App {
  store!: Store;
  library = new AssetLibrary();
  images!: ImageCache;
  loops: LoopManager = loopManager;
  compositor!: Compositor;
  preview!: PreviewRenderer;
  stage!: Stage;
  exports!: ExportManager;
  shelf!: ProjectShelf;

  private assetPanel!: AssetPanel;
  private layersPanel!: LayersPanel;
  private inspector!: Inspector;
  private scenePanel!: ScenePanel;
  private rightTab: 'layers' | 'object' | 'animate' | 'scene' = 'layers';
  private rightBody!: HTMLElement;
  private autosaveTimer = 0;
  private soloNode: string | null = null;

  async mount(root: HTMLElement) {
    root.innerHTML = SHELL;
    await this.library.load();

    const scene = buildDemoScene(this.library, { withEffects: true });
    this.store = new Store(scene);
    this.images = new ImageCache(this.library);
    this.compositor = new Compositor(this.library, this.images, this.loops);
    const canvas = qs<HTMLCanvasElement>('#scene-canvas', root)!;
    this.preview = new PreviewRenderer(canvas, this.store, this.compositor, this.images);
    this.exports = new ExportManager(this.compositor, this.images, this.library, this.loops, this.library);
    this.shelf = new ProjectShelf(this.library);
    await this.shelf.init();

    this.rightBody = qs<HTMLElement>('#right-body', root)!;
    this.buildPanels(root);
    this.buildStage(root);
    this.wireToolbar(root);
    this.wireTransport(root);
    this.wireKeyboard();
    this.wireStore(root);

    await this.images.ensure(scene.nodes.map((n) => n.assetId));
    this.stage.refit();
    this.preview.invalidate();
    this.refreshChrome();
    this.preview.play();

    this.autosaveTimer = window.setInterval(() => { void this.autosave(); }, 45_000);
    window.addEventListener('beforeunload', (e) => {
      if (this.store.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
    setInterval(() => this.updateHud(), 500);
  }

  /* --------------------------------------------------------------- panels */

  private buildPanels(root: HTMLElement) {
    this.assetPanel = new AssetPanel(qs<HTMLElement>('#panel-left', root)!, this.store, this.library, {
      onAddAsset: (id) => this.addAsset(id),
      onAddEffect: (id) => this.addEffect(id),
      onApplyTheme: (id) => this.applyTheme(id),
      onImport: () => importDialog(this.library, this.store.scene.styleId, (meta) => {
        this.store.emit('library');
        this.store.status(`Imported "${meta.name}" into ${LAYER_LABEL[meta.layer]}.`, 'success');
      }),
      onChangeStyle: () => changeStyleDialog(this.store, this.library, () => this.afterSceneSwap()),
    });

    this.layersPanel = new LayersPanel(this.rightBody, this.store, this.library);
    this.inspector = new Inspector(this.rightBody, this.store, this.library, {
      onCrop: (node) => this.openCrop(node),
      onReplace: (node) => replaceDialog(node, this.store, this.library, (meta) => this.replaceAsset(node, meta)),
      onSoloAnimation: (node) => this.setSolo(node),
    });
    this.scenePanel = new ScenePanel(this.rightBody, this.store, this.library, this.preview, this.images, {
      onCompose: () => composeDialog(this.store, (opts) => {
        this.store.pushHistory('Auto-compose');
        const result = autoCompose(this.store.scene, this.library, opts);
        this.store.mutate(() => {});
        this.afterSceneSwap();
        this.store.status(`Composed ${result.added} objects, kept ${result.kept} locked.`, 'success');
      }),
      onRegenerate: () => this.doRegenerate(),
    });

    qsa<HTMLElement>('[data-rtab]', root).forEach((b) => on(b, 'click', () => {
      this.rightTab = b.dataset.rtab as typeof this.rightTab;
      qsa<HTMLElement>('[data-rtab]', root).forEach((x) => x.classList.toggle('active', x === b));
      this.renderRight();
    }));
    this.renderRight();
  }

  private renderRight() {
    this.rightBody.innerHTML = '';
    // Only the visible panel may react to store events, otherwise all three
    // would fight over the same container.
    this.layersPanel.active = this.rightTab === 'layers';
    this.scenePanel.active = this.rightTab === 'scene';
    this.inspector.active = this.rightTab === 'object' || this.rightTab === 'animate';
    if (this.rightTab === 'layers') this.layersPanel.render();
    else if (this.rightTab === 'scene') this.scenePanel.render();
    else this.inspector.setMode(this.rightTab === 'animate' ? 'animate' : 'object');
  }

  private buildStage(root: HTMLElement) {
    this.stage = new Stage(root, this.store, this.preview, {
      onDropAsset: (id, x, y) => this.addAsset(id, { x, y }),
      onDropEffect: (id, x, y) => this.addEffect(id, { x, y }),
      onDoubleClick: (node) => {
        if (!node) return;
        this.rightTab = node.kind === 'effect' ? 'animate' : 'object';
        qsa<HTMLElement>('[data-rtab]', root).forEach((x) =>
          x.classList.toggle('active', x.dataset.rtab === this.rightTab));
        this.renderRight();
      },
    });
  }

  /* -------------------------------------------------------------- toolbar */

  private wireToolbar(root: HTMLElement) {
    const nameInput = qs<HTMLInputElement>('#project-name', root)!;
    on(nameInput, 'change', () => this.store.mutate((s) => { s.name = nameInput.value || 'Untitled world'; }, 'Rename project'));
    on(qs('#style-chip', root), 'click', () => changeStyleDialog(this.store, this.library, () => this.afterSceneSwap()));
    on(qs('#btn-undo', root), 'click', () => { if (!this.store.undo()) this.store.status('Nothing to undo.', 'info'); });
    on(qs('#btn-redo', root), 'click', () => { if (!this.store.redo()) this.store.status('Nothing to redo.', 'info'); });
    on(qs('#btn-history', root), 'click', () => historyDialog(this.store));
    on(qs('#btn-new', root), 'click', () => this.newWorld());
    on(qs('#btn-open', root), 'click', () => this.openProjects());
    on(qs('#btn-save', root), 'click', () => { void this.save(false); });
    on(qs('#btn-saveas', root), 'click', () => { void this.save(true); });
    on(qs('#btn-export', root), 'click', () => exportDialog(
      this.store, this.exports, this.shelf, () => this.preview.thumbnail(), () => this.preview.time,
    ));
    on(qs('#btn-about', root), 'click', () => aboutDialog());

    on(qs('#btn-compose', root), 'click', () => composeDialog(this.store, (opts) => {
      this.store.pushHistory('Auto-compose');
      const r = autoCompose(this.store.scene, this.library, opts);
      this.store.mutate(() => {});
      this.afterSceneSwap();
      this.store.status(`Composed ${r.added} objects, kept ${r.kept} locked.`, 'success');
    }));
    on(qs('#btn-regen', root), 'click', () => this.doRegenerate());
    on(qs('#btn-zoom-in', root), 'click', () => { this.stage.setZoom(this.stage.zoom * 1.25); this.updateHud(); });
    on(qs('#btn-zoom-out', root), 'click', () => { this.stage.setZoom(this.stage.zoom / 1.25); this.updateHud(); });
    on(qs('#btn-fit', root), 'click', () => { this.stage.resetView(); this.stage.refit(); this.updateHud(); });
    on(qs('#btn-clip', root), 'click', () => {
      this.store.mutate((s) => { s.canvas.clipToCanvas = !s.canvas.clipToCanvas; }, 'Toggle canvas clipping');
      this.refreshChrome();
    });
    on(qs('#btn-solo-off', root), 'click', () => this.setSolo(null));
    on(qs('#btn-dup', root), 'click', () => this.store.duplicateSelected());
    on(qs('#btn-del', root), 'click', () => this.store.removeSelected());
    on(qs('#btn-lock', root), 'click', () => this.toggleSelected('locked'));
    on(qs('#btn-hide', root), 'click', () => this.toggleSelected('visible'));
  }

  private toggleSelected(key: 'locked' | 'visible') {
    const sel = this.store.selected;
    if (!sel.length) { this.store.status('Select an object first.', 'info'); return; }
    const value = !sel[sel.length - 1][key];
    this.store.mutate(() => { sel.forEach((n) => { n[key] = value; }); },
      key === 'locked' ? (value ? 'Lock' : 'Unlock') : (value ? 'Show' : 'Hide'));
  }

  /* ------------------------------------------------------------ transport */

  private wireTransport(root: HTMLElement) {
    const playBtn = qs<HTMLElement>('#btn-play', root)!;
    const scrub = qs<HTMLInputElement>('#scrubber', root)!;
    on(playBtn, 'click', () => this.preview.toggle());
    on(qs('#btn-restart', root), 'click', () => this.preview.restart());
    on(scrub, 'input', () => { this.preview.pause(); this.preview.seek(parseFloat(scrub.value)); });
    this.store.on('playback', () => {
      playBtn.innerHTML = icon(this.preview.playing ? 'pause' : 'play', 15);
      const report = this.loops.analyse(this.store.scene);
      const span = Math.max(report.master * 2, 12);
      scrub.max = String(span);
      if (document.activeElement !== scrub) scrub.value = String(this.preview.time % span);
      qs<HTMLElement>('#time-readout', root)!.textContent =
        `${formatTime(this.preview.time % span)} / ${formatTime(span)}`;
    });
  }

  /* ------------------------------------------------------------- keyboard */

  private wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
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
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        exportDialog(this.store, this.exports, this.shelf, () => this.preview.thumbnail(), () => this.preview.time);
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.store.select(this.store.scene.nodes.filter((n) => !n.locked && n.kind === 'asset').map((n) => n.id));
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.store.removeSelected(); return; }
      if (e.key === 'Escape') { this.store.select([]); this.setSolo(null); return; }
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
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.stage.setSpace(false);
        if (!(e.target as HTMLElement)?.matches?.('input, textarea')) this.preview.toggle();
      }
    });
  }

  /* ---------------------------------------------------------------- store */

  private wireStore(root: HTMLElement) {
    this.store.on('scene', () => { this.refreshChrome(); this.loops.invalidate(); });
    this.store.on('selection', () => {
      if (this.rightTab === 'object' || this.rightTab === 'animate') this.inspector.render();
      this.refreshChrome();
    });
    this.store.on('history', () => {
      (qs<HTMLButtonElement>('#btn-undo', root)!).disabled = !this.store.past.length;
      (qs<HTMLButtonElement>('#btn-redo', root)!).disabled = !this.store.future.length;
    });
    this.store.on('status', (payload) => {
      if (payload) this.toast(payload as StatusMessage);
    });
    this.store.emit('history');
  }

  private refreshChrome() {
    const scene = this.store.scene;
    const style = this.library.style(scene.styleId);
    const nameInput = qs<HTMLInputElement>('#project-name');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = scene.name;
    const chip = qs<HTMLElement>('#style-chip');
    if (chip) {
      chip.innerHTML = `<span class="swatches">${(style?.swatches ?? []).slice(0, 4)
        .map((c) => `<span class="swatch" style="background:${c}"></span>`).join('')}</span>
        ${escapeHtml(style?.name ?? scene.styleId)}`;
    }
    const clip = qs<HTMLElement>('#btn-clip');
    clip?.classList.toggle('active', scene.canvas.clipToCanvas);
    const set = (id: string, text: string) => { const n = qs<HTMLElement>(id); if (n) n.textContent = text; };
    set('#status-style', `Style: ${style?.name ?? scene.styleId}`);
    set('#status-canvas', `${scene.canvas.width} x ${scene.canvas.height} (${scene.canvas.aspect})`);
    set('#status-objects', `${scene.nodes.length} objects`);
    set('#status-saved', this.store.dirty ? 'Unsaved changes' : 'Saved');
    this.updateHud();
  }

  private updateHud() {
    const report = this.loops.analyse(this.store.scene);
    const hud = qs<HTMLElement>('#stage-hud');
    if (hud) {
      const s = this.preview.stats;
      hud.innerHTML = `<span><b>${this.stage.zoomPercent}%</b> zoom</span>
        <span><b>${s.renderMs.toFixed(1)}ms</b> frame</span>
        <span><b>${this.store.scene.nodes.length}</b> objects</span>
        ${this.soloNode ? '<span style="color:var(--accent)"><b>SOLO</b> preview</span>' : ''}`;
    }
    const perf = qs<HTMLElement>('#status-perf');
    if (perf) perf.textContent = `${this.preview.stats.renderMs.toFixed(1)} ms/frame - ${this.images.stats.count} assets cached`;
    const loopText = qs<HTMLElement>('#loop-text');
    const dot = qs<HTMLElement>('#loop-info .loop-dot');
    if (loopText) {
      loopText.textContent = report.animated
        ? `${report.master}s master cycle - ${report.animated} animated - ${report.exact ? 'exact loop' : 'harmonised'}`
        : 'No animation active';
      dot?.classList.toggle('warn', report.animated > 0 && !report.exact);
    }
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
      const existing = scene.nodes.filter((n) => n.layer === 'background' && !n.locked);
      this.store.pushHistory('Set background');
      scene.nodes = scene.nodes.filter((n) => !(n.layer === 'background' && !n.locked));
      const node = createAssetNode(meta, scene);
      node.locked = true;
      scene.nodes.push(node);
      this.store.mutate(() => {});
      this.store.select(node.id);
      void this.images.ensure([meta.id]).then(() => this.preview.invalidate());
      this.store.status(`Background set to ${meta.name}${existing.length ? ' (previous unlocked background replaced)' : ''}.`, 'success');
      return;
    }
    const node = createAssetNode(meta, scene, at ? { x: at.x, y: at.y + node0Height(meta, scene) / 2 } : undefined);
    this.store.addNode(node, `Add ${meta.name}`);
    void this.images.ensure([meta.id]).then(() => this.preview.invalidate());
  }

  private addEffect(effectId: string, at?: { x: number; y: number }) {
    const def = EFFECT_MAP.get(effectId);
    if (!def) return;
    const scene = this.store.scene;
    const order = scene.nodes.filter((n) => n.layer === 'atmosphere').length;
    const node = makeEffectNode(effectId, scene, order);
    if (at) {
      node.x = at.x; node.y = at.y;
      node.width = scene.canvas.width * 0.5;
      node.height = scene.canvas.height * 0.5;
    }
    this.store.addNode(node, `Add ${def.name}`);
    this.rightTab = 'animate';
    qsa<HTMLElement>('[data-rtab]').forEach((x) => x.classList.toggle('active', x.dataset.rtab === 'animate'));
    this.renderRight();
    if (!this.preview.playing) this.preview.play();
    this.store.status(`${def.name} added to layer 4. Effects work in every artistic style.`, 'success');
  }

  private applyTheme(themeId: string) {
    const preset = THEME_PRESETS.find((t) => t.id === themeId);
    if (!preset) return;
    this.store.pushHistory(`Apply ${preset.name}`);
    let order = this.store.scene.nodes.filter((n) => n.layer === 'atmosphere').length;
    for (const e of preset.effects) {
      if (!EFFECT_MAP.has(e.id)) continue;
      const node = makeEffectNode(e.id, this.store.scene, order++);
      node.effect!.params = { ...effectDefaults(e.id), ...(e.params ?? {}) };
      if (e.loop) node.effect!.loop = e.loop;
      this.store.scene.nodes.push(node);
    }
    this.store.mutate(() => {});
    if (!this.preview.playing) this.preview.play();
    this.store.status(`${preset.name}: ${preset.effects.length} effects added. Every setting stays editable.`, 'success');
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

  private setSolo(node: SceneNode | null) {
    this.soloNode = node?.id ?? null;
    this.preview.soloLayer = node ? node.layer : null;
    this.preview.invalidate();
    this.updateHud();
    this.store.status(node ? `Previewing ${LAYER_LABEL[node.layer]} only.` : 'Showing all four layers.', 'info');
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
    this.renderRight();
    this.refreshChrome();
  }

  /* -------------------------------------------------------------- projects */

  private newWorld() {
    newWorldDialog(this.library, {
      currentStyle: this.store.scene.styleId,
      onCreate: (styleId, aspect, name, seedMode) => {
        const scene = seedMode === 'empty'
          ? createScene(styleId, name, aspect)
          : buildDemoScene(this.library, {
            styleId, aspect, name,
            withEffects: seedMode === 'demo', composed: true,
          });
        scene.name = name;
        this.store.replaceScene(scene);
        this.store.lastSavedName = name;
        this.afterSceneSwap();
        this.preview.restart();
        this.preview.play();
        this.store.status(`"${name}" created.`, 'success');
      },
    });
  }

  private openProjects() {
    projectsDialog(this.shelf, {
      onOpen: async (id) => {
        try {
          const loaded = await this.shelf.open(id);
          if (!loaded) { this.store.status('That project could not be found.', 'error'); return; }
          this.adoptProject(loaded.scene, loaded.missingAssets, loaded.warnings);
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
        this.adoptProject(loaded.scene, loaded.missingAssets, loaded.warnings);
      } catch (err) {
        this.store.status(`Could not open file: ${(err as Error).message}`, 'error');
      }
    };
    input.click();
  }

  private adoptProject(scene: Scene, missing: string[], warnings: string[]) {
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
        // A new identity keeps the original shelf entry and file untouched.
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
    window.clearInterval(this.autosaveTimer);
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
