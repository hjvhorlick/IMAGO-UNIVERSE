/**
 * EXPORT MANAGER
 * ==============
 * One place that owns "produce a deliverable". It never touches the editable
 * project: exporting can not flatten, overwrite or otherwise damage the scene.
 * Every path here either returns a real, finished file or throws with a reason.
 */
import type { AssetLibrary } from '../assets/library';
import type { Scene } from '../core/types';
import { downloadBlob } from '../core/util';
import type { Compositor } from '../render/compositor';
import type { ImageCache } from '../render/imageCache';
import { StillRenderer } from '../render/stillRenderer';
import { VideoRenderer, detectCapabilities } from '../render/videoRenderer';
import type { ExportProgress, VideoOptions, VideoResult, Capabilities } from '../render/videoRenderer';
import type { LoopManager } from '../animation/loopManager';
import { packageProject } from '../project/projectFormat';

export const RESOLUTIONS = [
  { label: '720p', height: 720 },
  { label: '1080p', height: 1080 },
  { label: '1440p', height: 1440 },
  { label: '4K UHD', height: 2160 },
];

export const DURATIONS = [
  { label: '15 seconds', value: 15 },
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '10 minutes', value: 600 },
  { label: '30 minutes', value: 1800 },
  { label: '60 minutes', value: 3600 },
];

export const QUALITY_BITRATE: Record<string, number> = {
  draft: 3_000_000, standard: 8_000_000, high: 16_000_000, master: 32_000_000,
};

export function dimensionsFor(scene: Scene, height: number) {
  const scale = height / scene.canvas.height;
  // H.264 requires even dimensions.
  const w = Math.max(2, Math.round(scene.canvas.width * scale / 2) * 2);
  const h = Math.max(2, Math.round(height / 2) * 2);
  return { width: w, height: h };
}

export class ExportManager {
  readonly still: StillRenderer;
  readonly video: VideoRenderer;
  private currentAbort: AbortController | null = null;

  constructor(
    compositor: Compositor, images: ImageCache, library: AssetLibrary, loops: LoopManager,
    private libraryRef: AssetLibrary,
  ) {
    this.still = new StillRenderer(compositor, images, library);
    this.video = new VideoRenderer(compositor, images, library, loops);
  }

  capabilities(width: number, height: number, fps: number, bitrate: number): Promise<Capabilities> {
    return detectCapabilities(width, height, fps, bitrate);
  }

  async exportStill(scene: Scene, opts: {
    width: number; height: number; format: 'png' | 'jpeg' | 'webp'; quality: number; time: number;
  }, baseName: string) {
    const result = await this.still.render(scene, opts);
    const ext = opts.format === 'jpeg' ? 'jpg' : opts.format;
    downloadBlob(result.blob, `${baseName}-${opts.width}x${opts.height}.${ext}`);
    return result;
  }

  async exportVideo(scene: Scene, opts: VideoOptions, baseName: string): Promise<VideoResult> {
    this.currentAbort = new AbortController();
    const result = await this.video.render(scene, { ...opts, signal: this.currentAbort.signal }, baseName);
    this.currentAbort = null;
    return result;
  }

  cancel() { this.currentAbort?.abort(); }

  get running() { return this.currentAbort !== null; }

  async exportProject(scene: Scene, preview?: Blob, baseName = 'world') {
    const blob = await packageProject(scene, this.libraryRef, preview);
    downloadBlob(blob, `${baseName}.sceneproject`);
    return blob;
  }
}

export function describeProgress(p: ExportProgress): string {
  const pct = `${Math.round(p.progress * 100)}%`;
  const eta = p.etaSeconds != null && p.etaSeconds > 1
    ? ` - about ${p.etaSeconds > 90 ? `${Math.round(p.etaSeconds / 60)} min` : `${Math.round(p.etaSeconds)} s`} left`
    : '';
  return `${pct}${eta}`;
}
