/**
 * Lazy image cache.
 *
 * Artwork is decoded once into ImageBitmaps and shared by every node that uses
 * the same asset, so adding twenty grass tufts costs one decode, not twenty.
 * A soft capacity keeps memory bounded during long editing sessions.
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
  private library: AssetLibrary;
  maxBytes = 420 * 1024 * 1024;   // decoded budget; evicted least-recently-used
  private usedBytes = 0;
  misses = 0;

  constructor(library: AssetLibrary) { this.library = library; }

  /** Synchronous access for the render loop. Returns null while decoding. */
  peek(id: string | undefined): Entry | null {
    if (!id) return null;
    const e = this.entries.get(id);
    if (e) { e.lastUsed = performance.now(); return e; }
    this.misses++;
    void this.load(id);
    return null;
  }

  async load(id: string): Promise<Entry | null> {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const meta = this.library.get(id);
    if (!meta) return null;
    const p = this.decode(meta);
    this.pending.set(id, p);
    try {
      const entry = await p;
      if (entry) {
        this.entries.set(id, entry);
        this.usedBytes += entry.bytes;
        this.evict();
      }
      return entry;
    } finally {
      this.pending.delete(id);
    }
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

  async ensure(ids: (string | undefined)[]): Promise<void> {
    await Promise.all(Array.from(new Set(ids.filter(Boolean) as string[])).map((id) => this.load(id)));
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
    return { count: this.entries.size, bytes: this.usedBytes, pending: this.pending.size };
  }

  clear() {
    for (const e of this.entries.values()) if ('close' in e.bitmap) (e.bitmap as ImageBitmap).close();
    this.entries.clear();
    this.usedBytes = 0;
  }
}
