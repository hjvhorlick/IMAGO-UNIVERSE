/**
 * CANVAS STAGE
 * ============
 * All pointer interaction and all editor furniture. The overlay canvas is a
 * *separate* canvas from the scene canvas, which is the structural reason
 * exported images and videos can never contain handles or guides.
 */
import type { Store } from '../core/store';
import type { SceneNode } from '../core/types';
import { clamp, rad, rotatePoint } from '../core/util';
import { readWaterShape, waterShapeFeather } from '../core/waterShape';
import type { WaterPoint } from '../core/waterShape';
import { paintOrder } from '../scene/sceneModel';
import type { PreviewRenderer } from '../render/previewRenderer';
import { EFFECT_MAP } from '../animation/effects';
import { on, qs } from './dom';

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';

/** Corners read as diagonal (proportional); edges as single-axis (stretch). */
function handleCursor(h: HandleId): string {
  if (h === 'rot') return 'grab';
  if (h === 'nw' || h === 'se') return 'nwse-resize';
  if (h === 'ne' || h === 'sw') return 'nesw-resize';
  if (h === 'n' || h === 's') return 'ns-resize';
  return 'ew-resize';
}

interface DragState {
  mode: 'move' | 'resize' | 'rotate' | 'pan' | 'water-point';
  startPointer: { x: number; y: number };
  handle?: HandleId;
  originals: { id: string; x: number; y: number; width: number; height: number; rotation: number }[];
  panStart: { x: number; y: number };
  aspect: number;
  waterIndex?: number;
  waterPoints?: WaterPoint[];
  waterFlip?: boolean;
  moved: boolean;
}

export interface StageCallbacks {
  onDropAsset: (assetId: string, x: number, y: number) => void;
  onDropEffect: (effectId: string, x: number, y: number) => void;
  onDoubleClick: (node: SceneNode | null) => void;
  canSelectSpiritual: () => boolean;
}

export class Stage {
  zoom = 1;
  panX = 0;
  panY = 0;
  showOverflow = true;
  hoverId: string | null = null;

  readonly sceneCanvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private holder: HTMLElement;
  private container: HTMLElement;
  private drag: DragState | null = null;
  private spaceDown = false;
  private ro?: ResizeObserver;
  private windowListeners: (() => void)[] = [];

  constructor(
    root: HTMLElement,
    private store: Store,
    private preview: PreviewRenderer,
    private cb: StageCallbacks,
  ) {
    this.container = qs<HTMLElement>('.stage', root)!;
    this.holder = qs<HTMLElement>('.canvas-holder', root)!;
    this.sceneCanvas = qs<HTMLCanvasElement>('#scene-canvas', root)!;
    this.overlay = qs<HTMLCanvasElement>('#overlay-canvas', root)!;
    this.octx = this.overlay.getContext('2d')!;

    this.bind();
    store.on('scene', () => this.drawOverlay());
    store.on('selection', () => this.drawOverlay());
    store.on('playback', () => this.drawOverlay());

    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.container);
    requestAnimationFrame(() => this.refit());
  }

  /* ------------------------------------------------------------- viewport */

  refit() {
    const pad = 44;
    const w = this.container.clientWidth - pad;
    const h = this.container.clientHeight - pad;
    if (w <= 10 || h <= 10) return;
    this.preview.resize(w, h);
    this.overlay.width = this.sceneCanvas.width;
    this.overlay.height = this.sceneCanvas.height;
    this.overlay.style.width = this.sceneCanvas.style.width;
    this.overlay.style.height = this.sceneCanvas.style.height;
    this.applyTransform();
    this.drawOverlay();
  }

  private applyTransform() {
    this.holder.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  setZoom(z: number, anchor?: { x: number; y: number }) {
    const next = clamp(z, 0.1, 8);
    if (anchor) {
      const rect = this.container.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const vx = (anchor.x - cx - this.panX) / this.zoom;
      const vy = (anchor.y - cy - this.panY) / this.zoom;
      this.panX = anchor.x - cx - vx * next;
      this.panY = anchor.y - cy - vy * next;
    }
    this.zoom = next;
    this.applyTransform();
    this.store.emit('status', null);
  }

  resetView() { this.zoom = 1; this.panX = 0; this.panY = 0; this.applyTransform(); }

  get zoomPercent(): number {
    const cssW = parseFloat(this.sceneCanvas.style.width || '1');
    return Math.round((cssW * this.zoom / this.store.scene.canvas.width) * 100);
  }

  screenToScene(clientX: number, clientY: number) {
    const r = this.sceneCanvas.getBoundingClientRect();
    const s = this.store.scene.canvas;
    return {
      x: ((clientX - r.left) / r.width) * s.width,
      y: ((clientY - r.top) / r.height) * s.height,
    };
  }

  setSpace(down: boolean) {
    this.spaceDown = down;
    this.container.style.cursor = down ? 'grab' : '';
  }

  /* --------------------------------------------------------------- events */

  private bind() {
    on(this.container, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.windowListeners.push(on(window, 'pointermove', (e) => this.onPointerMove(e as PointerEvent)));
    this.windowListeners.push(on(window, 'pointerup', (e) => this.onPointerUp(e as PointerEvent)));
    on(this.container, 'wheel', (e) => {
      const ev = e as WheelEvent;
      ev.preventDefault();
      if (ev.shiftKey) {
        this.panX -= ev.deltaY; this.applyTransform();
      } else {
        const factor = Math.exp(-ev.deltaY * 0.0016);
        this.setZoom(this.zoom * factor, { x: ev.clientX, y: ev.clientY });
      }
    }, { passive: false });

    on(this.container, 'dblclick', (e) => {
      const p = this.screenToScene((e as MouseEvent).clientX, (e as MouseEvent).clientY);
      this.cb.onDoubleClick(this.hitTest(p.x, p.y));
    });

    on(this.container, 'dragover', (e) => {
      const ev = e as DragEvent;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      this.holder.classList.add('drop-target');
    });
    on(this.container, 'dragleave', () => this.holder.classList.remove('drop-target'));
    on(this.container, 'drop', (e) => {
      const ev = e as DragEvent;
      ev.preventDefault();
      this.holder.classList.remove('drop-target');
      const dt = ev.dataTransfer;
      if (!dt) return;
      const p = this.screenToScene(ev.clientX, ev.clientY);
      const assetId = dt.getData('application/x-imago-asset');
      const effectId = dt.getData('application/x-imago-effect');
      if (assetId) this.cb.onDropAsset(assetId, p.x, p.y);
      else if (effectId) this.cb.onDropEffect(effectId, p.x, p.y);
    });
  }

  private handlePositions(n: SceneNode): { id: HandleId; x: number; y: number }[] {
    const hw = n.width / 2, hh = n.height / 2;
    const a = rad(n.rotation);
    const local: [HandleId, number, number][] = [
      ['nw', -hw, -hh], ['n', 0, -hh], ['ne', hw, -hh], ['e', hw, 0],
      ['se', hw, hh], ['s', 0, hh], ['sw', -hw, hh], ['w', -hw, 0],
    ];
    const out = local.map(([id, lx, ly]) => {
      const p = rotatePoint(n.x + lx, n.y + ly, n.x, n.y, a);
      return { id, x: p.x, y: p.y };
    });
    const rotDist = hh + this.pxToScene(30);
    const rp = rotatePoint(n.x, n.y - rotDist, n.x, n.y, a);
    out.push({ id: 'rot', x: rp.x, y: rp.y });
    return out;
  }

  private pxToScene(px: number): number {
    const r = this.sceneCanvas.getBoundingClientRect();
    return (px / Math.max(1, r.width)) * this.store.scene.canvas.width;
  }

  /** Water-mask vertices are circles; the usual resize handles stay square. */
  private waterPointPositions(n: SceneNode): { index: number; x: number; y: number }[] {
    const def = n.effect ? EFFECT_MAP.get(n.effect.effectId) : undefined;
    if (!def?.waterShape) return [];
    return readWaterShape(n.effect!.params.waterShape).map((pt, index) => {
      const lx = (pt.x - 0.5) * n.width * (n.flipX ? -1 : 1);
      const ly = (pt.y - 0.5) * n.height;
      const p = rotatePoint(n.x + lx, n.y + ly, n.x, n.y, rad(n.rotation));
      return { index, x: p.x, y: p.y };
    });
  }

  private hitWaterPoint(x: number, y: number): { node: SceneNode; index: number } | null {
    const tol = this.pxToScene(9);
    for (const n of this.store.selected) {
      if (n.locked) continue;
      for (const pt of this.waterPointPositions(n)) {
        if (Math.hypot(pt.x - x, pt.y - y) <= tol) return { node: n, index: pt.index };
      }
    }
    return null;
  }

  private hitHandle(x: number, y: number): { node: SceneNode; handle: HandleId } | null {
    const tol = this.pxToScene(9);
    for (const n of this.store.selected) {
      if (n.locked) continue;
      for (const h of this.handlePositions(n)) {
        if (Math.hypot(h.x - x, h.y - y) <= tol) return { node: n, handle: h.id };
      }
    }
    return null;
  }

  hitTest(x: number, y: number): SceneNode | null {
    const nodes = paintOrder(this.store.scene).reverse();
    for (const n of nodes) {
      if (!n.visible || n.locked) continue;
      const p = rotatePoint(x, y, n.x, n.y, -rad(n.rotation));
      if (Math.abs(p.x - n.x) <= n.width / 2 && Math.abs(p.y - n.y) <= n.height / 2) {
        // Full-scene effects never intercept object editing. The individually
        // bounded spiritual ornaments can be selected when Layer 4 is active.
        if (n.kind === 'effect') {
          const def = n.effect ? EFFECT_MAP.get(n.effect.effectId) : undefined;
          if (this.cb.canSelectSpiritual() && (def?.family === 'spiritual' || def?.bounded)) {
            if (def?.waterShape) {
              const x = (p.x - n.x) * (n.flipX ? -1 : 1) + n.width / 2;
              const y = p.y - n.y + n.height / 2;
              if (waterShapeFeather(x, y, n.width, n.height, readWaterShape(n.effect!.params.waterShape)) <= 0) continue;
            }
            return n;
          }
          continue;
        }
        return n;
      }
    }
    return null;
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button === 1 || this.spaceDown) {
      this.drag = {
        mode: 'pan', startPointer: { x: e.clientX, y: e.clientY }, originals: [],
        panStart: { x: this.panX, y: this.panY }, aspect: 1, moved: false,
      };
      this.container.classList.add('panning');
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const p = this.screenToScene(e.clientX, e.clientY);

    const wp = this.hitWaterPoint(p.x, p.y);
    if (wp) {
      this.store.pushHistory('Reshape water');
      this.drag = {
        mode: 'water-point', startPointer: p, originals: [this.snapshot(wp.node)],
        waterIndex: wp.index, waterPoints: readWaterShape(wp.node.effect!.params.waterShape),
        waterFlip: wp.node.flipX, panStart: { x: 0, y: 0 }, aspect: 1, moved: false,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }

    const hh = this.hitHandle(p.x, p.y);
    if (hh) {
      this.store.pushHistory(hh.handle === 'rot' ? 'Rotate' : 'Resize');
      this.drag = {
        mode: hh.handle === 'rot' ? 'rotate' : 'resize',
        startPointer: p, handle: hh.handle,
        originals: [this.snapshot(hh.node)],
        panStart: { x: 0, y: 0 },
        aspect: hh.node.width / Math.max(1, hh.node.height), moved: false,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }

    const hit = this.hitTest(p.x, p.y);
    if (hit) {
      if (!this.store.selection.includes(hit.id)) this.store.select(hit.id, e.shiftKey);
      else if (e.shiftKey) this.store.select(this.store.selection.filter((id) => id !== hit.id));
      const movable = this.store.selected.filter((n) => !n.locked);
      if (movable.length) {
        this.store.pushHistory('Move');
        this.drag = {
          mode: 'move', startPointer: p, originals: movable.map((n) => this.snapshot(n)),
          panStart: { x: 0, y: 0 }, aspect: 1, moved: false,
        };
        this.container.classList.add('dragging');
      }
    } else {
      this.store.select([]);
    }
  }

  private snapshot(n: SceneNode) {
    return { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation };
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.drag) {
      if (this.container.matches(':hover')) {
        const p = this.screenToScene(e.clientX, e.clientY);
        // Handle cursor first: a corner must announce that it scales in
        // proportion, an edge that it stretches one axis.
        const wp = this.hitWaterPoint(p.x, p.y);
        const hh = this.hitHandle(p.x, p.y);
        if (wp) {
          this.sceneCanvas.style.cursor = 'crosshair';
        } else if (hh) {
          this.sceneCanvas.style.cursor = handleCursor(hh.handle);
        } else {
          this.sceneCanvas.style.cursor = '';
        }
        const hit = this.hitTest(p.x, p.y);
        const id = hit?.id ?? null;
        if (id !== this.hoverId) { this.hoverId = id; this.drawOverlay(); }
      }
      return;
    }
    const d = this.drag;
    d.moved = true;
    if (d.mode === 'pan') {
      this.panX = d.panStart.x + (e.clientX - d.startPointer.x);
      this.panY = d.panStart.y + (e.clientY - d.startPointer.y);
      this.applyTransform();
      return;
    }
    const p = this.screenToScene(e.clientX, e.clientY);
    this.store.mutate((scene) => {
      for (const o of d.originals) {
        const n = scene.nodes.find((x) => x.id === o.id);
        if (!n || n.locked) continue;
        if (d.mode === 'water-point') {
          this.applyWaterPoint(n, o, p, d);
        } else if (d.mode === 'move') {
          let dx = p.x - d.startPointer.x;
          let dy = p.y - d.startPointer.y;
          if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          n.x = o.x + dx; n.y = o.y + dy;
        } else if (d.mode === 'rotate') {
          const ang = Math.atan2(p.y - o.y, p.x - o.x) * 180 / Math.PI + 90;
          n.rotation = e.shiftKey ? Math.round(ang / 15) * 15 : Math.round(ang * 10) / 10;
        } else if (d.mode === 'resize') {
          this.applyResize(n, o, p, d.handle!, d.aspect, !e.altKey);
        }
      }
    });
  }

  private applyWaterPoint(
    n: SceneNode, o: DragState['originals'][number], p: { x: number; y: number }, d: DragState,
  ) {
    if (!n.effect || d.waterIndex === undefined || !d.waterPoints) return;
    const local = rotatePoint(p.x, p.y, o.x, o.y, -rad(o.rotation));
    const flip = d.waterFlip ? -1 : 1;
    const px = (local.x - o.x) * flip + o.width / 2;
    const py = local.y - o.y + o.height / 2;
    // Expand the effect's rectangle when a vertex is dragged outside it; the
    // other seven points stay in exactly the same place on the scene.
    const left = Math.min(0, px), right = Math.max(o.width, px);
    const top = Math.min(0, py), bottom = Math.max(o.height, py);
    const width = Math.max(8, right - left), height = Math.max(8, bottom - top);
    const shift = rotatePoint(((left + right) / 2 - o.width / 2) * flip,
      (top + bottom) / 2 - o.height / 2, 0, 0, rad(o.rotation));
    n.x = o.x + shift.x; n.y = o.y + shift.y;
    n.width = width; n.height = height;
    n.effect.params.waterShape = JSON.stringify(d.waterPoints.map((pt, i) => ({
      x: clamp(((i === d.waterIndex ? px : pt.x * o.width) - left) / width, 0, 1),
      y: clamp(((i === d.waterIndex ? py : pt.y * o.height) - top) / height, 0, 1),
    })));
  }

  private applyResize(
    n: SceneNode, o: DragState['originals'][number], p: { x: number; y: number },
    handle: HandleId, aspect: number, keepAspect: boolean,
  ) {
    const a = rad(o.rotation);
    const local = rotatePoint(p.x, p.y, o.x, o.y, -a);
    const lx = local.x - o.x, ly = local.y - o.y;
    let left = -o.width / 2, right = o.width / 2, top = -o.height / 2, bottom = o.height / 2;
    if (handle.includes('w')) left = Math.min(lx, right - 8);
    if (handle.includes('e')) right = Math.max(lx, left + 8);
    if (handle.includes('n')) top = Math.min(ly, bottom - 8);
    if (handle.includes('s')) bottom = Math.max(ly, top + 8);
    let w = right - left, h = bottom - top;
    if (keepAspect && handle.length === 2) {
      if (w / h > aspect) { const nh = w / aspect; top = bottom - nh; h = nh; }
      else { const nw = h * aspect; if (handle.includes('w')) left = right - nw; else right = left + nw; w = nw; }
    }
    const ox = (left + right) / 2, oy = (top + bottom) / 2;
    const shift = rotatePoint(ox, oy, 0, 0, a);
    n.width = Math.max(8, w);
    n.height = Math.max(8, h);
    n.x = o.x + shift.x;
    n.y = o.y + shift.y;
  }

  private onPointerUp(_e: PointerEvent) {
    if (!this.drag) return;
    const wasInteraction = this.drag.moved;
    this.drag = null;
    this.container.classList.remove('panning', 'dragging');
    if (wasInteraction) {
      // The snapshot was pushed at pointer-down; drop it again if nothing moved.
      this.store.emit('scene');
    }
  }

  /* -------------------------------------------------------------- overlay */

  drawOverlay() {
    const ctx = this.octx;
    const scene = this.store.scene;
    const W = this.overlay.width, H = this.overlay.height;
    if (!W || !H) return;
    const s = W / scene.canvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.scale(s, s);
    const px = this.pxToScene(1);

    // Canvas boundary + overflow zone
    if (this.showOverflow) {
      ctx.strokeStyle = 'rgba(94,234,212,0.30)';
      ctx.lineWidth = px * 1.2;
      ctx.setLineDash([px * 7, px * 5]);
      ctx.strokeRect(0, 0, scene.canvas.width, scene.canvas.height);
      ctx.setLineDash([]);
    }

    // Hover outline
    if (this.hoverId && !this.store.selection.includes(this.hoverId)) {
      const n = scene.nodes.find((x) => x.id === this.hoverId);
      if (n) this.outline(ctx, n, 'rgba(255,255,255,0.35)', px * 1.2, false);
    }

    for (const n of this.store.selected) {
      const colour = n.locked ? '#f5c97b' : '#5eead4';
      this.outline(ctx, n, colour, px * 1.6, true);
      if (n.locked) continue;
      const waterPoints = this.waterPointPositions(n);
      if (waterPoints.length) {
        ctx.save();
        ctx.strokeStyle = '#9bdcf7';
        ctx.lineWidth = px * 1.8;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(waterPoints[0].x, waterPoints[0].y);
        for (let i = 1; i < waterPoints.length; i++) ctx.lineTo(waterPoints[i].x, waterPoints[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
      const handles = this.handlePositions(n);
      const size = px * 4.5;
      const rot = handles.find((h) => h.id === 'rot')!;
      const top = handles.find((h) => h.id === 'n')!;
      ctx.strokeStyle = colour;
      ctx.lineWidth = px * 1.3;
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rot.x, rot.y); ctx.stroke();
      ctx.fillStyle = '#0b1017';
      ctx.beginPath(); ctx.arc(rot.x, rot.y, size * 1.15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // Corners scale IN PROPORTION and are drawn bigger and solid so the
      // difference is visible before you grab one. Edge handles are small and
      // hollow: they stretch a single axis. Hold Alt on a corner to stretch it.
      for (const h of handles) {
        if (h.id === 'rot') continue;
        const corner = h.id.length === 2;
        const s = corner ? size * 1.5 : size * 0.72;
        ctx.lineWidth = px * 1.4;
        ctx.strokeStyle = colour;
        ctx.fillStyle = corner ? colour : '#0b1017';
        ctx.beginPath();
        ctx.rect(h.x - s, h.y - s, s * 2, s * 2);
        ctx.fill(); ctx.stroke();
        if (corner) {
          // A tiny diagonal tick reads as "drag me outward".
          const dx = h.id.includes('w') ? -1 : 1;
          const dy = h.id.includes('n') ? -1 : 1;
          ctx.strokeStyle = '#0b1017';
          ctx.lineWidth = px * 1.5;
          ctx.beginPath();
          ctx.moveTo(h.x - dx * s * 0.42, h.y - dy * s * 0.42);
          ctx.lineTo(h.x + dx * s * 0.42, h.y + dy * s * 0.42);
          ctx.stroke();
        }
      }
      // Draw circles last so they remain distinguishable from square resize
      // handles, even when a vertex is close to the rectangular frame.
      for (const pt of waterPoints) {
        ctx.fillStyle = '#d9f6ff';
        ctx.strokeStyle = '#123f55';
        ctx.lineWidth = px * 1.5;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, px * 6, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  private outline(ctx: CanvasRenderingContext2D, n: SceneNode, colour: string, lw: number, dashed: boolean) {
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.rotate(rad(n.rotation));
    ctx.strokeStyle = colour;
    ctx.lineWidth = lw;
    if (dashed && n.kind === 'effect') ctx.setLineDash([lw * 6, lw * 4]);
    ctx.strokeRect(-n.width / 2, -n.height / 2, n.width, n.height);
    ctx.setLineDash([]);
    ctx.restore();
  }

  dispose() { this.ro?.disconnect(); this.windowListeners.splice(0).forEach((remove) => remove()); }
}
