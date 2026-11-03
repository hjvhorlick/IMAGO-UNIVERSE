/**
 * VIDEO RENDERER
 * ==============
 * Two independent strategies, chosen from what the browser can actually do.
 *
 * A. WebCodecs + MP4 muxer (preferred, H.264 in MP4)
 *    Frames are rendered off-line as fast as the machine allows - not in real
 *    time - and encoded with a hardware H.264 encoder where available.
 *
 *    The important trick for long videos: when the scene is exactly periodic
 *    and no animation has a start/stop window, we encode ONE master cycle and
 *    then re-mux those same encoded samples with shifted timestamps until the
 *    requested duration is reached. A 60-minute video therefore costs one
 *    cycle of rendering, and because the samples are identical the loop is
 *    bit-exact rather than "nearly seamless".
 *
 *    Output is streamed to disk (File System Access, or the Origin Private
 *    File System) so an hour of 1080p never sits in RAM.
 *
 * B. MediaRecorder fallback (WebM)
 *    Used when WebCodecs or H.264 is unavailable. This captures the canvas in
 *    real time, so a 30-minute video takes 30 minutes. We say so up front
 *    instead of pretending otherwise.
 *
 * Nothing here reports success until the muxer has been finalised and the
 * output file actually has bytes.
 */
import {
  Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget,
} from 'mp4-muxer';
import type { Scene } from '../core/types';
import { clamp } from '../core/util';
import type { AssetLibrary } from '../assets/library';
import type { Compositor } from './compositor';
import type { ImageCache } from './imageCache';
import { LoopManager } from '../animation/loopManager';

export interface VideoOptions {
  width: number;
  height: number;
  fps: number;
  duration: number;         // seconds
  bitrate: number;          // bits/s
  format: 'mp4' | 'webm';
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
  preferFilePicker?: boolean;
  /** A handle obtained from showSaveFilePicker during the user's click. */
  fileHandle?: FileSystemFileHandle;
}

export interface ExportProgress {
  phase: 'preparing' | 'encoding' | 'assembling' | 'finalizing' | 'done' | 'error';
  progress: number;         // 0..1
  message: string;
  framesDone?: number;
  framesTotal?: number;
  bytes?: number;
  etaSeconds?: number;
}

export interface VideoResult {
  blob: Blob;
  filename: string;
  bytes: number;
  frames: number;
  encodedFrames: number;
  method: 'webcodecs-loop-tile' | 'webcodecs-full' | 'mediarecorder';
  codec: string;
  duration: number;
  warnings: string[];
  cleanup?: () => Promise<void>;
  /** True when the file was written straight to a user-chosen location. */
  savedDirectly?: boolean;
}

export interface Capabilities {
  webcodecs: boolean;
  h264: boolean;
  h264Config?: VideoEncoderConfig;
  hardware: boolean;
  filePicker: boolean;
  opfs: boolean;
  mediaRecorder: boolean;
  webmMime?: string;
  notes: string[];
}

export const MAX_VIDEO_PIXELS = 12_000_000;      // ~4K UHD is 8.3 MP
export const MAX_IN_MEMORY_BYTES = 700 * 1024 * 1024;

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
  }
  interface FileSystemFileHandle {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }
}

export async function detectCapabilities(
  width: number, height: number, fps: number, bitrate: number,
): Promise<Capabilities> {
  const notes: string[] = [];
  const webcodecs = typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window;
  let h264 = false;
  let hardware = false;
  let config: VideoEncoderConfig | undefined;

  if (webcodecs) {
    const candidates: VideoEncoderConfig[] = [
      { codec: 'avc1.640034', width, height, bitrate, framerate: fps, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } },
      { codec: 'avc1.42003e', width, height, bitrate, framerate: fps, avc: { format: 'avc' } },
      { codec: 'avc1.42001f', width, height, bitrate, framerate: fps, avc: { format: 'avc' } },
    ];
    for (const c of candidates) {
      try {
        const VE = (window as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder;
        const support = await VE.isConfigSupported(c);
        if (support.supported) {
          h264 = true;
          config = support.config ?? c;
          hardware = c.hardwareAcceleration === 'prefer-hardware';
          break;
        }
      } catch { /* try the next profile */ }
    }
    if (!h264) notes.push('This browser has WebCodecs but no usable H.264 encoder.');
  } else {
    notes.push('WebCodecs is not available in this browser.');
  }

  const filePicker = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  const opfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  let mediaRecorder = false;
  let webmMime: string | undefined;
  if (typeof MediaRecorder !== 'undefined') {
    for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(m)) { mediaRecorder = true; webmMime = m; break; }
    }
  }
  if (!filePicker && !opfs) {
    notes.push('No disk streaming available: long exports are limited by free memory.');
  }
  if (width * height > MAX_VIDEO_PIXELS) {
    notes.push(`${width}x${height} exceeds the safe encoder limit for this device.`);
  }
  return { webcodecs, h264, h264Config: config, hardware, filePicker, opfs, mediaRecorder, webmMime, notes };
}

/** The frame plan produced by the Loop Manager plus the tiling decision. */
export interface TilePlan {
  cycleFrames: number;
  totalFrames: number;
  repeats: number;
  remainder: number;
  canTile: boolean;
}

/**
 * The heart of long-video export.
 *
 * Yields which *encoded* frame to write at each output position. When the scene
 * is exactly periodic we reuse the same encoded samples for every repeat, so a
 * 60-minute video costs one cycle of rendering and every repeat is bit-identical.
 * Each repeat starts at source frame 0, which is a key frame, so the stream
 * stays decodable at every loop boundary.
 */
export function* tileSequence(plan: TilePlan): Generator<{ src: number; out: number }> {
  if (!plan.canTile) {
    for (let i = 0; i < plan.totalFrames; i++) yield { src: i, out: i };
    return;
  }
  let out = 0;
  for (let r = 0; r < plan.repeats; r++) {
    for (let i = 0; i < plan.cycleFrames; i++) yield { src: i, out: out++ };
  }
  for (let i = 0; out < plan.totalFrames; i++) {
    yield { src: i % plan.cycleFrames, out: out++ };
  }
}

/* ------------------------------------------------------------------ */

interface OutputSink {
  target: ArrayBufferTarget | FileSystemWritableFileStreamTarget;
  filename: string;
  finish: () => Promise<{ blob: Blob; bytes: number; cleanup?: () => Promise<void>; savedDirectly?: boolean }>;
  abort: () => Promise<void>;
  streaming: boolean;
}

async function createSink(
  baseName: string, ext: string, opts: VideoOptions, caps: Capabilities, estimatedBytes: number,
): Promise<OutputSink> {
  const filename = `${baseName}.${ext}`;

  if (opts.fileHandle || (opts.preferFilePicker && caps.filePicker)) {
    try {
      const handle = opts.fileHandle ?? await window.showSaveFilePicker!({
        suggestedName: filename,
        types: [{ description: ext === 'mp4' ? 'MPEG-4 video' : 'WebM video', accept: { [ext === 'mp4' ? 'video/mp4' : 'video/webm']: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      return {
        target: new FileSystemWritableFileStreamTarget(writable, { chunkSize: 8 * 1024 * 1024 }),
        filename, streaming: true,
        finish: async () => {
          await writable.close();
          const file = await handle.getFile();
          // Already on disk at the location the user chose - no download needed.
          return { blob: file, bytes: file.size, savedDirectly: true };
        },
        abort: async () => { try { await writable.abort(); } catch { /* already closed */ } },
      };
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') throw new Error('Export cancelled - no save location chosen.');
      console.warn('[video] file picker failed, falling back', err);
    }
  }

  if (caps.opfs) {
    try {
      // Long videos are streamed into the Origin Private File System. Check the
      // quota first so we fail with a useful message instead of dying at 90%.
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const free = (est.quota ?? 0) - (est.usage ?? 0);
        if (est.quota && free < estimatedBytes * 1.15) {
          throw new Error(
            `Not enough browser storage for this export: about ${(estimatedBytes / 1e9).toFixed(1)} GB needed, `
            + `${(free / 1e9).toFixed(1)} GB free. Lower the bitrate or duration, free up space, or use `
            + `"Write straight to a file" to stream to disk instead.`,
          );
        }
      }
      const root = await navigator.storage.getDirectory();
      const name = `${baseName}-${Date.now()}.${ext}`;
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      return {
        target: new FileSystemWritableFileStreamTarget(writable, { chunkSize: 8 * 1024 * 1024 }),
        filename, streaming: true,
        finish: async () => {
          await writable.close();
          const file = await handle.getFile();
          return {
            blob: file,
            bytes: file.size,
            cleanup: async () => { try { await root.removeEntry(name); } catch { /* ignore */ } },
          };
        },
        abort: async () => {
          try { await writable.abort(); } catch { /* ignore */ }
          try { await root.removeEntry(name); } catch { /* ignore */ }
        },
      };
    } catch (err) {
      // A quota error is a real, actionable failure - do not silently fall back.
      if ((err as Error).message?.includes('Not enough browser storage')) throw err;
      console.warn('[video] OPFS streaming unavailable, falling back to memory', err);
    }
  }

  if (estimatedBytes > MAX_IN_MEMORY_BYTES) {
    throw new Error(
      `This browser cannot stream to disk, so the whole video would have to fit in memory `
      + `(about ${(estimatedBytes / 1e9).toFixed(1)} GB). Shorten the duration, lower the bitrate, `
      + `or use a recent Chrome/Edge/Safari to export long videos.`,
    );
  }
  const target = new ArrayBufferTarget();
  return {
    target, filename, streaming: false,
    finish: async () => {
      const blob = new Blob([target.buffer], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
      return { blob, bytes: blob.size };
    },
    abort: async () => { /* nothing on disk */ },
  };
}

/* ------------------------------------------------------------------ */

export class VideoRenderer {
  constructor(
    private compositor: Compositor,
    private images: ImageCache,
    private library: AssetLibrary,
    private loops: LoopManager,
  ) {}

  /** Explain, before anything runs, exactly what will happen. */
  plan(scene: Scene, opts: VideoOptions) {
    const report = this.loops.analyse(scene);
    const plan = this.loops.plan(opts.duration, report.master, opts.fps);
    const windowed = scene.nodes.some((n) => {
      const a = n.kind === 'effect' ? n.effect : n.animation;
      return !!a && (a.start > 0 || a.end > 0);
    });
    const canTile = report.exact && !windowed && plan.repeats >= 1;
    return {
      report, ...plan, windowed, canTile,
      framesToRender: canTile ? plan.cycleFrames : plan.totalFrames,
      estimatedBytes: (opts.bitrate / 8) * opts.duration,
    };
  }

  async render(scene: Scene, opts: VideoOptions, baseName = 'imago-world'): Promise<VideoResult> {
    const warnings: string[] = [];
    const progress = (p: ExportProgress) => opts.onProgress?.(p);
    const throwIfAborted = () => {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    };

    progress({ phase: 'preparing', progress: 0, message: 'Checking encoder support...' });
    if (opts.width * opts.height > MAX_VIDEO_PIXELS) {
      throw new Error(`${opts.width}x${opts.height} is beyond this device's safe encoding limit. Try 1080p.`);
    }
    const caps = await detectCapabilities(opts.width, opts.height, opts.fps, opts.bitrate);
    const useWebCodecs = opts.format === 'mp4' && caps.h264 && !!caps.h264Config;

    if (opts.format === 'mp4' && !useWebCodecs) {
      if (!caps.mediaRecorder) {
        throw new Error(
          'This browser can neither encode H.264 (WebCodecs) nor record WebM (MediaRecorder). '
          + 'Video export is not possible here - still-image export and project saving still work.',
        );
      }
      warnings.push('H.264 encoding is unavailable, so the video was recorded as WebM (VP9/VP8) instead of MP4.');
      return this.renderMediaRecorder(scene, opts, caps, baseName, warnings);
    }
    if (opts.format === 'webm') {
      if (!caps.mediaRecorder) throw new Error('MediaRecorder WebM recording is not available in this browser.');
      return this.renderMediaRecorder(scene, opts, caps, baseName, warnings);
    }

    /* -------------------------------------------------- WebCodecs path */
    progress({ phase: 'preparing', progress: 0.02, message: 'Loading artwork...' });
    await this.images.ensure(scene.nodes.map((n) => n.assetId));
    const missing = scene.nodes.filter((n) => n.kind === 'asset' && n.assetId && !this.library.get(n.assetId));
    if (missing.length) throw new Error(`Artwork missing for ${missing.length} object(s); cannot render.`);
    throwIfAborted();

    const plan = this.plan(scene, opts);
    if (plan.windowed) warnings.push('Some animations have start/stop times, so every frame is rendered individually instead of tiling one cycle.');
    if (!plan.report.exact && plan.report.animated > 0) {
      warnings.push('Cycle lengths were harmonised onto a shared grid; the loop boundary is exact for the built-in animations.');
    }
    if (plan.report.animated === 0) warnings.push('No animations are enabled - the video will be a static scene.');

    const sink = await createSink(baseName, 'mp4', opts, caps, plan.estimatedBytes);
    if (!sink.streaming) warnings.push('Output is buffered in memory because this browser cannot stream to disk.');

    const muxer = new Muxer({
      target: sink.target,
      video: { codec: 'avc', width: opts.width, height: opts.height, frameRate: opts.fps },
      fastStart: false,
      firstTimestampBehavior: 'offset',
    });

    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Could not create the render canvas.');
    const scale = opts.width / scene.canvas.width;

    let encoderError: Error | null = null;
    const chunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
    const VE = (window as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder;
    const VF = (window as unknown as { VideoFrame: typeof VideoFrame }).VideoFrame;

    const encoder = new VE({
      output: (chunk, meta) => { chunks.push({ chunk, meta }); },
      error: (e) => { encoderError = new Error(`Video encoder failed: ${e.message}`); },
    });
    const config: VideoEncoderConfig = {
      ...caps.h264Config!,
      width: opts.width, height: opts.height,
      bitrate: opts.bitrate, framerate: opts.fps,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    };
    encoder.configure(config);

    const frameMicros = 1_000_000 / opts.fps;
    const framesToRender = plan.framesToRender;
    const started = performance.now();
    const keyInterval = Math.max(1, Math.round(opts.fps * 2));

    try {
      for (let i = 0; i < framesToRender; i++) {
        throwIfAborted();
        if (encoderError) throw encoderError;
        const time = i / opts.fps;
        this.compositor.render(ctx, scene, {
          scale, quality: 'export', time, masterCycle: plan.report.master,
        });
        const frame = new VF(canvas, {
          timestamp: Math.round(i * frameMicros),
          duration: Math.round(frameMicros),
        });
        encoder.encode(frame, { keyFrame: i === 0 || i % keyInterval === 0 });
        frame.close();

        // Back-pressure: never let the encoder queue run away with memory.
        let guard = 0;
        while (encoder.encodeQueueSize > 8 && guard++ < 10_000) {
          await new Promise((r) => setTimeout(r, 1));
          if (encoderError) throw encoderError;
          throwIfAborted();
        }
        if (i % 4 === 0 || i === framesToRender - 1) {
          const done = (i + 1) / framesToRender;
          const elapsed = (performance.now() - started) / 1000;
          const eta = done > 0.01 ? elapsed / done - elapsed : undefined;
          progress({
            phase: 'encoding',
            progress: done * (plan.canTile ? 0.75 : 0.95),
            message: plan.canTile
              ? `Rendering one seamless cycle - frame ${i + 1} of ${framesToRender}`
              : `Rendering frame ${i + 1} of ${framesToRender}`,
            framesDone: i + 1, framesTotal: framesToRender, etaSeconds: eta,
          });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      progress({ phase: 'encoding', progress: plan.canTile ? 0.78 : 0.96, message: 'Flushing encoder...' });
      await encoder.flush();
      if (encoderError) throw encoderError;
      if (!chunks.length) throw new Error('The encoder produced no frames.');

      /* Repeat the encoded cycle for the requested duration. Because the
         samples are reused verbatim, every repeat is bit-identical. */
      const totalOut = plan.totalFrames;
      let written = 0;
      let sinceYield = 0;
      for (const { src, out } of tileSequence({ ...plan, canTile: plan.canTile })) {
        throwIfAborted();
        if (src >= chunks.length) break;
        const { chunk, meta } = chunks[src];
        muxer.addVideoChunk(chunk, meta, Math.round(out * frameMicros));
        written++;
        if (++sinceYield >= 240) {
          sinceYield = 0;
          progress({
            phase: 'assembling',
            progress: 0.78 + (written / totalOut) * 0.17,
            message: plan.canTile
              ? `Assembling loop ${Math.floor(out / plan.cycleFrames) + 1} of ${Math.max(1, plan.repeats)} (${written}/${totalOut} frames)`
              : `Muxing frame ${written} of ${totalOut}`,
            framesDone: written, framesTotal: totalOut,
          });
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      if (written !== totalOut) {
        throw new Error(`Frame accounting error: wrote ${written} of ${totalOut} frames.`);
      }

      progress({ phase: 'finalizing', progress: 0.97, message: 'Writing container...' });
      muxer.finalize();
      const { blob, bytes, cleanup, savedDirectly } = await sink.finish();
      if (!bytes) throw new Error('The output file is empty - export failed.');
      progress({ phase: 'done', progress: 1, message: 'Export complete', bytes, framesDone: written, framesTotal: totalOut });
      return {
        blob, filename: sink.filename, bytes, frames: written, encodedFrames: chunks.length,
        method: plan.canTile ? 'webcodecs-loop-tile' : 'webcodecs-full',
        codec: String(config.codec), duration: written / opts.fps, warnings, cleanup, savedDirectly,
      };
    } catch (err) {
      await sink.abort();
      throw err;
    } finally {
      try { if (encoder.state !== 'closed') encoder.close(); } catch { /* ignore */ }
      canvas.width = canvas.height = 0;
      chunks.length = 0;
    }
  }

  /* ------------------------------------------- MediaRecorder fallback */

  private async renderMediaRecorder(
    scene: Scene, opts: VideoOptions, caps: Capabilities, baseName: string, warnings: string[],
  ): Promise<VideoResult> {
    const progress = (p: ExportProgress) => opts.onProgress?.(p);
    warnings.push(
      `WebM fallback records in real time: a ${Math.round(opts.duration)} s video takes about ${Math.round(opts.duration)} s to produce.`,
    );
    await this.images.ensure(scene.nodes.map((n) => n.assetId));

    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create the render canvas.');
    const scale = opts.width / scene.canvas.width;
    const plan = this.plan(scene, opts);

    this.compositor.render(ctx, scene, { scale, quality: 'export', time: 0, masterCycle: plan.report.master });
    const stream = canvas.captureStream(opts.fps);
    const mime = caps.webmMime!;
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate });
    const parts: Blob[] = [];
    let recError: Error | null = null;
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onerror = () => { recError = new Error('MediaRecorder failed while recording.'); };

    const estimated = (opts.bitrate / 8) * opts.duration;
    if (estimated > MAX_IN_MEMORY_BYTES) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        `The WebM fallback keeps the recording in memory (about ${(estimated / 1e9).toFixed(1)} GB here). `
        + 'Reduce the duration or bitrate, or use a browser with H.264 WebCodecs support for long videos.',
      );
    }

    return new Promise<VideoResult>((resolve, reject) => {
      let raf = 0;
      const startTime = performance.now();
      const finish = async () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        canvas.width = canvas.height = 0;
        if (recError) { reject(recError); return; }
        const blob = new Blob(parts, { type: 'video/webm' });
        parts.length = 0;
        if (!blob.size) { reject(new Error('The recorder produced an empty file.')); return; }
        progress({ phase: 'done', progress: 1, message: 'Export complete', bytes: blob.size });
        resolve({
          blob, filename: `${baseName}.webm`, bytes: blob.size,
          frames: Math.round(opts.duration * opts.fps), encodedFrames: 0,
          method: 'mediarecorder', codec: mime, duration: opts.duration, warnings,
        });
      };
      recorder.onstop = () => { void finish(); };
      const tick = () => {
        if (opts.signal?.aborted) {
          try { recorder.stop(); } catch { /* ignore */ }
          cancelAnimationFrame(raf);
          stream.getTracks().forEach((t) => t.stop());
          reject(new DOMException('Export cancelled', 'AbortError'));
          return;
        }
        const elapsed = (performance.now() - startTime) / 1000;
        const t = Math.min(elapsed, opts.duration);
        this.compositor.render(ctx, scene, { scale, quality: 'export', time: t, masterCycle: plan.report.master });
        progress({
          phase: 'encoding',
          progress: clamp(t / opts.duration, 0, 0.99),
          message: `Recording in real time - ${t.toFixed(1)} s of ${opts.duration} s`,
          etaSeconds: opts.duration - t,
        });
        if (elapsed >= opts.duration) {
          try { recorder.stop(); } catch (e) { reject(e as Error); }
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      try {
        recorder.start(1000);
        raf = requestAnimationFrame(tick);
      } catch (err) {
        reject(err as Error);
      }
    });
  }
}
