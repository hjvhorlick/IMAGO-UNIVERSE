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
import { clamp, frac, rad, rgba, TAU } from '../core/util';
import { animationEngine } from '../animation/animationEngine';
import type { LocalAtmosphereSpec, NodeRenderState, Quality, SparkleSpec } from '../animation/animationEngine';
import { isActive, LoopManager } from '../animation/loopManager';
import { EFFECT_MAP } from '../animation/effects';
import type { EffectDrawContext } from '../animation/effectPrimitives';
import { acquireScratch, meshWarp, releaseScratch, stripWarp } from './deform';
import { buildFallGeometry, drawFallSheet, drawFallSpray } from './waterfall';
import type { FallGeometry } from './waterfall';
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

/**
 * Pixel size of the waterfall working canvas. The segmentation cache is keyed
 * on this size, so the plate split and the water pass must agree on it.
 */
function fallScratchSize(dw: number, dh: number, quality: Quality) {
  const maxDim = quality === 'export' ? 1500 : 820;
  const spanDim = Math.max(dw, dh, 1);
  const ratio = clamp(Math.max(360 / spanDim, 1), 1, Math.max(1, maxDim / spanDim));
  return {
    W: Math.max(8, Math.round(dw * ratio)),
    H: Math.max(8, Math.round(dh * ratio)),
  };
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
      // Falls are drawn as a plain plate too: the rock and the setting are the
      // photograph, the water on top of them is painted by `drawFall`, and no
      // pixel of the picture is ever warped.
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

    // Embers. A fire that only sways reads as a moving picture of a fire;
    // sparks lifting off the bed and dying as they rise is what sells it.
    // Each one is frac(phase + i / n), so the whole swarm is exactly periodic.
    const embers = Math.round(4 + 10 * fire.amplitude);
    const midX = (x0 + x1) / 2, spanX = (x1 - x0) * 0.34;
    for (let i = 0; i < embers; i++) {
      const p = frac(fire.phase + i / embers);
      const life = Math.sin(Math.PI * p) ** 1.4 * fire.amplitude;
      if (life < 0.05) continue;
      const drift = Math.sin(TAU * (fire.phase * 2 + i * 0.37)) * (0.5 + fire.turbulence)
        + Math.sin(i * 2.3 + fire.seed) * 0.55;
      const ex = dest.dw * (midX + drift * spanX);
      const ey = dest.dh * (y1 - (y1 - y0) * p * 0.92);
      const r = Math.max(0.7, Math.min(dw, dh) * 0.05 * (0.45 + 0.55 * life));
      const spark = ctx.createRadialGradient(ex, ey, 0, ex, ey, r);
      spark.addColorStop(0, `rgba(255,226,160,${0.6 * life})`);
      spark.addColorStop(0.45, `rgba(255,150,40,${0.3 * life})`);
      spark.addColorStop(1, 'rgba(255,90,10,0)');
      ctx.fillStyle = spark;
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, TAU);
      ctx.fill();
    }
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
   * Falling water.
   *
   * The geometry (water silhouette, one tube per cascade, lip and foot rows,
   * ledge breaks) is built once per plate/size by `waterfall.ts` and cached;
   * this method only draws. Two passes, because spray behaves differently from
   * the sheet: the sheet is masked to the painted water so no streak can touch
   * rock, while the lip crest, ledge bursts and mist deliberately hang in the
   * air just outside it, feathered at the region border instead.
   *
   * Both passes are pure functions of the loop phase, so the frame at the end
   * of a cycle is the frame at the start of the next one, exactly.
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
    const detail = opts.quality === 'export' ? 1 : 0.7;
    const size = fallScratchSize(dw, dh, opts.quality);
    const scratch = acquireScratch(size.W, size.H);
    const c = scratch.ctx;
    const W = scratch.w, H = scratch.h;
    const geo = this.waterGeometry(cacheKey, source, rect, f.region, W, H);
    const fullX = rx <= 0.001 && rx + rw >= 0.999;
    const fullY = ry <= 0.001 && ry + rh >= 0.999;

    const featherEdges = (fx: number, fy: number) => {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(this.featherMask(W, H, fx, fy, fullX, fullY), 0, 0, W, H);
    };

    /* Pass 1 - the body of the water, clipped to the painted water. */
    drawFallSheet(c, W, H, geo, f, u, detail);
    featherEdges(0.09, 0.06);
    if (geo) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(geo.mask, 0, 0, W, H);
      c.globalCompositeOperation = 'source-over';
    }

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scratch.canvas, 0, 0, W, H, dx, dy, dw, dh);

    ctx.restore();

    /* Pass 2 - the lip crest, ledge bursts, plunge-pool spray and mist. */
    if (f.splash > 0.02 || f.mist > 0.02) {
      drawFallSpray(c, W, H, geo, f, u, detail, opts.quality);
      featherEdges(0.07, 0.09);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(scratch.canvas, 0, 0, W, H, dx, dy, dw, dh);
      ctx.restore();
    }

    releaseScratch(scratch);
  }

  /**
   * Reusable soft-edge mask for a fall scratch canvas, built once per size and
   * feather width. Two full-canvas gradient fills per pass were the most
   * expensive single thing in the waterfall render.
   */
  private featherMasks = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

  private featherMask(
    W: number, H: number, fx: number, fy: number, fullX: boolean, fullY: boolean,
  ): HTMLCanvasElement | OffscreenCanvas {
    const key = `${W}x${H}|${fx.toFixed(3)}|${fy.toFixed(3)}|${fullX}|${fullY}`;
    const hit = this.featherMasks.get(key);
    if (hit) return hit;
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const c = canvas.getContext('2d') as CanvasRenderingContext2D;
    c.fillStyle = fullX ? '#fff' : '#000';
    c.fillRect(0, 0, W, H);
    if (!fullX) {
      const g = c.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(fx, 'rgba(255,255,255,1)');
      g.addColorStop(1 - fx, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
    if (!fullY) {
      c.globalCompositeOperation = 'multiply';
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(fy, 'rgba(255,255,255,1)');
      g.addColorStop(1 - fy * 0.6, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = 'source-over';
    }
    if (this.featherMasks.size > 8) {
      this.featherMasks.delete(this.featherMasks.keys().next().value as string);
    }
    this.featherMasks.set(key, canvas);
    return canvas;
  }

  /**
   * Cached segmentation of a waterfall plate: the water silhouette plus the
   * lip-to-foot tube of every cascade. Keyed by asset, region and scratch
   * size, and `null` results are cached too so a flat synthetic plate does not
   * re-run a full-frame image read on every frame.
   */
  private waterGeometries = new Map<string, FallGeometry | null>();

  private waterGeometry(
    assetId: string, source: CanvasImageSource,
    rect: { sx: number; sy: number; sw: number; sh: number },
    region: [number, number, number, number], W: number, H: number,
  ): FallGeometry | null {
    const key = `${assetId}|${region.join(',')}|${W}x${H}`;
    if (this.waterGeometries.has(key)) return this.waterGeometries.get(key)!;
    const geo = buildFallGeometry(source, rect, region, W, H);
    if (this.waterGeometries.size > 24) {
      this.waterGeometries.delete(this.waterGeometries.keys().next().value as string);
    }
    this.waterGeometries.set(key, geo);
    return geo;
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
