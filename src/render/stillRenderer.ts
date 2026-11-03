/**
 * STILL IMAGE RENDERER
 * ====================
 * Renders the scene alone - no editor furniture, no selection handles - at the
 * requested resolution, then encodes PNG / JPEG / WebP.
 */
import type { Scene } from '../core/types';
import type { AssetLibrary } from '../assets/library';
import type { Compositor } from './compositor';
import type { ImageCache } from './imageCache';

export interface StillOptions {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  time: number;
}

export interface StillResult { blob: Blob; width: number; height: number }

export const MAX_STILL_PIXELS = 40_000_000;   // ~8K square; guards against OOM

export class StillRenderer {
  constructor(
    private compositor: Compositor,
    private images: ImageCache,
    private library: AssetLibrary,
  ) {}

  async render(scene: Scene, opts: StillOptions): Promise<StillResult> {
    const pixels = opts.width * opts.height;
    if (pixels > MAX_STILL_PIXELS) {
      throw new Error(
        `${opts.width}x${opts.height} is ${(pixels / 1e6).toFixed(0)} MP, above the safe `
        + `${(MAX_STILL_PIXELS / 1e6).toFixed(0)} MP browser limit. Choose a smaller resolution.`,
      );
    }
    await this.images.ensure(scene.nodes.map((n) => n.assetId));
    const missing = scene.nodes
      .filter((n) => n.kind === 'asset' && n.assetId && !this.library.get(n.assetId))
      .map((n) => n.name);
    if (missing.length) {
      throw new Error(`Cannot render: artwork missing for ${missing.slice(0, 3).join(', ')}.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const ctx = canvas.getContext('2d', { alpha: opts.format === 'png' });
    if (!ctx) throw new Error('Could not create a rendering canvas.');
    const scale = opts.width / scene.canvas.width;
    this.compositor.render(ctx, scene, { scale, quality: 'export', time: opts.time });

    const mime = opts.format === 'png' ? 'image/png' : opts.format === 'webp' ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, opts.format === 'png' ? undefined : opts.quality));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error(`The browser could not encode ${opts.format.toUpperCase()}.`);
    if (blob.size < 128) throw new Error('The encoder produced an empty image.');
    if (opts.format === 'webp' && blob.type === 'image/png') {
      throw new Error('This browser cannot encode WebP. Use PNG or JPEG instead.');
    }
    return { blob, width: opts.width, height: opts.height };
  }
}
