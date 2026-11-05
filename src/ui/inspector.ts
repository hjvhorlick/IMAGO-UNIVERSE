/**
 * RIGHT PANEL / Object + Animate.
 *
 * The inspector only ever shows controls that apply to the current selection:
 * an effect never sees "crop", a static rock never sees "wind direction", and
 * each atmospheric effect declares its own parameter list.
 */
import type { AssetLibrary } from '../assets/library';
import type { Store } from '../core/store';
import type { AnimationType, SceneNode } from '../core/types';
import { ANIMATION_LABEL, DEFAULT_LOOP, makeAnimation } from '../core/types';
import { EFFECT_MAP } from '../animation/effects';
import { uid } from '../core/util';
import { groundLine, moveNodeToLayer, reorderNode } from '../scene/sceneModel';
import {
  colorField, el, escapeHtml, icon, numberField, on, rangeField, selectField, toggleField,
} from './dom';

export interface InspectorCallbacks {
  onCrop: (node: SceneNode) => void;
  onReplace: (node: SceneNode) => void;
  onSoloAnimation: (node: SceneNode | null) => void;
  onSoloLayer: (layer: SceneNode['layer'] | null) => void;
}

const GENERIC_ANIMS: AnimationType[] = ['float', 'spin', 'pulse', 'grass-wind', 'stem-bend', 'water-flow', 'ripple', 'flag-wave'];
const BLEND_OPTIONS = [
  { value: 'source-over', label: 'Normal' },
  { value: 'lighter', label: 'Add (glow)' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft light' },
];

export class Inspector {
  active = false;
  mode: 'object' | 'animate' = 'object';

  constructor(
    private root: HTMLElement,
    private store: Store,
    private library: AssetLibrary,
    private cb: InspectorCallbacks,
  ) {
    this.render();
    store.on('selection', () => { if (this.active) this.render(); });
    store.on('scene', () => { if (this.active) this.softRefresh(); });
  }

  setMode(mode: 'object' | 'animate') { this.mode = mode; this.render(); }

  /** Avoid rebuilding sliders while the user is dragging one. */
  private softRefresh() {
    const active = document.activeElement;
    if (active && this.root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    this.render();
  }

  render() {
    const node = this.store.primary;
    this.root.innerHTML = '';
    if (!node) {
      this.root.appendChild(el(`<div class="empty-state">
        <strong>Nothing selected</strong>
        Click an object on the canvas, or pick one from the Layers tab.
        <div style="margin-top:14px; text-align:left">
          <div class="shortcut-list" style="grid-template-columns:1fr">
            <div><span>Duplicate</span><span class="kbd">Ctrl D</span></div>
            <div><span>Delete</span><span class="kbd">Del</span></div>
            <div><span>Undo / Redo</span><span class="kbd">Ctrl Z / Y</span></div>
            <div><span>Play / pause</span><span class="kbd">Space</span></div>
            <div><span>Pan the canvas</span><span class="kbd">Space + drag</span></div>
            <div><span>Free resize</span><span class="kbd">Alt + drag</span></div>
          </div>
        </div>
      </div>`));
      return;
    }
    if (this.store.selection.length > 1) {
      this.root.appendChild(this.multiSection());
    }
    this.root.appendChild(node.kind === 'effect'
      ? (this.mode === 'animate' ? this.effectAnimate(node) : this.effectObject(node))
      : (this.mode === 'animate' ? this.objectAnimate(node) : this.objectProps(node)));
  }

  /* ------------------------------------------------------------- helpers */

  private section(title: string, extra = ''): HTMLElement {
    const s = el<HTMLElement>(`<div class="panel-section"><div class="section-title"><span>${escapeHtml(title)}</span>${extra}</div></div>`);
    return s;
  }

  private update(node: SceneNode, fn: (n: SceneNode) => void, label?: string) {
    this.store.mutate(() => fn(node), label);
  }

  private slider(section: HTMLElement, node: SceneNode, label: string, key: string,
    min: number, max: number, step: number, opts: { unit?: string; hint?: string; target?: 'node' | 'adjust' | 'shadow' | 'animation'; format?: (v: number) => string } = {}) {
    const target = opts.target ?? 'node';
    const obj = target === 'node' ? node : target === 'adjust' ? node.adjust : target === 'shadow' ? node.shadow : node.animation;
    if (!obj) return;
    const value = (obj as unknown as Record<string, number>)[key];
    let pushed = false;
    section.appendChild(rangeField({
      label, value, min, max, step, unit: opts.unit, hint: opts.hint, format: opts.format,
      onCommit: () => { if (!pushed) { this.store.pushHistory(`Adjust ${label.toLowerCase()}`); pushed = true; } },
      onInput: (v) => { (obj as unknown as Record<string, number>)[key] = v; this.store.mutate(() => {}); },
    }));
    // reset the history guard when the pointer is released
    on(section.lastElementChild, 'pointerup', () => { pushed = false; });
    on(section.lastElementChild, 'blur', () => { pushed = false; });
  }

  /* --------------------------------------------------------- multi-select */

  private multiSection(): HTMLElement {
    const s = this.section(`${this.store.selection.length} objects selected`);
    const row = el(`<div class="row"></div>`);
    const dup = el(`<button class="btn small">${icon('copy', 12)} Duplicate</button>`);
    const del = el(`<button class="btn small danger">${icon('trash', 12)} Delete</button>`);
    on(dup, 'click', () => this.store.duplicateSelected());
    on(del, 'click', () => this.store.removeSelected());
    row.append(dup, del);
    s.appendChild(row);
    s.appendChild(el(`<div class="field-hint" style="margin-top:8px">Drag any selected object to move them together.</div>`));
    return s;
  }

  /* ------------------------------------------------------- object: asset */

  private objectProps(node: SceneNode): DocumentFragment {
    const frag = document.createDocumentFragment();
    const meta = this.library.get(node.assetId);
    const scene = this.store.scene;

    const head = this.section(node.name, `<span class="field-value">${meta ? `${meta.width}x${meta.height}` : 'missing art'}</span>`);
    head.appendChild(el(`<div class="field-hint">${meta
      ? `${escapeHtml(meta.category)} - ${escapeHtml(meta.origin)} artwork. Original file is never modified.`
      : 'The artwork for this object is missing from the library.'}</div>`));
    const actions = el(`<div class="grid-4" style="margin-top:10px"></div>`);
    const mk = (label: string, ic: string, fn: () => void, title: string) => {
      const b = el(`<button class="btn small" title="${escapeHtml(title)}">${icon(ic, 12)}</button>`);
      b.setAttribute('aria-label', label);
      on(b, 'click', fn);
      return b;
    };
    actions.append(
      mk('Duplicate', 'copy', () => this.store.duplicateSelected(), 'Duplicate (Ctrl+D)'),
      mk('Crop image', 'crop', () => this.cb.onCrop(node), 'Crop which part of the artwork is visible'),
      mk('Replace artwork', 'image', () => this.cb.onReplace(node), 'Swap the artwork, keep all settings'),
      mk('Delete', 'trash', () => this.store.removeSelected(), 'Delete (Del)'),
    );
    head.appendChild(actions);
    frag.appendChild(head);

    /* transform */
    const t = this.section('Transform');
    const grid = el(`<div class="grid-2"></div>`);
    grid.append(
      numberField('X', Math.round(node.x), (v) => this.update(node, (n) => { n.x = v; }, 'Move'), { suffix: 'px' }),
      numberField('Y', Math.round(node.y), (v) => this.update(node, (n) => { n.y = v; }, 'Move'), { suffix: 'px' }),
      numberField('Width', Math.round(node.width), (v) => this.update(node, (n) => {
        const ratio = n.height / n.width; n.width = Math.max(8, v); n.height = Math.max(8, v * ratio);
      }, 'Resize'), { suffix: 'px', min: 8 }),
      numberField('Height', Math.round(node.height), (v) => this.update(node, (n) => {
        const ratio = n.width / n.height; n.height = Math.max(8, v); n.width = Math.max(8, v * ratio);
      }, 'Resize'), { suffix: 'px', min: 8 }),
    );
    t.appendChild(grid);
    this.slider(t, node, 'Rotation', 'rotation', -180, 180, 0.5, { unit: 'deg' });
    const trow = el(`<div class="row" style="margin-top:6px"></div>`);
    const flip = el(`<button class="btn small${node.flipX ? ' active' : ''}">${icon('flip', 12)} Flip</button>`);
    on(flip, 'click', () => this.update(node, (n) => { n.flipX = !n.flipX; }, 'Flip'));
    const ground = el(`<button class="btn small" title="Snap the base back onto the ground line for its depth">${icon('target', 12)} Ground</button>`);
    on(ground, 'click', () => this.update(node, (n) => {
      if (!meta) return;
      n.y = groundLine(scene, n.depth) - n.height * meta.groundContact + n.height * 0.5;
    }, 'Ground object'));
    const reset = el(`<button class="btn small" title="Restore the original artwork framing and colour">${icon('restart', 12)} Restore</button>`);
    on(reset, 'click', () => this.store.mutate(() => {
      node.crop = { x: 0, y: 0, w: 1, h: 1 };
      node.adjust = { brightness: 1, contrast: 1, saturation: 1, hue: 0, warmth: 0, haze: 0 };
      node.rotation = 0; node.flipX = false; node.opacity = 1;
      if (meta) {
        const h = scene.canvas.height * meta.defaultScale;
        node.height = h; node.width = h * (meta.width / meta.height);
      }
    }, 'Restore original'));
    trow.append(flip, ground, reset);
    t.appendChild(trow);
    frag.appendChild(t);

    /* placement */
    const p = this.section('Placement & depth');
    p.appendChild(selectField('Layer', node.layer, [
      { value: 'background', label: '1 - Background' },
      { value: 'middle', label: '2 - Middle-ground' },
      { value: 'foreground', label: '3 - Foreground' },
      { value: 'atmosphere', label: '4 - Atmosphere & rooms' },
    ], (v) => this.store.mutate((s) => moveNodeToLayer(s, node, v as SceneNode['layer']), 'Change layer'),
    'Use the ordering controls to arrange objects and effects within a layer.'));
    this.slider(p, node, 'Depth', 'depth', 0, 1, 0.01, {
      hint: '0 = far away, 1 = right in front. Drives the ground line and haze.',
    });
    const order = el(`<div class="grid-4" style="margin-top:6px"></div>`);
    const ob = (ic: string, dir: 'up' | 'down' | 'front' | 'back', title: string) => {
      const b = el(`<button class="btn small" title="${title}">${icon(ic, 12)}</button>`);
      on(b, 'click', () => this.store.mutate((s) => reorderNode(s, node, dir), 'Reorder'));
      return b;
    };
    order.append(ob('bring', 'front', 'Bring to front'), ob('up', 'up', 'Bring forward'),
      ob('down', 'down', 'Send backward'), ob('send', 'back', 'Send to back'));
    p.appendChild(order);
    const overflow = node.x - node.width / 2 < 0 || node.x + node.width / 2 > scene.canvas.width
      || node.y - node.height / 2 < 0 || node.y + node.height / 2 > scene.canvas.height;
    p.appendChild(el(`<div class="field-hint">${overflow
      ? 'This object extends beyond the canvas. Only the visible part is rendered - that is intentional and allowed.'
      : 'Objects may extend past the canvas edges; foreground plants often should.'}</div>`));
    frag.appendChild(p);

    /* appearance */
    const a = this.section('Appearance');
    this.slider(a, node, 'Opacity', 'opacity', 0, 1, 0.01, { format: (v) => `${Math.round(v * 100)}%` });
    this.slider(a, node, 'Brightness', 'brightness', 0.2, 2, 0.01, { target: 'adjust' });
    this.slider(a, node, 'Contrast', 'contrast', 0.2, 2, 0.01, { target: 'adjust' });
    this.slider(a, node, 'Saturation', 'saturation', 0, 2.5, 0.01, { target: 'adjust' });
    this.slider(a, node, 'Hue shift', 'hue', -180, 180, 1, { target: 'adjust', unit: 'deg' });
    this.slider(a, node, 'Warmth', 'warmth', -1, 1, 0.01, { target: 'adjust', hint: 'Negative cools the object, positive warms it.' });
    this.slider(a, node, 'Atmospheric haze', 'haze', 0, 1, 0.01, { target: 'adjust', hint: 'Washes the object toward the scene light colour for distance.' });
    a.appendChild(selectField('Blending', node.blend, BLEND_OPTIONS,
      (v) => this.update(node, (n) => { n.blend = v; }, 'Change blending')));
    frag.appendChild(a);

    /* shadow */
    const sh = this.section('Contact shadow');
    sh.appendChild(toggleField('Cast shadow', node.shadow.enabled,
      (v) => this.update(node, (n) => { n.shadow.enabled = v; }, 'Toggle shadow')));
    if (node.shadow.enabled) {
      this.slider(sh, node, 'Opacity', 'opacity', 0, 1, 0.01, { target: 'shadow' });
      this.slider(sh, node, 'Softness', 'blur', 0, 80, 1, { target: 'shadow', unit: 'px' });
      this.slider(sh, node, 'Distance', 'distance', -120, 200, 1, { target: 'shadow', unit: 'px' });
      this.slider(sh, node, 'Angle', 'angle', 0, 360, 1, { target: 'shadow', unit: 'deg' });
      this.slider(sh, node, 'Flatten', 'squash', 0.05, 1, 0.01, { target: 'shadow' });
    }
    frag.appendChild(sh);
    return frag;
  }

  /* ----------------------------------------------------- object: animate */

  private objectAnimate(node: SceneNode): DocumentFragment {
    const frag = document.createDocumentFragment();
    const meta = this.library.get(node.assetId);
    const recommended = (meta?.animations ?? []) as AnimationType[];
    const available: AnimationType[] = ['none', ...Array.from(new Set([...recommended, ...GENERIC_ANIMS]))];

    const head = this.section(`Animate - ${node.name}`);
    if (!node.animation) node.animation = makeAnimation('none', Math.floor(Math.random() * 1e6));
    const anim = node.animation;

    head.appendChild(toggleField('Animation enabled', anim.enabled, (v) => {
      this.store.mutate(() => {
        anim.enabled = v;
        if (v && anim.type === 'none') {
          anim.type = (recommended[0] ?? 'float') as AnimationType;
          anim.loop = DEFAULT_LOOP[anim.type];
        }
      }, v ? 'Enable animation' : 'Disable animation');
      this.render();
    }, 'Objects are placed static; switch motion on when you want it.'));

    head.appendChild(selectField('Technique', anim.type,
      available.map((t) => ({ value: t, label: ANIMATION_LABEL[t] + (recommended.includes(t) ? ' (recommended)' : '') })),
      (v) => this.store.mutate(() => {
        anim.type = v as AnimationType;
        anim.loop = DEFAULT_LOOP[anim.type];
        if (v !== 'none') anim.enabled = true;
      }, 'Change animation'),
      techniqueHint(anim.type)));
    frag.appendChild(head);

    if (anim.type === 'none' || !anim.enabled) {
      frag.appendChild(el(`<div class="panel-section"><div class="field-hint">
        Motion is off for this object. Everything else about it still renders and exports normally.
      </div></div>`));
      return frag;
    }

    const m = this.section('Movement');
    this.slider(m, node, 'Strength', 'amplitude', 0, 1, 0.01, { target: 'animation', format: (v) => `${Math.round(v * 100)}%` });
    if (['canopy-sway', 'grass-wind', 'stem-bend'].includes(anim.type)) {
      this.slider(m, node, 'Organic variation', 'turbulence', 0, 1, 0.01, {
        target: 'animation', hint: 'Adds out-of-phase gusts so nothing moves mechanically.',
      });
    }
    if (anim.type === 'waterfall-flow') {
      this.slider(m, node, 'Splash & mist', 'turbulence', 0, 1, 0.01, {
        target: 'animation', format: (v) => `${Math.round(v * 100)}%`,
        hint: 'Controls plunge-pool whitewater boil, leaping spray droplets and rising canyon mist.',
      });
    }
    if (['canopy-sway', 'grass-wind', 'stem-bend', 'float', 'spin'].includes(anim.type)) {
      this.slider(m, node, 'Direction', 'direction', 0, 360, 1, { target: 'animation', unit: 'deg' });
    }
    frag.appendChild(m);

    const l = this.section('Loop', `<span class="field-value">exact</span>`);
    l.appendChild(rangeField({
      label: 'Cycle length', value: anim.loop, min: 1, max: 40, step: 0.5, unit: 's',
      hint: 'One full cycle. The Loop Manager harmonises every object onto a shared master cycle.',
      onCommit: () => this.store.pushHistory('Change cycle length'),
      onInput: (v) => { anim.loop = v; this.store.mutate(() => {}); },
    }));
    this.slider(l, node, 'Phase offset', 'phase', 0, 1, 0.01, {
      target: 'animation', hint: 'Staggers this object against the others so they do not move in unison.',
      format: (v) => `${Math.round(v * 100)}%`,
    });
    const seedRow = el(`<div class="row" style="margin-top:6px"></div>`);
    const reroll = el(`<button class="btn small block">${icon('dice', 12)} New motion pattern</button>`);
    on(reroll, 'click', () => this.store.mutate(() => { anim.seed = Math.floor(Math.random() * 1e6); }, 'New motion pattern'));
    seedRow.appendChild(reroll);
    l.appendChild(seedRow);
    frag.appendChild(l);

    const w = this.section('Timing window');
    w.appendChild(el(`<div class="field-hint" style="margin-bottom:8px">
      Leave both at zero for a continuous loop. A window makes the animation start or stop, which means
      the video renderer draws every frame instead of tiling one cycle.
    </div>`));
    const wg = el(`<div class="grid-2"></div>`);
    wg.append(
      numberField('Start', anim.start, (v) => this.update(node, () => { anim.start = Math.max(0, v); }, 'Set start'), { min: 0, step: 0.5, suffix: 's' }),
      numberField('Stop (0 = never)', anim.end, (v) => this.update(node, () => { anim.end = Math.max(0, v); }, 'Set stop'), { min: 0, step: 0.5, suffix: 's' }),
    );
    w.appendChild(wg);
    frag.appendChild(w);

    const solo = this.section('Preview');
    const b = el(`<button class="btn small block">${icon('play', 12)} Preview this animation only</button>`);
    on(b, 'click', () => this.cb.onSoloAnimation(node));
    const bl = el(`<button class="btn small block" style="margin-top:6px">${icon('layers', 12)} Preview this layer only</button>`);
    on(bl, 'click', () => this.cb.onSoloLayer(node.layer));
    const b2 = el(`<button class="btn small block" style="margin-top:6px">${icon('layers', 12)} Show all layers</button>`);
    on(b2, 'click', () => this.cb.onSoloAnimation(null));
    solo.append(b, bl, b2);
    frag.appendChild(solo);
    return frag;
  }

  /* -------------------------------------------------------------- effects */

  private effectObject(node: SceneNode): DocumentFragment {
    const frag = document.createDocumentFragment();
    const inst = node.effect!;
    const def = EFFECT_MAP.get(inst.effectId);
    const head = this.section(def?.name ?? 'Effect', `<span class="field-value">Layer 4</span>`);
    head.appendChild(el(`<div class="field-hint">${escapeHtml(def?.description ?? '')}</div>`));
    const actions = el(`<div class="grid-3" style="margin-top:10px"></div>`);
    const dup = el(`<button class="btn small">${icon('copy', 12)} Duplicate</button>`);
    const del = el(`<button class="btn small danger">${icon('trash', 12)} Remove</button>`);
    const full = el(`<button class="btn small" title="Cover the whole canvas">${icon('fit', 12)} Fill</button>`);
    on(dup, 'click', () => this.store.duplicateSelected());
    on(del, 'click', () => this.store.removeSelected());
    on(full, 'click', () => this.store.mutate((s) => {
      node.x = s.canvas.width / 2; node.y = s.canvas.height / 2;
      node.width = s.canvas.width; node.height = s.canvas.height; node.rotation = 0;
    }, 'Fill canvas'));
    actions.append(dup, full, del);
    head.appendChild(actions);
    frag.appendChild(head);

    const area = this.section('Area & placement', '<span class="field-value">distribution</span>');
    area.appendChild(el(`<div class="field-hint" style="margin-bottom:8px">
      The effect lives inside this rectangle. Resize or move it to control where particles appear.
    </div>`));
    const g = el(`<div class="grid-2"></div>`);
    g.append(
      numberField('Centre X', Math.round(node.x), (v) => this.update(node, (n) => { n.x = v; }, 'Move effect')),
      numberField('Centre Y', Math.round(node.y), (v) => this.update(node, (n) => { n.y = v; }, 'Move effect')),
      numberField('Width', Math.round(node.width), (v) => this.update(node, (n) => { n.width = Math.max(20, v); }, 'Resize effect'), { min: 20 }),
      numberField('Height', Math.round(node.height), (v) => this.update(node, (n) => { n.height = Math.max(20, v); }, 'Resize effect'), { min: 20 }),
    );
    area.appendChild(g);
    this.slider(area, node, 'Rotation', 'rotation', -180, 180, 0.5, { unit: 'deg' });
    this.slider(area, node, 'Opacity', 'opacity', 0, 1, 0.01, { format: (v) => `${Math.round(v * 100)}%` });
    area.appendChild(selectField('Blending', node.blend === 'source-over' ? (def?.blend ?? 'source-over') : node.blend,
      BLEND_OPTIONS, (v) => this.update(node, (n) => { n.blend = v; }, 'Change blending')));
    frag.appendChild(area);
    return frag;
  }

  private effectAnimate(node: SceneNode): DocumentFragment {
    const frag = document.createDocumentFragment();
    const inst = node.effect!;
    const def = EFFECT_MAP.get(inst.effectId);
    if (!def) return frag;

    const head = this.section(`${def.name} settings`);
    head.appendChild(el(`<div class="field-hint">${escapeHtml(def.description)}</div>`));
    frag.appendChild(head);

    const params = this.section('Effect controls', '<span class="field-value">only what applies</span>');
    for (const p of def.params) {
      const value = inst.params[p.key] ?? p.default;
      if (p.type === 'range') {
        params.appendChild(rangeField({
          label: p.label, value: Number(value), min: p.min!, max: p.max!, step: p.step!, unit: p.unit, hint: p.hint,
          onCommit: () => this.store.pushHistory(`Adjust ${p.label.toLowerCase()}`),
          onInput: (v) => { inst.params[p.key] = v; this.store.mutate(() => {}); },
        }));
      } else if (p.type === 'color') {
        params.appendChild(colorField(p.label, String(value), (v) => {
          this.store.mutate(() => { inst.params[p.key] = v; }, `Change ${p.label.toLowerCase()}`);
        }));
      } else if (p.type === 'toggle') {
        params.appendChild(toggleField(p.label, Boolean(value), (v) => {
          this.store.mutate(() => { inst.params[p.key] = v; }, `Toggle ${p.label.toLowerCase()}`);
        }));
      } else if (p.type === 'select') {
        params.appendChild(selectField(p.label, String(value), p.options!, (v) => {
          this.store.mutate(() => { inst.params[p.key] = v; }, `Change ${p.label.toLowerCase()}`);
        }));
      }
    }
    const resetBtn = el(`<button class="btn small block" style="margin-top:8px">${icon('restart', 12)} Reset to defaults</button>`);
    on(resetBtn, 'click', () => this.store.mutate(() => {
      for (const p of def.params) inst.params[p.key] = p.default;
    }, 'Reset effect'));
    params.appendChild(resetBtn);
    frag.appendChild(params);

    const l = this.section('Loop & timing');
    l.appendChild(rangeField({
      label: 'Cycle length', value: inst.loop, min: 1, max: 60, step: 0.5, unit: 's',
      hint: 'Particles complete whole lifetimes inside this window, so the effect re-enters seamlessly.',
      onCommit: () => this.store.pushHistory('Change effect cycle'),
      onInput: (v) => { inst.loop = v; this.store.mutate(() => {}); },
    }));
    const wg = el(`<div class="grid-2"></div>`);
    wg.append(
      numberField('Start', inst.start, (v) => this.update(node, () => { inst.start = Math.max(0, v); }, 'Set start'), { min: 0, step: 0.5, suffix: 's' }),
      numberField('Stop (0 = never)', inst.end, (v) => this.update(node, () => { inst.end = Math.max(0, v); }, 'Set stop'), { min: 0, step: 0.5, suffix: 's' }),
    );
    l.appendChild(wg);
    const reroll = el(`<button class="btn small block" style="margin-top:6px">${icon('dice', 12)} New particle pattern</button>`);
    on(reroll, 'click', () => this.store.mutate(() => { inst.seed = Math.floor(Math.random() * 1e6); }, 'New particle pattern'));
    l.appendChild(reroll);
    frag.appendChild(l);

    const solo = this.section('Preview');
    const b = el(`<button class="btn small block">${icon('play', 12)} Preview this effect only</button>`);
    on(b, 'click', () => this.cb.onSoloAnimation(node));
    const bl = el(`<button class="btn small block" style="margin-top:6px">${icon('layers', 12)} Preview this layer only</button>`);
    on(bl, 'click', () => this.cb.onSoloLayer(node.layer));
    const b2 = el(`<button class="btn small block" style="margin-top:6px">${icon('layers', 12)} Show all layers</button>`);
    on(b2, 'click', () => this.cb.onSoloAnimation(null));
    solo.append(b, bl, b2);
    frag.appendChild(solo);
    return frag;
  }
}

function techniqueHint(t: AnimationType): string {
  switch (t) {
    case 'canopy-sway': return 'Warps the canopy with per-branch phase offsets. The trunk stays planted - the tree is never rotated as a whole.';
    case 'grass-wind': return 'Segmented bending anchored at the soil, with gusts. Tips travel furthest.';
    case 'stem-bend': return 'Stem deformation plus a lagging flower head.';
    case 'water-flow': return 'Travelling surface waves rather than a sliding texture.';
    case 'waterfall-flow': return 'Multi-stream rushing water curtains, falling droplets, plunge-pool splash spray and rising billowing mist over stationary cliffs.';
    case 'ripple': return 'Radial displacement falling off with distance from the centre.';
    case 'flag-wave': return 'Cloth-style wave anchored along one edge.';
    case 'float': return 'Closed curved drift path - returns exactly to its start.';
    case 'spin': return 'A whole number of turns per cycle, so the boundary is exact.';
    case 'pulse': return 'Brightness and scale breathing.';
    case 'lantern-glow': return 'Warm additive bloom that swells and fades.';
    case 'hearth-fire': return 'Flickers the painted flames inside the hearth without moving the surrounding room.';
    case 'coffee-steam': return 'Soft wisps rise from the coffee and fade away.';
    case 'cloud-drift': return 'The sky band scrolls horizontally as a tiling strip.';
    case 'water-shimmer': return 'Gentle wave distortion across the lower part of the plate.';
    case 'parallax': return 'Very slow scale breathing for depth.';
    default: return 'No motion applied.';
  }
}

export function makeEffectNode(effectId: string, scene: { canvas: { width: number; height: number } }, order: number): SceneNode {
  const def = EFFECT_MAP.get(effectId)!;
  const params: Record<string, number | string | boolean> = {};
  for (const p of def.params) params[p.key] = p.default;
  const ornamentSize = Math.min(scene.canvas.width, scene.canvas.height) * 0.55;
  return {
    id: uid('fx'), kind: 'effect', layer: 'atmosphere', name: def.name,
    x: scene.canvas.width / 2, y: scene.canvas.height / 2,
    width: def.family === 'spiritual' ? ornamentSize : scene.canvas.width,
    height: def.family === 'spiritual' ? ornamentSize : scene.canvas.height,
    rotation: 0, flipX: false, opacity: 1, visible: true, locked: false,
    order, depth: 1,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    adjust: { brightness: 1, contrast: 1, saturation: 1, hue: 0, warmth: 0, haze: 0 },
    shadow: { enabled: false, opacity: 0.3, blur: 10, distance: 0, angle: 180, squash: 0.3 },
    blend: def.blend,
    animation: null,
    effect: { effectId, params, loop: def.defaultLoop, seed: Math.floor(Math.random() * 1e6), start: 0, end: 0 },
  };
}
