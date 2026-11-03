/** RIGHT PANEL / Scene - canvas, lighting, composition and performance. */
import type { AssetLibrary } from '../assets/library';
import type { Store } from '../core/store';
import { CANVAS_PRESETS, resizeCanvas } from '../scene/sceneModel';
import { reground, sortByDepth } from '../scene/composition';
import { loopManager } from '../animation/loopManager';
import type { PreviewRenderer } from '../render/previewRenderer';
import { el, escapeHtml, icon, numberField, on, qs, rangeField, selectField, toggleField } from './dom';
import { formatBytes } from '../core/util';
import type { ImageCache } from '../render/imageCache';

export interface ScenePanelCallbacks {
  onCompose: () => void;
  onRegenerate: () => void;
}

export class ScenePanel {
  active = false;

  constructor(
    private root: HTMLElement,
    private store: Store,
    private library: AssetLibrary,
    private preview: PreviewRenderer,
    private images: ImageCache,
    private cb: ScenePanelCallbacks,
  ) {
    this.render();
    store.on('scene', () => { if (this.active) this.softRefresh(); });
  }

  private softRefresh() {
    const active = document.activeElement;
    if (active && this.root.contains(active) && ['INPUT', 'SELECT'].includes(active.tagName)) return;
    this.render();
  }

  private section(title: string, extra = ''): HTMLElement {
    return el(`<div class="panel-section"><div class="section-title"><span>${escapeHtml(title)}</span>${extra}</div></div>`);
  }

  render() {
    const scene = this.store.scene;
    this.root.innerHTML = '';

    /* ---------------------------------------------------------- canvas */
    const c = this.section('Canvas');
    c.appendChild(selectField('Aspect ratio', scene.canvas.aspect,
      Object.entries(CANVAS_PRESETS).map(([k, v]) => ({ value: k, label: v.label }))
        .concat([{ value: 'custom', label: 'Custom' }]),
      (v) => {
        if (v === 'custom') return;
        const p = CANVAS_PRESETS[v];
        this.store.mutate((s) => resizeCanvas(s, p.w, p.h, v), 'Change aspect ratio');
      }));
    const dims = el(`<div class="grid-2"></div>`);
    dims.append(
      numberField('Width', scene.canvas.width, (v) => this.store.mutate((s) =>
        resizeCanvas(s, Math.max(64, Math.min(8192, Math.round(v))), s.canvas.height, 'custom'), 'Resize canvas'), { min: 64, max: 8192, suffix: 'px' }),
      numberField('Height', scene.canvas.height, (v) => this.store.mutate((s) =>
        resizeCanvas(s, s.canvas.width, Math.max(64, Math.min(8192, Math.round(v))), 'custom'), 'Resize canvas'), { min: 64, max: 8192, suffix: 'px' }),
    );
    c.appendChild(dims);
    c.appendChild(toggleField('Clip to canvas', scene.canvas.clipToCanvas,
      (v) => this.store.mutate((s) => { s.canvas.clipToCanvas = v; }, 'Toggle canvas clipping'),
      'On: oversized objects are cut at the canvas edge (this is canvas cropping). Off: you can see the overhang while composing. Exports always clip.'));
    this.root.appendChild(c);

    /* ------------------------------------------------------ composition */
    const comp = this.section('Composition');
    const b1 = el(`<button class="btn small block">${icon('wand', 12)} Auto-compose environment</button>`);
    on(b1, 'click', () => this.cb.onCompose());
    const b2 = el(`<button class="btn small block" style="margin-top:6px">${icon('dice', 12)} Rearrange unlocked objects</button>`);
    on(b2, 'click', () => this.cb.onRegenerate());
    const row = el(`<div class="grid-2" style="margin-top:6px"></div>`);
    const b3 = el(`<button class="btn small">${icon('target', 12)} Re-ground</button>`);
    on(b3, 'click', () => this.store.mutate((s) => reground(s, this.library), 'Re-ground objects'));
    const b4 = el(`<button class="btn small">${icon('layers', 12)} Sort by depth</button>`);
    on(b4, 'click', () => this.store.mutate((s) => sortByDepth(s), 'Sort by depth'));
    row.append(b3, b4);
    comp.append(b1, b2, row);
    comp.appendChild(el(`<div class="field-hint" style="margin-top:8px">
      Locked objects are never moved or replaced. Lock the background and your hero tree,
      then rearrange everything else as often as you like.
    </div>`));
    this.root.appendChild(comp);

    /* --------------------------------------------------------- lighting */
    const L = scene.lighting;
    const l = this.section('Lighting & grade');
    const sliders: [string, keyof typeof L, number, number, number, string?][] = [
      ['Exposure', 'exposure', 0.3, 2, 0.01],
      ['Contrast', 'contrast', 0.5, 1.8, 0.01],
      ['Saturation', 'saturation', 0, 2, 0.01],
      ['Warmth', 'warmth', -1, 1, 0.01],
      ['Ambient light', 'ambient', 0, 0.8, 0.01],
      ['Atmospheric haze', 'haze', 0, 0.8, 0.01],
      ['Sun rays', 'rays', 0, 1, 0.01],
      ['Light angle', 'lightAngle', 0, 360, 1, 'deg'],
      ['Vignette', 'vignette', 0, 0.8, 0.01],
    ];
    for (const [label, key, min, max, step, unit] of sliders) {
      l.appendChild(rangeField({
        label, value: Number(L[key]), min, max, step, unit,
        onCommit: () => this.store.pushHistory(`Adjust ${label.toLowerCase()}`),
        onInput: (v) => { (L[key] as number) = v; this.store.mutate(() => {}); },
      }));
    }
    const col = el(`<div class="field"><div class="field-label"><span>Light colour</span></div><input type="color" value="${L.lightColor}"></div>`);
    on(qs<HTMLInputElement>('input', col)!, 'input', (e) => {
      L.lightColor = (e.target as HTMLInputElement).value;
      this.store.mutate(() => {});
    });
    l.appendChild(col);
    const presets = el(`<div class="grid-3" style="margin-top:8px"></div>`);
    const applyPreset = (name: string, values: Partial<typeof L>) => {
      const b = el(`<button class="btn small">${escapeHtml(name)}</button>`);
      on(b, 'click', () => this.store.mutate(() => Object.assign(L, values), `${name} lighting`));
      return b;
    };
    presets.append(
      applyPreset('Golden', { lightColor: '#ffd9a0', warmth: 0.18, lightAngle: 315, rays: 0.28, ambient: 0.12, haze: 0.08, exposure: 1.03 }),
      applyPreset('Moonlit', { lightColor: '#9fc4ff', warmth: -0.22, lightAngle: 45, rays: 0.14, ambient: 0.18, haze: 0.12, exposure: 0.94 }),
      applyPreset('Overcast', { lightColor: '#cfd8e3', warmth: -0.05, lightAngle: 270, rays: 0.04, ambient: 0.2, haze: 0.2, exposure: 0.98, contrast: 0.95 }),
    );
    l.appendChild(presets);
    this.root.appendChild(l);

    /* ------------------------------------------------------------- loop */
    const report = loopManager.analyse(scene);
    const lp = this.section('Loop manager', `<span class="field-value">${report.animated} active</span>`);
    lp.appendChild(el(`<div class="stat-grid">
      <div class="stat"><div class="stat-label">Master cycle</div><div class="stat-value">${report.master}s</div></div>
      <div class="stat"><div class="stat-label">Boundary</div><div class="stat-value" style="color:${report.exact ? 'var(--ok)' : 'var(--warn)'}">${report.exact ? 'Exact' : 'Harmonised'}</div></div>
    </div>`));
    if (report.cycles.length) {
      lp.appendChild(el(`<div class="field-hint">${report.cycles.slice(0, 8).map((c) =>
        `${escapeHtml(c.name)}: ${c.adjusted}s`).join('<br>')}${report.cycles.length > 8 ? `<br>+${report.cycles.length - 8} more` : ''}</div>`));
    } else {
      lp.appendChild(el(`<div class="field-hint">No animation is enabled yet. Select an object and open the Animate tab.</div>`));
    }
    lp.appendChild(el(`<div class="field-hint" style="margin-top:8px">
      Video duration is independent of the cycle: the renderer repeats the master cycle
      until the requested length is reached.
    </div>`));
    this.root.appendChild(lp);

    /* ------------------------------------------------------ performance */
    const perf = this.section('Performance');
    const stats = this.preview.stats;
    const cache = this.images.stats;
    perf.appendChild(el(`<div class="stat-grid">
      <div class="stat"><div class="stat-label">Preview</div><div class="stat-value">${stats.width}x${stats.height}</div></div>
      <div class="stat"><div class="stat-label">Frame</div><div class="stat-value">${stats.renderMs.toFixed(1)} ms</div></div>
      <div class="stat"><div class="stat-label">Objects</div><div class="stat-value">${scene.nodes.length}</div></div>
      <div class="stat"><div class="stat-label">Art cached</div><div class="stat-value">${formatBytes(cache.bytes)}</div></div>
    </div>`));
    perf.appendChild(selectField('Preview detail', this.preview.quality,
      [{ value: 'preview', label: 'Balanced (faster)' }, { value: 'export', label: 'Full (matches export)' }],
      (v) => { this.preview.quality = v as 'preview' | 'export'; this.preview.invalidate(); this.render(); },
      'Exports always use full detail regardless of this setting.'));
    this.root.appendChild(perf);
  }
}
