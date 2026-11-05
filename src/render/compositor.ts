/**
 * SCENE COMPOSITOR
 * ================
 * Draws a scene at a point in time. It owns *no* animation logic (that is the
 * Animation Engine) and *no* timing logic (that is the Loop Manager), and it
 * never draws editor furniture - selection handles, guides and panels live in
 * the stage overlay, which is why exports are always clean.
 *
 * Paint order is strictly: background -> middle-ground -> foreground ->
 * atmosphere, then the global lighting grade.
 */
import type { AssetLibrary } from '../assets/library';
import type { Scene, SceneNode } from '../core/types';
import { clamp, frac, rng, rad, rgba, TAU } from '../core/util';
import { animationEngine } from '../animation/animationEngine';
import type { LocalAtmosphereSpec, NodeRenderState, Quality, SparkleSpec } from '../animation/animationEngine';
import { isActive, LoopManager } from '../animation/loopManager';
import { EFFECT_MAP } from '../animation/effects';
import type { EffectDrawContext } from '../animation/effectPrimitives';
import { acquireScratch, meshWarp, releaseScratch, stripWarp } from './deform';
import type { ImageCache } from './imageCache';
import { paintOrder } from '../scene/sceneModel';

export interface RenderOptions {
  scale: number;              // render pixels per design pixel
  quality: Quality;
  time: number;
  /** Skip the global grade (used by the lighting debug view). */
  skipLighting?: boolean;
  /** Only render these layers - used for layer solo previews. */
  layers?: SceneNode['layer'][];
  /** Only render this one node - used to audition a single animation or effect
   *  in isolation. Takes precedence over `layers`. */
  onlyNode?: string;
  /** Master cycle in seconds; global time-based effects lock to this so the
   *  whole frame - including the lighting grade - is exactly periodic. */
  masterCycle?: number;
  onMissingAsset?: (id: string) => void;
}

interface WaterSpan {
  x0: number;
  x1: number;
}

interface FallGeometry {
  waterMask: HTMLCanvasElement | OffscreenCanvas;
  /** Distinct horizontal water spans on each row y (supports multi-stream cascades). */
  spans: WaterSpan[][];
  /** Row index (0..H-1) where the vertical cascades hit the plunge pool. */
  impactY: number;
  /** Flattened impact spans along the splash line. */
  impactSpans: WaterSpan[];
  /** Scene-adapted RGB strings for deep water troughs, sunlit crests and mist. */
  troughRgb: string;
  crestRgb: string;
  mistRgb: string;
}

export class Compositor {
  constructor(
    private library: AssetLibrary,
    private images: ImageCache,
    private loops: LoopManager,
  ) {}

  render(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, scene: Scene, opts: RenderOptions) {
    const { scale, time } = opts;
    const W = scene.canvas.width * scale;
    const H = scene.canvas.height * scale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = scene.canvas.backdrop;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (scene.canvas.clipToCanvas) {
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
    }
    ctx.scale(scale, scale);

    for (const node of paintOrder(scene)) {
      if (opts.onlyNode) {
        // Auditioning a node overrides its hidden flag - the user explicitly
        // asked to see this one thing, even if it is hidden in the full scene.
        if (node.id !== opts.onlyNode) continue;
      } else {
        if (!node.visible) continue;
        if (opts.layers && !opts.layers.includes(node.layer)) continue;
      }
      if (node.kind === 'effect') this.drawEffect(ctx, scene, node, opts);
      else this.drawAsset(ctx, scene, node, opts);
    }
    ctx.restore();

    if (!opts.skipLighting) this.applyLighting(ctx, scene, W, H, time, opts.masterCycle ?? 16);
  }

  /* ------------------------------------------------------------- assets */

  private drawAsset(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    scene: Scene, node: SceneNode, opts: RenderOptions,
  ) {
    const meta = this.library.get(node.assetId);
    const entry = this.images.peek(node.assetId);
    if (!meta || !entry) {
      if (node.assetId) opts.onMissingAsset?.(node.assetId);
      return;
    }
    const state = animationEngine.evaluate(scene, node, opts.time, this.loops, meta, opts.quality,
      opts.onlyNode === node.id);
    const src = entry.bitmap;
    const iw = entry.width, ih = entry.height;
    const crop = node.crop;
    const sx = crop.x * iw, sy = crop.y * ih;
    const sw = Math.max(1, crop.w * iw), sh = Math.max(1, crop.h * ih);

    const dw = node.width * state.scale;
    const dh = node.height * state.scale;
    const cx = node.x + state.offsetX;
    const cy = node.y + state.offsetY;

    ctx.save();
    ctx.globalAlpha = clamp(node.opacity * state.alpha, 0, 1);
    ctx.globalCompositeOperation = (node.blend || 'source-over') as GlobalCompositeOperation;

    if (node.shadow.enabled) this.drawShadow(ctx, node, src, sx, sy, sw, sh, dw, dh, cx, cy);

    ctx.translate(cx, cy);
    ctx.rotate(rad(node.rotation + state.rotation));
    if (node.flipX) ctx.scale(-1, 1);
    ctx.translate(-dw / 2, -dh / 2);

    const filter = buildFilter(node);
    const needsTint = node.adjust.haze > 0.001 || Math.abs(node.adjust.warmth) > 0.001;

    // Resolve the source we will sample from. Mesh warping maps the whole
    // source, so a cropped node is first flattened into a scratch canvas.
    let source: CanvasImageSource = src;
    let rect = { sx, sy, sw, sh };
    let scratch: ReturnType<typeof acquireScratch> | null = null;
    const needsScratch = needsTint || (state.warp?.mode === 'mesh' && (crop.w < 0.999 || crop.h < 0.999));
    if (needsScratch) {
      const maxDim = opts.quality === 'export' ? 2048 : 1024;
      const ratio = Math.min(1, maxDim / Math.max(sw, sh));
      scratch = acquireScratch(sw * ratio, sh * ratio);
      scratch.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, scratch.w, scratch.h);
      if (needsTint) applyTint(scratch, node, scene);
      source = scratch.canvas;
      rect = { sx: 0, sy: 0, sw: scratch.w, sh: scratch.h };
    }

    ctx.filter = filter;
    const dest = { dx: 0, dy: 0, dw, dh };

    if (state.warp) {
      const { mode, cols, rows, field, breaks, active } = state.warp;
      if (mode === 'strip') stripWarp(ctx, source, rect, dest, rows, (v) => field(0.5, v));
      else meshWarp(ctx, source, rect, dest, cols, rows, field, Math.max(1, 1.6 / opts.scale), breaks, active);
    } else {
      ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, dw, dh);
    }
    ctx.filter = 'none';

    if (state.scroll) {
      this.drawRegionScroll(ctx, source, rect, dest, state, opts,
        this.loops.effectiveLoop(scene, node));
    }
    if (state.fall) {
      this.drawFall(ctx, source, rect, dest, state, opts, this.loops.effectiveLoop(scene, node), node.assetId ?? node.id);
    }
    if (state.flame) this.drawHearthFire(ctx, source, rect, dest, crop, state.flame, opts.scale);
    if (state.steam) this.drawCoffeeSteam(ctx, dest, crop, state.steam, opts.scale);
    if (state.sparkle) this.drawSparkle(ctx, dest, crop, state.sparkle, opts);
    if (state.glow > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(dw / 2, dh * 0.42, 0, dw / 2, dh * 0.42, Math.max(dw, dh) * 0.42);
      g.addColorStop(0, rgba(scene.lighting.lightColor, 0.5 * state.glow));
      g.addColorStop(1, rgba(scene.lighting.lightColor, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-dw * 0.3, -dh * 0.3, dw * 1.6, dh * 1.6);
    }

    ctx.restore();
    if (scratch) releaseScratch(scratch);
  }

  /** Animate only the painted flames, keeping the mantel and room still. */
  private drawHearthFire(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: CanvasImageSource,
    rect: { sx: number; sy: number; sw: number; sh: number },
    dest: { dx: number; dy: number; dw: number; dh: number },
    crop: { x: number; y: number; w: number; h: number },
    fire: LocalAtmosphereSpec, scale: number,
  ) {
    const [x, y, w, h] = fire.region;
    const x0 = clamp((x - crop.x) / crop.w, 0, 1);
    const y0 = clamp((y - crop.y) / crop.h, 0, 1);
    const x1 = clamp((x + w - crop.x) / crop.w, 0, 1);
    const y1 = clamp((y + h - crop.y) / crop.h, 0, 1);
    if (x1 <= x0 || y1 <= y0 || fire.amplitude <= 0) return;
    const dw = (x1 - x0) * dest.dw, dh = (y1 - y0) * dest.dh;
    if (dw * scale < 1 || dh * scale < 1) return;
    const scratch = acquireScratch(Math.max(24, Math.min(600, dw * scale)), Math.max(24, Math.min(600, dh * scale)));
    const c = scratch.ctx, W = scratch.w, H = scratch.h;
    const sx = rect.sx + rect.sw * x0, sy = rect.sy + rect.sh * y0;
    const sw = rect.sw * (x1 - x0), sh = rect.sh * (y1 - y0);
    // Sample the detailed painted flame in narrow bands, with a periodic
    // travelling sway. Feather the overlay so the stonework never jumps.
    const bands = 24;
    for (let i = 0; i < bands; i++) {
      const v = i / bands, next = (i + 1) / bands;
      const reach = Math.sin(Math.PI * v) * W * 0.045 * fire.amplitude;
      const wave = Math.sin(TAU * (fire.phase * 2 + v * 1.5))
        + 0.45 * fire.turbulence * Math.sin(TAU * (fire.phase * 3 - v * 2));
      c.drawImage(source, sx, sy + sh * v, sw, sh * (next - v),
        wave * reach, H * v, W, H * (next - v) + 1);
    }
    c.globalCompositeOperation = 'destination-in';
    const mask = c.createRadialGradient(W * 0.5, H * 0.55, 0, W * 0.5, H * 0.55, Math.max(W, H) * 0.7);
    mask.addColorStop(0, 'rgba(255,255,255,0.95)');
    mask.addColorStop(0.55, 'rgba(255,255,255,0.8)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = mask;
    c.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(dest.dw * x0, dest.dh * y0, dw, dh);
    ctx.clip();
    ctx.drawImage(scratch.canvas, 0, 0, W, H, dest.dw * x0, dest.dh * y0, dw, dh);
    // A restrained local glow adds firelight without illuminating the window.
    ctx.globalCompositeOperation = 'lighter';
    const flicker = 0.5 + 0.25 * Math.sin(TAU * fire.phase * 2) + 0.25 * Math.sin(TAU * fire.phase * 3);
    const glow = ctx.createRadialGradient(dest.dw * (x0 + x1) / 2, dest.dh * (y0 + y1) / 2, 0,
      dest.dw * (x0 + x1) / 2, dest.dh * (y0 + y1) / 2, Math.max(dw, dh) * 0.48);
    glow.addColorStop(0, `rgba(255,100,12,${0.10 * fire.amplitude * (0.4 + flicker)})`);
    glow.addColorStop(1, 'rgba(255,100,12,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(dest.dw * x0, dest.dh * y0, dw, dh);
    ctx.restore();
    releaseScratch(scratch);
  }

  /**
   * Specular glints on water.
   *
   * A real sunlit surface is covered in tiny mirrors that flash as the water
   * tilts under them. So this is not a brightness pulse over the artwork: it
   * is a field of small additive flares, each winking on its own integer
   * harmonic of the cycle. Every glint therefore completes a whole number of
   * flashes per loop and the field is bit-identical at the boundary.
   *
   * Positions and rates come from a hash of (seed, index), so the pattern is
   * stable across frames, across reloads and between the preview and the
   * exported video - but no two seeds produce the same patch of glitter.
   */
  private drawSparkle(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dest: { dx: number; dy: number; dw: number; dh: number },
    crop: { x: number; y: number; w: number; h: number },
    sparkle: SparkleSpec, opts: { scale: number; quality: Quality },
  ) {
    const [rx, ry, rw, rh] = sparkle.region;
    const x0 = (rx - crop.x) / crop.w * dest.dw;
    const y0 = (ry - crop.y) / crop.h * dest.dh;
    const w = rw / crop.w * dest.dw, h = rh / crop.h * dest.dh;
    if (w <= 1 || h <= 1) return;
    const detail = opts.quality === 'export' ? 1 : 0.62;
    const count = Math.max(16, Math.min(120, Math.round((w * h) / 3000 * detail)));
    // A tight power curve turns a sine into a flash: most of the cycle dark,
    // a brief hot spike at the peak. That is what reads as a glint.
    const hash = (n: number) => frac(Math.sin(n * 12.9898 + sparkle.seed * 0.017) * 43758.5453);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const gx = x0 + hash(i * 2 + 1) * w;
      const gy = y0 + hash(i * 2 + 2) * h;
      const offset = hash(i * 3 + 3);
      // 1..4 flashes per cycle; turbulence widens the spread of rates.
      const flashes = 1 + Math.floor(hash(i * 5 + 5) * (1 + sparkle.turbulence * 3));
      const wave = Math.sin(TAU * flashes * (sparkle.phase + offset));
      const bright = wave > 0 ? wave ** 8 : 0;
      if (bright < 0.02) continue;
      const alpha = bright * sparkle.amplitude * 0.92;
      const r = (1.7 + 3.3 * hash(i * 7 + 7)) * Math.max(0.5, opts.scale) * (0.55 + 0.45 * bright);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(0.28, `rgba(255,253,244,${alpha * 0.42})`);
      g.addColorStop(1, 'rgba(255,250,236,0)');
      ctx.save();
      ctx.translate(gx, gy);
      ctx.fillStyle = g;
      // Core, plus the crossed flare a real specular highlight throws.
      for (const [sx, sy] of [[r * 2.1, r * 2.1], [r * 6.5, r * 0.42], [r * 0.42, r * 6.5]]) {
        ctx.save();
        ctx.scale(sx, sy);
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** Three soft, independently rising wisps start at the cup's coffee surface. */
  private drawCoffeeSteam(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dest: { dx: number; dy: number; dw: number; dh: number },
    crop: { x: number; y: number; w: number; h: number },
    steam: LocalAtmosphereSpec, scale: number,
  ) {
    const [x, y, width, height] = steam.region;
    if (x < crop.x || x > crop.x + crop.w || y < crop.y || y > crop.y + crop.h) return;
    const cx = (x - crop.x) / crop.w * dest.dw;
    const cy = (y - crop.y) / crop.h * dest.dh;
    const spread = width / crop.w * dest.dw, rise = height / crop.h * dest.dh;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(231,241,239,0.55)';
    ctx.shadowBlur = Math.max(1, spread * 0.14 * scale);
    for (let i = 0; i < 4; i++) {
      const p = frac(steam.phase + i / 4);
      const life = Math.sin(Math.PI * p) ** 1.5 * steam.amplitude;
      const drift = Math.sin(TAU * (steam.phase + i * 0.23)) * spread * (0.08 + steam.turbulence * 0.1);
      const bx = cx + (i - 1.5) * spread * 0.14 + drift;
      const by = cy - p * rise * 0.62;
      const len = rise * (0.24 + p * 0.18);
      ctx.strokeStyle = `rgba(230,240,238,${0.34 * life})`;
      ctx.lineWidth = Math.max(0.8, spread * (0.05 + p * 0.03));
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.bezierCurveTo(bx - spread * 0.18, by - len * 0.35,
        bx + spread * 0.21, by - len * 0.65, bx + drift * 1.3, by - len);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Falling water: bright streaks travelling DOWN over stationary artwork,
   * plus a foam pulse at the base.
   *
   * Each streak's vertical position is frac(u * cycles * k + phase) with integer
   * cycles and integer k, so every streak completes whole traversals per loop and
   * the field is bit-identical at u=0 and u=1. The mist uses sin(TAU*u), which is
   * periodic for the same reason. Nothing here accumulates state between frames.
   */
  /**
   * Spectacular multi-stage waterfall renderer:
   *  1. Water-masked rushing cascade curtains (deep translucent water troughs +
   *     roaring whitewater crests), glistening falling water droplets, and
   *     expanding plunge-pool surface ripples.
   *  2. Churning whitewater boil at the impact line, ballistic splashing water
   *     droplets arcing up and raining back into the pool, and big billowing
   *     mist clouds rising and drifting across the grotto and pool.
   *
   * Every motion phase is a pure function of frac(u * integerCycles + phase),
   * so u=0 and u=1 are bit-identical and nothing outside `region` ever moves.
   */
  private drawFall(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: CanvasImageSource,
    rect: { sx: number; sy: number; sw: number; sh: number },
    dest: { dx: number; dy: number; dw: number; dh: number },
    state: NodeRenderState, opts: RenderOptions, loopSeconds: number,
    cacheKey: string,
  ) {
    const f = state.fall!;
    const [rx, ry, rw, rh] = f.region;
    const dx = dest.dx + rx * dest.dw, dy = dest.dy + ry * dest.dh;
    const dw = rw * dest.dw, dh = rh * dest.dh;
    if (dw < 2 || dh < 2) return;

    const u = frac(opts.time / Math.max(0.001, loopSeconds));
    const maxDim = opts.quality === 'export' ? 1400 : 760;
    const spanDim = Math.max(dw, dh);
    const ratio = clamp(Math.max(360 / spanDim, 1), 1, Math.max(1, maxDim / spanDim));
    const scratch = acquireScratch(dw * ratio, dh * ratio);
    const c = scratch.ctx;
    const W = scratch.w, H = scratch.h;
    const rnd = rng(f.seed);
    const geo = this.fallMask(cacheKey, source, rect, f.region, W, H);

    const troughRgb = geo ? geo.troughRgb : '16,64,84';
    const crestRgb = geo ? geo.crestRgb : '248,253,255';
    const mistRgb = geo ? geo.mistRgb : '236,248,255';
    const impactY = geo ? geo.impactY : H * 0.78;
    const fullX = rx <= 0.001 && rx + rw >= 0.999;
    const fullY = ry <= 0.001 && ry + rh >= 0.999;

    const featherEdges = (fx: number, fy: number) => {
      c.globalCompositeOperation = 'destination-in';
      if (!fullX) {
        const g = c.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(fx, 'rgba(0,0,0,1)');
        g.addColorStop(1 - fx, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
      }
      if (!fullY) {
        const g = c.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(fy, 'rgba(0,0,0,1)');
        g.addColorStop(1 - fy, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
      }
    };

    const pickSpanAt = (row0: number, pick: number): WaterSpan | null => {
      if (!geo) return null;
      for (let dRow = 0; dRow <= 16; dRow++) {
        for (const sgn of dRow === 0 ? [0] : [-1, 1]) {
          const rr = row0 + dRow * sgn;
          if (rr < 0 || rr >= H) continue;
          const list = geo.spans[rr];
          if (!list.length) continue;
          let totalW = 0;
          for (const sp of list) totalW += sp.x1 - sp.x0;
          let target = pick * totalW;
          for (const sp of list) {
            target -= sp.x1 - sp.x0;
            if (target <= 0) return sp;
          }
          return list[list.length - 1];
        }
      }
      return null;
    };

    const fillRibbon = (
      streamPick: number, uLat: number, yTop: number, yBot: number, widthScale: number,
    ) => {
      const yEnd = Math.min(impactY * 1.04, yBot);
      const yStart = Math.max(0, yTop);
      if (yEnd - yStart < 2) return;
      if (!geo) {
        const half = Math.max(1.8, f.width * W * 0.5 * widthScale);
        const cx = (0.06 + uLat * 0.88) * W;
        c.fillRect(cx - half, yStart, half * 2, yEnd - yStart);
        return;
      }
      const anchorRow = clamp(Math.round((yStart + yEnd) * 0.5), 0, H - 1);
      const seedSpan = pickSpanAt(anchorRow, streamPick);
      if (!seedSpan) return;

      let prevMid = (seedSpan.x0 + seedSpan.x1) * 0.5;
      const step = Math.max(2, Math.round(H / 95));
      let left: [number, number][] = [];
      let right: [number, number][] = [];
      const flush = () => {
        if (left.length >= 2) {
          c.beginPath();
          c.moveTo(left[0][0], left[0][1]);
          for (const [lx, ly] of left) c.lineTo(lx, ly);
          for (let k = right.length - 1; k >= 0; k--) c.lineTo(right[k][0], right[k][1]);
          c.closePath();
          c.fill();
        }
        left = [];
        right = [];
      };

      for (let yy = yStart; yy <= yEnd + 0.5; yy += step) {
        const row = clamp(Math.round(yy), 0, H - 1);
        const list = geo.spans[row];
        let best: WaterSpan | null = null;
        let bestDist = W * 0.08;
        for (const sp of list) {
          const dist = prevMid < sp.x0 ? sp.x0 - prevMid : prevMid > sp.x1 ? prevMid - sp.x1 : 0;
          if (dist < bestDist) { bestDist = dist; best = sp; }
        }
        if (!best) { flush(); continue; }
        const sw = best.x1 - best.x0;
        prevMid = (best.x0 + best.x1) * 0.5;
        const cx = best.x0 + (0.07 + uLat * 0.86) * sw;
        const half = clamp(sw * 0.23 * widthScale, 1.8, W * 0.085);
        left.push([cx - half, yy]);
        right.push([cx + half, yy]);
      }
      flush();
    };

    /* -------------------------------------- Pass 1: Falling water + pool */
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.filter = 'none';
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, W, H);

    // 1A. Rushing water sheets: alternating deep translucent water troughs and
    // roaring aerated whitewater curtains plunging down every stream.
    for (let i = 0; i < f.density; i++) {
      const streamPick = rnd(), uLat = rnd(), phase = rnd(), lenJit = rnd();
      const len = Math.max(8, f.length * impactY * (0.65 + lenJit * 0.85));
      const travel = impactY * 1.03 + len;
      const y = frac(u * f.cycles + phase) * travel - len;
      const a = f.opacity * (0.48 + 0.52 * lenJit);
      const plungeFade = 1 - clamp((y + len * 0.5 - impactY * 0.96) / Math.max(6, H * 0.12), 0, 1);
      if (plungeFade <= 0.02) continue;

      const g = c.createLinearGradient(0, y, 0, y + len);
      const troughA = (a * 0.58 * plungeFade).toFixed(3);
      const midA = (a * 0.22 * plungeFade).toFixed(3);
      const crestA = Math.min(0.95, a * 0.92 * plungeFade).toFixed(3);
      g.addColorStop(0, `rgba(${troughRgb},0)`);
      g.addColorStop(0.24, `rgba(${troughRgb},${troughA})`);
      g.addColorStop(0.50, `rgba(${crestRgb},${midA})`);
      g.addColorStop(0.85, `rgba(${crestRgb},${crestA})`);
      g.addColorStop(1, `rgba(${crestRgb},0)`);
      c.fillStyle = g;
      fillRibbon(streamPick, uLat, y, y + len, 0.72 + lenJit * 0.65);
    }

    // 1B. Individual glistening water droplets & fast jets dropping down the face.
    const dropCount = Math.round(f.density * 1.15);
    for (let i = 0; i < dropCount; i++) {
      const streamPick = rnd(), uLat = rnd(), phase = rnd(), sz = rnd();
      const len = Math.max(5, impactY * (0.055 + sz * 0.065));
      const travel = impactY * 1.02 + len;
      const y = frac(u * f.cycles + phase) * travel - len;
      const a = Math.min(0.96, f.opacity * (0.58 + 0.42 * sz));
      const g = c.createLinearGradient(0, y, 0, y + len);
      g.addColorStop(0, `rgba(${crestRgb},0)`);
      g.addColorStop(0.65, `rgba(${crestRgb},${(a * 0.65).toFixed(3)})`);
      g.addColorStop(0.90, `rgba(255,255,255,${a.toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      fillRibbon(streamPick, uLat, y, y + len, 0.28 + sz * 0.22);
    }

    // 1C. Plunge-pool expanding ripples radiating across the water below impactY.
    if (f.splash > 0.02 && impactY < H * 0.94) {
      const rippleCentres: number[] = [];
      if (geo && geo.impactSpans.length) {
        for (const sp of geo.impactSpans) {
          const sw = sp.x1 - sp.x0;
          const nC = Math.max(1, Math.min(3, Math.round(sw / (W * 0.2))));
          for (let k = 0; k < nC; k++) rippleCentres.push(sp.x0 + ((k + 0.5) / nC) * sw);
        }
      } else {
        rippleCentres.push(W * 0.32, W * 0.5, W * 0.68);
      }
      const rippleCycles = Math.max(2, Math.round(f.cycles * 0.5));
      const splashAmp = clamp(f.splash, 0, 1.2);
      c.lineCap = 'round';
      for (let ci = 0; ci < rippleCentres.length; ci++) {
        const cxR = rippleCentres[ci];
        const jit = rnd();
        for (let k = 0; k < 3; k++) {
          const p = frac(u * rippleCycles + k / 3 + jit);
          const env = Math.sin(Math.PI * p);
          if (env <= 0.03) continue;
          const rxR = W * (0.025 + p * 0.14);
          const ryR = rxR * 0.21;
          const cyR = Math.min(H * 0.94, impactY + H * (0.018 + p * 0.11));
          c.strokeStyle = `rgba(${crestRgb},${(env * 0.52 * splashAmp).toFixed(3)})`;
          c.lineWidth = Math.max(1.2, (1 - p * 0.55) * Math.min(W, H) * 0.008);
          c.beginPath();
          c.ellipse(cxR, cyR, rxR, ryR, 0, 0, TAU);
          c.stroke();
        }
      }
    }

    featherEdges(0.09, 0.09);
    if (geo) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(geo.waterMask, 0, 0, W, H);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scratch.canvas, 0, 0, W, H, dx, dy, dw, dh);
    ctx.restore();

    /* ------------------------- Pass 2: Impact splash + big rising mist */
    if (f.splash > 0.02 || f.mist > 0.02) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.filter = 'none';
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, W, H);

      const impactSpans: WaterSpan[] = geo && geo.impactSpans.length
        ? geo.impactSpans
        : [{ x0: W * 0.18, x1: W * 0.82 }];
      let totalImpactW = 0;
      for (const sp of impactSpans) totalImpactW += sp.x1 - sp.x0;
      const pickImpactX = (q: number): number => {
        let t = clamp(q, 0, 1) * Math.max(1, totalImpactW);
        for (const sp of impactSpans) {
          const sw = sp.x1 - sp.x0;
          if (t <= sw) return sp.x0 + t;
          t -= sw;
        }
        const last = impactSpans[impactSpans.length - 1];
        return (last.x0 + last.x1) * 0.5;
      };

      const splashAmp = clamp(f.splash, 0, 1.2);
      if (splashAmp > 0.02) {
        // 2A. Churning whitewater boil & surging foam crowns along the impact line.
        const boilCycles = Math.max(2, f.cycles);
        const boilCount = 20;
        for (let i = 0; i < boilCount; i++) {
          const q = (i + 0.15 + rnd() * 0.7) / boilCount;
          const phase = rnd(), rSz = rnd();
          const p = frac(u * boilCycles + phase);
          const surge = Math.sin(Math.PI * p);
          if (surge <= 0.02) continue;
          const bx = pickImpactX(q) + (rnd() - 0.5) * W * 0.03;
          const by = impactY + H * 0.01 - surge * H * (0.022 + 0.036 * rSz);
          const br = Math.min(W, H) * (0.028 + 0.036 * surge * (0.6 + rSz * 0.6));
          const bg = c.createRadialGradient(bx, by, 0, bx, by, br);
          bg.addColorStop(0, `rgba(255,255,255,${Math.min(0.92, surge * 0.58 * splashAmp).toFixed(3)})`);
          bg.addColorStop(0.55, `rgba(${crestRgb},${(surge * 0.28 * splashAmp).toFixed(3)})`);
          bg.addColorStop(1, `rgba(${crestRgb},0)`);
          c.fillStyle = bg;
          c.beginPath();
          c.arc(bx, by, br, 0, TAU);
          c.fill();
        }

        // 2B. Ballistic splashing water droplets erupting upward and arcing back
        // down into the pool under gravity. Only active on painted waterfalls
        // (geo !== null) or scaled gently so net cascade flow stays downward.
        const sprayCycles = Math.max(2, f.cycles);
        const sprayCount = geo ? Math.round(54 * splashAmp) : Math.round(18 * splashAmp);
        c.lineCap = 'round';
        for (let i = 0; i < sprayCount; i++) {
          const q = rnd(), phase = rnd(), r1 = rnd(), r2 = rnd();
          const p = frac(u * sprayCycles + phase);
          const env = Math.sin(Math.PI * p);
          if (env <= 0.04) continue;
          const ox = pickImpactX(q);
          const oy = impactY + (rnd() - 0.5) * H * 0.018;
          const vx = (r1 - 0.5) * W * 0.22;
          const vy = (0.11 + 0.15 * r2) * H;
          const grav = vy * 2.4;
          const sx = ox + vx * p;
          const sy = oy - vy * p + 0.5 * grav * p * p;
          const vxp = vx, vyp = -vy + grav * p;
          const vLen = Math.hypot(vxp, vyp) || 1;
          const tail = Math.min(W, H) * (0.012 + 0.014 * r2);
          const tx = sx - (vxp / vLen) * tail;
          const ty = sy - (vyp / vLen) * tail;
          const alpha = Math.min(0.95, env * 0.85 * splashAmp);
          c.strokeStyle = `rgba(255,255,255,${(alpha * 0.78).toFixed(3)})`;
          c.lineWidth = Math.max(1.3, Math.min(W, H) * (0.004 + 0.004 * r2));
          c.beginPath();
          c.moveTo(tx, ty);
          c.lineTo(sx, sy);
          c.stroke();
          c.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
          c.beginPath();
          c.arc(sx, sy, c.lineWidth * 0.62, 0, TAU);
          c.fill();
        }
      }

      // 2C. BIG rising & drifting mist clouds: volumetric vapor plumes that
      // climb from the splash pool high across the grotto/cascades, expand,
      // drift laterally in billowing eddies, and dissolve smoothly.
      const mistAmp = clamp(f.mist, 0, 1.25);
      if (mistAmp > 0.02) {
        const mistCount = 24;
        for (let i = 0; i < mistCount; i++) {
          const q = (i + 0.5) / mistCount + (rnd() - 0.5) * 0.06;
          const phase = rnd(), rRise = rnd(), rDrift = rnd(), rSize = rnd(), phSwirl = rnd();
          // Two integer harmonics: grand rising canyon plumes (1x) + brisk base mist (2x).
          const mCycles = i % 3 === 0 ? 2 : 1;
          const p = frac(u * mCycles + phase);
          const env = Math.pow(Math.sin(Math.PI * p), 1.25);
          if (env <= 0.01) continue;

          const ox = pickImpactX(clamp(q, 0.04, 0.96));
          const riseDist = H * (0.42 + 0.34 * rRise);
          const my = impactY + H * 0.035 - riseDist * p;
          const outward = ((ox / W) - 0.5) * 0.44 + (rDrift - 0.5) * 0.42;
          const swirl = Math.sin(TAU * (u * mCycles + phSwirl)) * 0.085;
          const mx = ox + (outward * p + swirl * Math.sin(Math.PI * p)) * W;
          const radM = Math.min(W, H) * (0.12 + 0.10 * rSize) * (0.78 + 1.2 * p);
          // Keep the vapor unmistakable over bright painted water as well as
          // dark canyon walls; broad, overlapping clouds form visible plumes.
          const peakA = Math.min(0.40, env * (0.24 + 0.12 * rSize) * mistAmp);

          c.save();
          c.translate(mx, my);
          c.scale(1.68, 0.74);
          const mg = c.createRadialGradient(0, 0, 0, 0, 0, radM);
          mg.addColorStop(0, `rgba(${mistRgb},${peakA.toFixed(3)})`);
          mg.addColorStop(0.46, `rgba(${mistRgb},${(peakA * 0.52).toFixed(3)})`);
          mg.addColorStop(1, `rgba(${mistRgb},0)`);
          c.fillStyle = mg;
          c.beginPath();
          c.arc(0, 0, radM, 0, TAU);
          c.fill();
          c.restore();
        }
      }

      featherEdges(0.08, 0.10);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(scratch.canvas, 0, 0, W, H, dx, dy, dw, dh);
      ctx.restore();
    }

    releaseScratch(scratch);
  }

  /**
   * Scene-adaptive soft water silhouette + multi-stream span geometry inside a
   * fall region. Normalises RGB against the region's own median colour balance
   * so daylight, moonlit night, and autumn-graded waterfalls all segment every
   * cascade stream and plunge pool cleanly while keeping cliffs and ferns still.
   */
  private fallMasks = new Map<string, FallGeometry>();

  private fallMask(
    assetId: string, source: CanvasImageSource,
    rect: { sx: number; sy: number; sw: number; sh: number },
    region: [number, number, number, number], W: number, H: number,
  ): FallGeometry | null {
    const key = `${assetId}|${region.join(',')}|${W}x${H}`;
    const hit = this.fallMasks.get(key);
    if (hit) return hit;
    try {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const c = canvas.getContext('2d') as CanvasRenderingContext2D;
      if (!c) return null;
      const [rx, ry, rw, rh] = region;
      c.drawImage(source, rect.sx + rx * rect.sw, rect.sy + ry * rect.sh,
        rw * rect.sw, rh * rect.sh, 0, 0, W, H);
      const img = c.getImageData(0, 0, W, H);
      const d = img.data;
      const N = W * H;

      // Sample opaque pixels to measure scene luminance variance and colour balance.
      const rSamples: number[] = [];
      const gSamples: number[] = [];
      const bSamples: number[] = [];
      const lSamples: number[] = [];
      const stride = Math.max(1, Math.floor(N / 4000));
      let lSum = 0, lSq = 0, nOp = 0;
      for (let p = 0; p < N; p += stride) {
        const i = p * 4;
        if (d[i + 3] < 102) continue;
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        rSamples.push(r); gSamples.push(g); bSamples.push(b); lSamples.push(lum);
        lSum += lum; lSq += lum * lum; nOp++;
      }
      if (nOp < 16) return null;
      const lMean = lSum / nOp;
      const lStd = Math.sqrt(Math.max(0, lSq / nOp - lMean * lMean));
      // Flat synthetic plates have zero rock/water contrast: treat the whole
      // declared region as water rather than guessing a silhouette.
      if (lStd < 0.025) return null;

      rSamples.sort((x, y) => x - y);
      gSamples.sort((x, y) => x - y);
      bSamples.sort((x, y) => x - y);
      lSamples.sort((x, y) => x - y);
      const qVal = (arr: number[], q: number) => arr[clamp(Math.floor(arr.length * q), 0, arr.length - 1)];
      const medR = Math.max(0.06, qVal(rSamples, 0.5));
      const medG = Math.max(0.06, qVal(gSamples, 0.5));
      const medB = Math.max(0.06, qVal(bSamples, 0.5));
      const p80B = Math.max(medB + 0.08, qVal(bSamples, 0.8));
      const medLum = qVal(lSamples, 0.5);
      const p80Lum = Math.max(medLum + 0.08, qVal(lSamples, 0.8));
      const p85Lum = Math.max(medLum + 0.1, qVal(lSamples, 0.85));

      const a = new Float32Array(N);
      const foamScore = new Float32Array(N);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const al = d[i + 3] / 255;
        if (al < 0.04) continue;
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const nr = r / medR, ng = g / medG, nb = b / medB;

        const bright = clamp((lum - medLum * 1.22) / Math.max(0.07, p80Lum - medLum * 1.02), 0, 1)
          * clamp((b - medB * 0.90) / Math.max(0.07, p80B - medB * 0.85), 0, 1);
        const cool = clamp((nb / Math.max(0.12, nr) - 1.14) / 0.32, 0, 1)
          * clamp((lum - medLum * 0.76) / Math.max(0.07, medLum * 0.52), 0, 1);
        const foliage = clamp((ng / Math.max(0.12, nb) - 1.04) / 0.18, 0, 1);
        const warmRock = clamp((nr / Math.max(0.12, nb) - 1.16) / 0.22, 0, 1)
          * (1 - clamp((lum - p85Lum) / Math.max(0.06, 1 - p85Lum), 0, 1));

        const raw = clamp(Math.max(bright, cool * 0.92) * (1 - foliage) * (1 - warmRock) * 1.35, 0, 1);
        a[p] = raw * raw * (3 - 2 * raw) * al;
        foamScore[p] = clamp((lum - p85Lum * 0.92) / Math.max(0.05, 1 - p85Lum * 0.92), 0, 1) * a[p];
      }

      // Separable box blur so the water silhouette blends softly against cliffs.
      const radBlur = Math.max(2, Math.round(Math.min(W, H) * 0.016));
      const tmp = new Float32Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let sum = 0, n = 0;
          for (let k = -radBlur; k <= radBlur; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= W) continue;
            sum += a[y * W + xx]; n++;
          }
          tmp[y * W + x] = sum / n;
        }
      }
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          let sum = 0, n = 0;
          for (let k = -radBlur; k <= radBlur; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= H) continue;
            sum += tmp[yy * W + x]; n++;
          }
          a[y * W + x] = sum / n;
        }
      }

      let total = 0;
      for (let i = 0; i < N; i++) total += a[i];
      if (total / N < 0.012) return null;

      // Adapt trough, crest and mist colours to the painting's own water tones.
      let trR = 0, trG = 0, trB = 0, trN = 0;
      let crR = 0, crG = 0, crB = 0, crN = 0;
      for (let p = 0; p < N; p += stride) {
        if (a[p] < 0.35) continue;
        const i = p * 4;
        const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        if (lum < p80Lum) { trR += d[i]; trG += d[i + 1]; trB += d[i + 2]; trN++; }
        else { crR += d[i]; crG += d[i + 1]; crB += d[i + 2]; crN++; }
      }
      const troughRgb = trN > 4
        ? `${Math.round((trR / trN) * 0.30)},${Math.round((trG / trN) * 0.40)},${Math.round((trB / trN) * 0.50)}`
        : '16,64,84';
      const crestRgb = crN > 4
        ? `${Math.round(crR / crN * 0.28 + 255 * 0.72)},${Math.round(crG / crN * 0.24 + 255 * 0.76)},${Math.round(crB / crN * 0.20 + 255 * 0.80)}`
        : '248,253,255';
      const mistRgb = crN > 4
        ? `${Math.round(crR / crN * 0.40 + 245 * 0.60)},${Math.round(crG / crN * 0.35 + 250 * 0.65)},${Math.round(crB / crN * 0.30 + 255 * 0.70)}`
        : '236,248,255';

      // Locate the splash impact row where cascades meet the plunge pool.
      const yLo = Math.floor(0.54 * H), yHi = Math.floor(0.85 * H);
      let bestFoam = -1, impactY = Math.round(0.75 * H);
      for (let y = yLo; y < yHi; y++) {
        let s = 0;
        for (let x = 0; x < W; x++) s += foamScore[y * W + x];
        if (s > bestFoam) { bestFoam = s; impactY = y; }
      }

      // Extract connected horizontal water spans per row so multi-stream falls
      // track each cascade cleanly without crossing dry rock between chutes.
      const minGap = Math.max(2, Math.round(W * 0.015));
      const minWidth = Math.max(2, Math.round(W * 0.012));
      const extractRowSpans = (row: number, thresh: number): WaterSpan[] => {
        const rawSpans: WaterSpan[] = [];
        let inSpan = false, s0 = 0;
        for (let x = 0; x < W; x++) {
          if (a[row * W + x] >= thresh) {
            if (!inSpan) { inSpan = true; s0 = x; }
          } else if (inSpan) {
            rawSpans.push({ x0: s0, x1: x });
            inSpan = false;
          }
        }
        if (inSpan) rawSpans.push({ x0: s0, x1: W });
        const merged: WaterSpan[] = [];
        for (const sp of rawSpans) {
          const prev = merged[merged.length - 1];
          if (prev && sp.x0 - prev.x1 <= minGap) prev.x1 = sp.x1;
          else merged.push({ ...sp });
        }
        return merged.filter((sp) => sp.x1 - sp.x0 >= minWidth);
      };

      const spans: WaterSpan[][] = new Array(H);
      for (let y = 0; y < H; y++) spans[y] = extractRowSpans(y, 0.14);
      const impactSpans = extractRowSpans(clamp(impactY, 0, H - 1), 0.16);

      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = Math.round(clamp(a[p] * 1.22, 0, 1) * 255);
      }
      c.putImageData(img, 0, 0);
      if (this.fallMasks.size > 24) this.fallMasks.delete(this.fallMasks.keys().next().value as string);
      const geo: FallGeometry = {
        waterMask: canvas, spans, impactY, impactSpans, troughRgb, crestRgb, mistRgb,
      };
      this.fallMasks.set(key, geo);
      return geo;
    } catch {
      return null;
    }
  }

  private drawShadow(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    node: SceneNode, src: CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    dw: number, dh: number, cx: number, cy: number,
  ) {
    const s = node.shadow;
    const dx = Math.cos(rad(s.angle)) * s.distance;
    const groundY = cy + dh / 2;
    ctx.save();
    ctx.globalAlpha = clamp(node.opacity * s.opacity, 0, 1);
    ctx.filter = `brightness(0) blur(${Math.max(0, s.blur)}px)`;
    ctx.translate(cx + dx, groundY);
    ctx.transform(1, 0, Math.cos(rad(s.angle)) * 0.35, -s.squash, 0, 0);
    ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }

  /**
   * Flowing water / drifting cloud: re-draw one region of the artwork as a
   * seamlessly tiling scroll. The tile count per cycle is an integer, so the
   * region lands exactly where it started at the loop boundary.
   */
  private drawRegionScroll(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: CanvasImageSource,
    rect: { sx: number; sy: number; sw: number; sh: number },
    dest: { dx: number; dy: number; dw: number; dh: number },
    state: NodeRenderState, opts: RenderOptions, loopSeconds: number,
  ) {
    const sc = state.scroll!;
    const [rx, ry, rw, rh] = sc.region;
    const dx = dest.dx + rx * dest.dw, dy = dest.dy + ry * dest.dh;
    const dw = rw * dest.dw, dh = rh * dest.dh;
    if (dw < 2 || dh < 2) return;
    const u = frac(opts.time / Math.max(0.001, loopSeconds));
    const offset = frac(u * sc.cycles);

    const maxDim = opts.quality === 'export' ? 1400 : 700;
    const ratio = Math.min(1, maxDim / Math.max(dw, dh));
    const scratch = acquireScratch(dw * ratio, dh * ratio);
    const c = scratch.ctx;
    const W = scratch.w, H = scratch.h;
    const srx = rect.sx + rx * rect.sw, sry = rect.sy + ry * rect.sh;
    const srw = rw * rect.sw, srh = rh * rect.sh;
    const wobble = Math.sin(TAU * u * 2) * sc.wobble * W;

    c.globalCompositeOperation = 'source-over';
    // direction +1 must travel along the POSITIVE axis: down for y, right for
    // x. Subtracting the offset unconditionally made vertical flow run upwards.
    const dir = sc.direction ?? 1;
    if (sc.axis === 'y') {
      const off = offset * H * dir;
      for (let k = -1; k <= 1; k++) {
        c.drawImage(source, srx, sry, srw, srh, wobble, k * H + off, W, H);
      }
    } else {
      const off = offset * W * dir;
      for (let k = -1; k <= 1; k++) {
        c.drawImage(source, srx, sry, srw, srh, k * W + off, wobble, W, H);
      }
    }
    // Feather every edge the region does NOT share with the artwork's own
    // border, so the moving patch dissolves into the static art underneath
    // instead of showing a hard seam. Edges that already reach the image border
    // must stay opaque, otherwise the scroll would fade the picture away.
    const f = clamp(sc.feather, 0.01, 0.49);
    const fullX = rx <= 0.001 && rx + rw >= 0.999;
    const fullY = ry <= 0.001 && ry + rh >= 0.999;
    c.globalCompositeOperation = 'destination-in';
    const edgeMask = (horizontal: boolean) => {
      const g = horizontal
        ? c.createLinearGradient(0, 0, W, 0)
        : c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(f, 'rgba(0,0,0,1)');
      g.addColorStop(1 - f, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    };
    if (!fullX) edgeMask(true);
    if (!fullY) edgeMask(false);
    ctx.drawImage(scratch.canvas, 0, 0, W, H, dx, dy, dw, dh);
    releaseScratch(scratch);
  }

  /* ------------------------------------------------------------ effects */

  private drawEffect(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    scene: Scene, node: SceneNode, opts: RenderOptions,
  ) {
    const inst = node.effect;
    if (!inst) return;
    const def = EFFECT_MAP.get(inst.effectId);
    if (!def) return;
    if (!isActive(node, opts.time, opts.onlyNode === node.id)) return;
    const u = this.loops.phaseAt(scene, node, opts.time);
    ctx.save();
    let timingAlpha = 1;
    if (def.family === 'spiritual') {
      const fade = typeof inst.params.windowFade === 'number' ? Math.max(0, inst.params.windowFade) : 1;
      if (fade > 0 && inst.start > 0) timingAlpha *= clamp((opts.time - inst.start) / fade, 0, 1);
      if (fade > 0 && inst.end > 0) timingAlpha *= clamp((inst.end - opts.time) / fade, 0, 1);
    }
    ctx.globalAlpha = clamp(node.opacity, 0, 1) * timingAlpha;
    ctx.globalCompositeOperation = (node.blend && node.blend !== 'source-over'
      ? node.blend : def.blend) as GlobalCompositeOperation;
    ctx.translate(node.x, node.y);
    ctx.rotate(rad(node.rotation));
    if (node.flipX) ctx.scale(-1, 1);
    ctx.translate(-node.width / 2, -node.height / 2);
    // Effects are clipped to their own area so distribution controls are honest.
    ctx.beginPath();
    ctx.rect(0, 0, node.width, node.height);
    ctx.clip();
    const d: EffectDrawContext = {
      w: node.width, h: node.height, u, t: opts.time,
      params: inst.params, seed: inst.seed, scale: opts.scale,
    };
    try {
      def.draw(ctx, d);
    } catch (err) {
      console.error(`[compositor] effect ${def.id} failed`, err);
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------- lighting */

  private applyLighting(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    scene: Scene, W: number, H: number, time: number, masterCycle: number,
  ) {
    const L = scene.lighting;
    const gradeFilter = `brightness(${L.exposure}) contrast(${L.contrast}) saturate(${L.saturation})`;
    if (gradeFilter !== 'brightness(1) contrast(1) saturate(1)') {
      const scratch = acquireScratch(W, H);
      scratch.ctx.drawImage(ctx.canvas as CanvasImageSource, 0, 0, W, H, 0, 0, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.filter = gradeFilter;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(scratch.canvas, 0, 0, W, H, 0, 0, W, H);
      ctx.filter = 'none';
      releaseScratch(scratch);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();

    if (Math.abs(L.warmth) > 0.001) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = Math.abs(L.warmth) * 0.8;
      ctx.fillStyle = L.warmth > 0 ? '#ffb35c' : '#5ca8ff';
      ctx.fillRect(0, 0, W, H);
    }
    if (L.ambient > 0.001) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = L.ambient;
      ctx.fillStyle = L.lightColor;
      ctx.fillRect(0, 0, W, H);
    }
    if (L.haze > 0.001) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(0, H, 0, 0);
      g.addColorStop(0, rgba(L.lightColor, L.haze * 0.18));
      g.addColorStop(0.55, rgba(L.lightColor, L.haze * 0.4));
      g.addColorStop(1, rgba(L.lightColor, L.haze * 0.12));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (L.rays > 0.001) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      const a = rad(L.lightAngle);
      const ox = W * 0.5 - Math.cos(a) * W * 0.75;
      const oy = H * 0.5 - Math.sin(a) * H * 0.9;
      const len = Math.hypot(W, H) * 1.6;
      const flicker = 0.85 + 0.15 * Math.sin(TAU * frac(time / Math.max(0.5, masterCycle)));
      for (let i = 0; i < 7; i++) {
        const spread = (i / 6 - 0.5) * 0.55;
        const ang = a + spread;
        const w = W * 0.035 * (0.5 + ((i * 37) % 11) / 11);
        const ex = ox + Math.cos(ang) * len, ey = oy + Math.sin(ang) * len;
        const nx = -Math.sin(ang) * w, ny = Math.cos(ang) * w;
        const g = ctx.createLinearGradient(ox, oy, ex, ey);
        const alpha = L.rays * 0.16 * flicker;
        g.addColorStop(0, rgba(L.lightColor, alpha));
        g.addColorStop(0.6, rgba(L.lightColor, alpha * 0.35));
        g.addColorStop(1, rgba(L.lightColor, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(ox - nx * 0.2, oy - ny * 0.2);
        ctx.lineTo(ox + nx * 0.2, oy + ny * 0.2);
        ctx.lineTo(ex + nx * 2.4, ey + ny * 2.4);
        ctx.lineTo(ex - nx * 2.4, ey - ny * 2.4);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (L.vignette > 0.001) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, `rgba(0,0,0,${clamp(L.vignette, 0, 1)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }
}

function buildFilter(node: SceneNode): string {
  const a = node.adjust;
  const parts: string[] = [];
  if (Math.abs(a.brightness - 1) > 0.001) parts.push(`brightness(${a.brightness})`);
  if (Math.abs(a.contrast - 1) > 0.001) parts.push(`contrast(${a.contrast})`);
  if (Math.abs(a.saturation - 1) > 0.001) parts.push(`saturate(${a.saturation})`);
  if (Math.abs(a.hue) > 0.01) parts.push(`hue-rotate(${a.hue}deg)`);
  return parts.length ? parts.join(' ') : 'none';
}

/** Warmth + atmospheric haze are painted inside the node's own alpha. */
function applyTint(scratch: ReturnType<typeof acquireScratch>, node: SceneNode, scene: Scene) {
  const c = scratch.ctx;
  const W = scratch.w, H = scratch.h;
  c.save();
  c.globalCompositeOperation = 'source-atop';
  if (Math.abs(node.adjust.warmth) > 0.001) {
    c.globalAlpha = Math.abs(node.adjust.warmth) * 0.45;
    c.fillStyle = node.adjust.warmth > 0 ? '#ff9d3d' : '#4d9dff';
    c.fillRect(0, 0, W, H);
  }
  if (node.adjust.haze > 0.001) {
    c.globalAlpha = node.adjust.haze * 0.75;
    c.fillStyle = scene.lighting.lightColor;
    c.fillRect(0, 0, W, H);
  }
  c.restore();
}
