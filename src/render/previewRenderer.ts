/**
 * PREVIEW RENDERER
 * ================
 * Drives the live canvas. Deliberately lower resolution than export: it renders
 * at the on-screen size (capped) with reduced deformation detail, so a scene
 * with many animated objects stays interactive on ordinary hardware.
 *
 * Playback time is real time, but every frame is evaluated from the absolute
 * scene time, so pausing, scrubbing and exporting all agree exactly.
 */
import type { Store } from '../core/store';
import { clamp } from '../core/util';
import type { Compositor } from './compositor';
import type { ImageCache } from './imageCache';

export interface PreviewStats {
  fps: number;
  renderMs: number;
  width: number;
  height: number;
  scale: number;
}

export class PreviewRenderer {
  playing = false;
  time = 0;
  maxDimension = 1400;
  quality: 'preview' | 'export' = 'preview';
  stats: PreviewStats = { fps: 0, renderMs: 0, width: 0, height: 0, scale: 1 };
  soloLayer: string | null = null;
  soloNode: string | null = null;

  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private lastTick = 0;
  private needsRender = true;
  private frameTimes: number[] = [];
  private disposed = false;
  private pendingLoads = new Set<string>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private store: Store,
    private compositor: Compositor,
    private images: ImageCache,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
    this.ctx = ctx;
    store.on('scene', () => this.invalidate());
    store.on('selection', () => this.invalidate());
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  invalidate() { this.needsRender = true; }

  play() {
    this.playing = true;
    this.lastTick = performance.now();
    this.store.emit('playback');
  }

  pause() {
    this.playing = false;
    this.store.emit('playback');
    this.invalidate();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  restart() { this.time = 0; this.invalidate(); this.store.emit('playback'); }

  seek(t: number) {
    this.time = Math.max(0, t);
    this.invalidate();
    this.store.emit('playback');
  }

  /** Size the backing store to the element, capped for performance. */
  resize(cssWidth: number, cssHeight: number) {
    const scene = this.store.scene;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    let scale = Math.min(cssWidth / scene.canvas.width, cssHeight / scene.canvas.height) * dpr;
    const longest = Math.max(scene.canvas.width, scene.canvas.height) * scale;
    if (longest > this.maxDimension) scale *= this.maxDimension / longest;
    const w = Math.max(2, Math.round(scene.canvas.width * scale));
    const h = Math.max(2, Math.round(scene.canvas.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${Math.round(scene.canvas.width * scale / dpr)}px`;
    this.canvas.style.height = `${Math.round(scene.canvas.height * scale / dpr)}px`;
    this.stats.width = w; this.stats.height = h; this.stats.scale = scale;
    this.invalidate();
  }

  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;
    if (this.playing) {
      this.time += Math.min(dt, 0.1);
      this.needsRender = true;
      this.store.emit('playback');
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    this.draw();
  }

  private draw() {
    const scene = this.store.scene;
    if (!this.canvas.width || !this.canvas.height) return;
    const scale = this.canvas.width / scene.canvas.width;
    const t0 = performance.now();
    this.pendingLoads.clear();
    this.compositor.render(this.ctx, scene, {
      scale,
      quality: this.quality,
      time: this.time,
      layers: this.soloLayer ? [this.soloLayer as never] : undefined,
      onlyNode: this.soloNode ?? undefined,
      onMissingAsset: (id) => this.pendingLoads.add(id),
    });
    const ms = performance.now() - t0;
    this.stats.renderMs = ms;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.stats.fps = avg > 0 ? Math.min(120, 1000 / Math.max(avg, 1000 / 60)) : 0;
    if (this.pendingLoads.size) {
      // Only redraw when an image actually arrived: re-rendering on a failed
      // or still-queued load would spin the render loop against nothing.
      void this.images.ensure(Array.from(this.pendingLoads))
        .then((loaded) => { if (loaded > 0) this.invalidate(); });
    }
  }

  /** Render one frame to a blob (used for project thumbnails). */
  async thumbnail(maxDim = 480): Promise<Blob | undefined> {
    const scene = this.store.scene;
    const scale = maxDim / Math.max(scene.canvas.width, scene.canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.round(scene.canvas.width * scale);
    c.height = Math.round(scene.canvas.height * scale);
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    await this.images.ensure(scene.nodes.map((n) => n.assetId));
    this.compositor.render(ctx, scene, { scale, quality: 'preview', time: this.time });
    return new Promise((resolve) => c.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.82));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
  }
}
