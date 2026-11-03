/** RIGHT PANEL / Layers - the four-layer stack, always visible as four groups. */
import type { AssetLibrary } from '../assets/library';
import type { Store } from '../core/store';
import type { LayerId, SceneNode } from '../core/types';
import { LAYER_LABEL, LAYER_ORDER } from '../core/types';
import { EFFECT_MAP } from '../animation/effects';
import { layerNodes, reorderNode } from '../scene/sceneModel';
import { escapeHtml, icon, on, qsa } from './dom';

export class LayersPanel {
  active = false;
  private collapsed = new Set<LayerId>();

  constructor(private root: HTMLElement, private store: Store, private library: AssetLibrary) {
    this.render();
    store.on('scene', () => { if (this.active) this.render(); });
    store.on('selection', () => { if (this.active) this.render(); });
  }

  render() {
    const scroll = this.root.scrollTop;
    const scene = this.store.scene;
    this.root.innerHTML = LAYER_ORDER.slice().reverse().map((layer) => {
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
              : `<div class="empty-state" style="padding:12px">Nothing in this layer yet.</div>`}
          </div>`}
        </div>`;
    }).join('');

    qsa<HTMLElement>('[data-toggle]', this.root).forEach((h) => on(h, 'click', () => {
      const l = h.dataset.toggle as LayerId;
      if (this.collapsed.has(l)) this.collapsed.delete(l); else this.collapsed.add(l);
      this.render();
    }));

    qsa<HTMLElement>('.layer-item', this.root).forEach((item) => {
      const id = item.dataset.id!;
      on(item, 'click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-act]')) return;
        this.store.select(id, (e as MouseEvent).shiftKey);
      });
      qsa<HTMLElement>('[data-act]', item).forEach((btn) => on(btn, 'click', (e) => {
        e.stopPropagation();
        this.action(id, btn.dataset.act!);
      }));
    });
    this.root.scrollTop = scroll;
  }

  private item(n: SceneNode): string {
    const meta = this.library.get(n.assetId);
    const selected = this.store.selection.includes(n.id);
    const animated = n.kind === 'effect' ? true : !!n.animation?.enabled;
    const thumb = n.kind === 'effect'
      ? `<span class="layer-item-effect">${icon('sparkles', 11)}</span>`
      : meta
        ? `<img class="layer-item-thumb" src="${this.library.url(meta, true)}" alt="">`
        : `<span class="layer-item-thumb"></span>`;
    const label = n.kind === 'effect' ? (EFFECT_MAP.get(n.effect!.effectId)?.name ?? n.name) : n.name;
    return `<div class="layer-item${selected ? ' selected' : ''}${n.visible ? '' : ' hidden-node'}" data-id="${n.id}">
      ${thumb}
      <span class="layer-item-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      ${animated ? '<span class="anim-dot" title="Animated"></span>' : ''}
      <button class="mini-btn${n.visible ? '' : ' on'}" data-act="visibility" title="${n.visible ? 'Hide' : 'Show'}">${icon(n.visible ? 'eye' : 'eyeOff', 12)}</button>
      <button class="mini-btn${n.locked ? ' locked' : ''}" data-act="lock" title="${n.locked ? 'Unlock' : 'Lock'}">${icon(n.locked ? 'lock' : 'unlock', 12)}</button>
      <button class="mini-btn" data-act="up" title="Bring forward">${icon('up', 12)}</button>
      <button class="mini-btn" data-act="down" title="Send backward">${icon('down', 12)}</button>
    </div>`;
  }

  private action(id: string, act: string) {
    const node = this.store.node(id);
    if (!node) return;
    if (act === 'visibility') {
      this.store.mutate(() => { node.visible = !node.visible; }, node.visible ? 'Hide object' : 'Show object');
    } else if (act === 'lock') {
      this.store.mutate(() => { node.locked = !node.locked; }, node.locked ? 'Unlock object' : 'Lock object');
    } else if (act === 'up' || act === 'down') {
      if (node.locked) { this.store.status('Unlock the object before reordering it.', 'warn'); return; }
      this.store.mutate((s) => reorderNode(s, node, act), act === 'up' ? 'Bring forward' : 'Send backward');
    }
  }
}
