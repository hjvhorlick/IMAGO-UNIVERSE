/**
 * Lazy image cache.
 *
 * Artwork is decoded once into ImageBitmaps and shared by every node that uses
 * the same asset, so adding twenty grass tufts costs one decode, not twenty.
 * A soft capacity keeps memory bounded during long editing sessions.
 *
 * Loading is deliberately gentle on the main thread and on the network:
 *  - at most `maxConcurrent` decodes run at once, the rest wait in a queue, so
 *    opening a world full of artwork cannot saturate the browser;
 *  - ids that fail to load enter a cooldown, so a missing or corrupt file is
 *    retried once every twenty seconds instead of once per rendered frame;
 *  - `ensure` reports how many images actually arrived, letting callers skip
 *    pointless re-renders while something is still missing.
 */
import type { AssetLibrary } from '../assets/library';
import type { AssetMeta } from '../core/types';

interface Entry {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  lastUsed: number;
  bytes: number;
}

export class ImageCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry | null>>();
  private failed = new Map<string, number>();
  private queue: Array<() => void> = [];
  private running = 0;
  private library: AssetLibrary;
  maxBytes = 420 * 1024 * 1024;   // decoded budget; evicted least-recently-used
  maxConcurrent = 6;             // simultaneous decodes; more would stall the UI
  retryAfterMs = 20_000;         // cooldown before a failed id is tried again
  /** Called whenever the in-flight count changes, so the UI can show progress. */
  onActivity: (() => void) | null = null;
  private usedBytes = 0;
  misses = 0;

  constructor(library: AssetLibrary) { this.library = library; }

  /** Synchronous access for the render loop. Returns null while decoding. */
  peek(id: string | undefined): Entry | null {
    if (!id) return null;
    const e = this.entries.get(id);
    if (e) { e.lastUsed = performance.now(); return e; }
    this.misses++;
    if (!this.coolingDown(id)) void this.load(id);
    return null;
  }

  async load(id: string): Promise<Entry | null> {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    if (this.coolingDown(id)) return null;
    const meta = this.library.get(id);
    if (!meta) {
      this.failed.set(id, performance.now());
      return null;
    }
    const p = this.schedule(meta);
    this.pending.set(id, p);
    try {
      const entry = await p;
      if (entry) {
        this.entries.set(id, entry);
        this.usedBytes += entry.bytes;
        this.failed.delete(id);
        this.evict();
      } else {
        this.failed.set(id, performance.now());
      }
      return entry;
    } finally {
      this.pending.delete(id);
      this.onActivity?.();
    }
  }

  /** Queue one decode, keeping at most `maxConcurrent` running at a time. */
  private schedule(meta: AssetMeta): Promise<Entry | null> {
    return new Promise((resolve) => {
      const start = () => {
        this.decode(meta).then((entry) => {
          this.running--;
          const next = this.queue.shift();
          if (next) next(); else this.onActivity?.();
          resolve(entry);
        });
      };
      if (this.running < this.maxConcurrent) {
        this.running++;
        this.onActivity?.();
        start();
      } else {
        this.queue.push(() => { this.running++; this.onActivity?.(); start(); });
      }
    });
  }

  private coolingDown(id: string): boolean {
    const at = this.failed.get(id);
    return at !== undefined && performance.now() - at < this.retryAfterMs;
  }

  private async decode(meta: AssetMeta): Promise<Entry | null> {
    const url = this.library.url(meta);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      let bitmap: ImageBitmap | HTMLImageElement;
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(blob);
      } else {
        bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image decode failed'));
          img.src = URL.createObjectURL(blob);
        });
      }
      const width = (bitmap as ImageBitmap).width;
      const height = (bitmap as ImageBitmap).height;
      return { bitmap, width, height, lastUsed: performance.now(), bytes: width * height * 4 };
    } catch (err) {
      console.error(`[images] failed to load ${meta.id}`, err);
      return null;
    }
  }

  /** Load everything listed; resolves with the number of images that arrived. */
  async ensure(ids: (string | undefined)[]): Promise<number> {
    const uniq = Array.from(new Set(ids.filter(Boolean) as string[]));
    const had = uniq.map((id) => this.entries.has(id));
    const results = await Promise.all(uniq.map((id) => this.load(id)));
    return results.filter((r, i) => r && !had[i]).length;
  }

  private evict() {
    if (this.usedBytes <= this.maxBytes) return;
    const sorted = Array.from(this.entries.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, e] of sorted) {
      if (this.usedBytes <= this.maxBytes * 0.8) break;
      if ('close' in e.bitmap) (e.bitmap as ImageBitmap).close();
      this.entries.delete(id);
      this.usedBytes -= e.bytes;
    }
  }

  get stats() {
    return {
      count: this.entries.size, bytes: this.usedBytes, pending: this.pending.size,
      queued: this.queue.length, failed: this.failed.size,
    };
  }

  clear() {
    for (const e of this.entries.values()) if ('close' in e.bitmap) (e.bitmap as ImageBitmap).close();
    this.entries.clear();
    this.failed.clear();
    this.usedBytes = 0;
  }
}
