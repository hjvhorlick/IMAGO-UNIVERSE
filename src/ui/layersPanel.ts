/**
 * RAIL / On canvas - what is actually in the scene, grouped by layer.
 *
 * Deliberately NOT a Photoshop layer stack. There are no eye or padlock columns:
 * objects are placed by dragging, moved and scaled directly on the canvas, and
 * removed with Delete. Lock/hide/reorder still exist, but behind a right-click
 * (or the `...` button) because they are occasional, not per-row decisions.
 */
import type { AssetLibrary } from '../assets/library';
import type { Store } from '../core/store';
import type { LayerId, SceneNode } from '../core/types';
import { LAYER_LABEL, LAYER_ORDER } from '../core/types';
import { EFFECT_MAP } from '../animation/effects';
import { layerNodes, reorderNode } from '../scene/sceneModel';
import { contextMenu } from './menubar';
import type { MenuItem } from './menubar';
import { escapeHtml, icon, on, qsa, qs } from './dom';

export interface LayersPanelCallbacks {
  /** Open the properties/animation section for this object. */
  onInspect?: (node: SceneNode) => void;
}

export class LayersPanel {
  active = false;
  private collapsed = new Set<LayerId>();

  constructor(
    private root: HTMLElement,
    private store: Store,
    private library: AssetLibrary,
    private cb: LayersPanelCallbacks = {},
  ) {
    store.on('scene', () => { if (this.active) this.render(); });
    store.on('selection', () => { if (this.active) this.render(); });
  }

  get count() { return this.store.scene.nodes.length; }

  render() {
    const scroll = this.root.scrollTop;
    const scene = this.store.scene;
    this.root.innerHTML = `<div class="rail-pad tight">` + LAYER_ORDER.slice().reverse().map((layer) => {
      const idx = LAYER_ORDER.indexOf(layer) + 1;
      const nodes = layerNodes(scene, layer).slice().reverse();
      const collapsed = this.collapsed.has(layer);
      return `
        <div class="layer-group" data-layer="${layer}">
          <div class="layer-group-head" data-toggle="${layer}">
            <span class="layer-index${idx === 4 ? ' l4' : ''}">${idx}</span>
            <span class="layer-group-title">${escapeHtml(LAYER_LABEL[layer])}</span>
            <span class="layer-count">${nodes.length}</span>
            ${icon(collapsed ? 'right' : 'down', 12)}
          </div>
          ${collapsed ? '' : `<div class="layer-items">
            ${nodes.length ? nodes.map((n) => this.item(n)).join('')
              : `<div class="layer-empty">Nothing here yet - drag something in.</div>`}
          </div>`}
        </div>`;
    }).join('') + `</div>`;

    qsa<HTMLElement>('[data-toggle]', this.root).forEach((h) => on(h, 'click', () => {
      const l = h.dataset.toggle as LayerId;
      if (this.collapsed.has(l)) this.collapsed.delete(l); else this.collapsed.add(l);
      this.render();
    }));

    qsa<HTMLElement>('.layer-item', this.root).forEach((item) => {
      const id = item.dataset.id!;
      on(item, 'click', (e) => {
        if ((e.target as HTMLElement).closest('[data-more]')) return;
        this.store.select(id, (e as MouseEvent).shiftKey);
      });
      on(item, 'dblclick', () => {
        const n = this.store.node(id);
        if (n) this.cb.onInspect?.(n);
      });
      on(item, 'contextmenu', (e) => {
        e.preventDefault();
        this.store.select(id);
        const r = (e as MouseEvent);
        this.menuFor(id, r.clientX, r.clientY);
      });
      on(qs('[data-more]', item), 'click', (e) => {
        e.stopPropagation();
        this.store.select(id);
        const r = (e.target as HTMLElement).getBoundingClientRect();
        this.menuFor(id, r.left - 150, r.bottom + 4);
      });
    });
    this.root.scrollTop = scroll;
  }

  private menuFor(id: string, x: number, y: number) {
    const n = this.store.node(id);
    if (!n) return;
    const items: MenuItem[] = [
      { label: n.name, heading: true },
      { label: 'Edit properties', icon: 'settings', action: () => this.cb.onInspect?.(n) },
      { label: 'Duplicate', icon: 'copy', shortcut: 'Ctrl+D', action: () => this.store.duplicateSelected() },
      { separator: true },
      { label: 'Bring forward', icon: 'up', disabled: n.locked, action: () => this.reorder(n, 'up') },
      { label: 'Send backward', icon: 'down', disabled: n.locked, action: () => this.reorder(n, 'down') },
      { label: 'Bring to front', icon: 'bring', disabled: n.locked, action: () => this.reorder(n, 'front') },
      { label: 'Send to back', icon: 'send', disabled: n.locked, action: () => this.reorder(n, 'back') },
      { separator: true },
      { label: n.visible ? 'Hide' : 'Show', icon: n.visible ? 'eyeOff' : 'eye', shortcut: 'H', checked: !n.visible, action: () => this.toggle(n, 'visible') },
      { label: n.locked ? 'Unlock' : 'Lock', icon: n.locked ? 'unlock' : 'lock', shortcut: 'L', checked: n.locked, action: () => this.toggle(n, 'locked') },
      { separator: true },
      { label: 'Delete', icon: 'trash', shortcut: 'Del', action: () => this.store.removeSelected() },
    ];
    contextMenu(x, y, items);
  }

  private reorder(node: SceneNode, dir: 'up' | 'down' | 'front' | 'back') {
    if (node.locked) { this.store.status('Unlock the object before reordering it.', 'warn'); return; }
    this.store.mutate((s) => reorderNode(s, node, dir), 'Reorder');
  }

  private toggle(node: SceneNode, key: 'locked' | 'visible') {
    const value = !node[key];
    this.store.mutate(() => { node[key] = value; },
      key === 'locked' ? (value ? 'Lock' : 'Unlock') : (value ? 'Show' : 'Hide'));
  }

  private item(n: SceneNode): string {
    const meta = this.library.get(n.assetId);
    const selected = this.store.selection.includes(n.id);
    const animated = n.kind === 'effect' ? true : !!n.animation?.enabled;
    const thumb = n.kind === 'effect'
      ? `<span class="li-thumb li-effect">${icon('sparkles', 16)}</span>`
      : meta
        ? `<img class="li-thumb" loading="lazy" src="${this.library.url(meta, true)}" alt="">`
        : `<span class="li-thumb"></span>`;
    const label = n.kind === 'effect' ? (EFFECT_MAP.get(n.effect!.effectId)?.name ?? n.name) : n.name;
    const flags = [
      n.locked ? `<span class="li-flag" title="Locked">${icon('lock', 10)}</span>` : '',
      !n.visible ? `<span class="li-flag" title="Hidden">${icon('eyeOff', 10)}</span>` : '',
      animated ? `<span class="anim-dot" title="Animated"></span>` : '',
    ].join('');
    return `<div class="layer-item${selected ? ' selected' : ''}${n.visible ? '' : ' hidden-node'}" data-id="${n.id}">
      ${thumb}
      <span class="li-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      ${flags}
      <button class="li-more" data-more title="More actions">${icon('settings', 12)}</button>
    </div>`;
  }
}
