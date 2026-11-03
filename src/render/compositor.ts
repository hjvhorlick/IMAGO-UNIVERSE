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
import type { NodeRenderState, Quality } from '../animation/animationEngine';
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

interface FallGeometry {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Per-row centre of the water column, in scratch pixels. */
  cx: Float32Array;
  /** Per-row half-width; 0 where there is no water at all. */
  hw: Float32Array;
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

  /**
   * Falling water: bright streaks travelling DOWN over stationary artwork,
   * plus a foam pulse at the base.
   *
   * Each streak's vertical position is frac(u * cycles * k + phase) with integer
   * cycles and integer k, so every streak completes whole traversals per loop and
   * the field is bit-identical at u=0 and u=1. The mist uses sin(TAU*u), which is
   * periodic for the same reason. Nothing here accumulates state between frames.
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
    // A waterfall is a NARROW region: at preview size it can be ~35x99 px, so a
    // streak sized as a fraction of its width lands under one pixel and the
    // whole field washes out into a flat haze. Supersample to a floor resolution
    // and let the downscale antialias it, so the flow stays legible when small.
    const maxDim = opts.quality === 'export' ? 1400 : 700;
    const span = Math.max(dw, dh);
    const ratio = clamp(Math.max(260 / span, 1), 1, Math.max(1, maxDim / span));
    const scratch = acquireScratch(dw * ratio, dh * ratio);
    const c = scratch.ctx;
    const W = scratch.w, H = scratch.h;
    const rnd = rng(f.seed);
    const geo = this.fallMask(cacheKey, source, rect, f.region, W, H);

    // Mid-grey base + 'overlay' compositing. Additive white alone is invisible
    // on water that is already near-white; a grey base lets each streak carry a
    // dark trough AND a bright crest, so the flow is actually legible.
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgb(128,128,128)';
    c.fillRect(0, 0, W, H);
    for (let i = 0; i < f.density; i++) {
      const px = rnd(), phase = rnd(), lenJit = rnd();
      // ONE fall speed for the whole field. Water reaches terminal velocity, so
      // mixing speeds was both unphysical and visually self-cancelling: two
      // superimposed translations read as a static shimmer, not as falling.
      // Variation comes from length, width and brightness instead. Integer
      // cycles keep the field exactly periodic across the master loop.
      const k = 1;
      const len = Math.max(4, f.length * H * (0.55 + lenJit * 0.9));
      const span = H + len;
      // frac() of a linear phase: position increases with u, i.e. DOWNWARD.
      const y = frac(u * f.cycles * k + phase) * span - len;
      const a = f.opacity * (0.35 + 0.65 * lenJit);
      const g = c.createLinearGradient(0, y, 0, y + len);
      const trough = (a * 0.95).toFixed(3);
      const crest = Math.min(1, a * 1.45).toFixed(3);
      g.addColorStop(0, 'rgba(128,128,128,0)');
      g.addColorStop(0.22, `rgba(20,28,38,${trough})`);      // shadowed gap
      g.addColorStop(0.52, 'rgba(128,128,128,0)');
      g.addColorStop(0.86, `rgba(255,255,255,${crest})`);    // lit crest
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;

      if (!geo) { c.fillRect(px * W, y, Math.max(1.5, f.width * W), len); continue; }

      // Follow the real column: each row has its own centre and width, so a
      // streak bends with the fall instead of ruling a straight line down the
      // bounding box (which put streaks on dry rock).
      const lateral = (px * 2 - 1) * 0.86;
      const step = Math.max(2, Math.round(H / 90));
      const left: [number, number][] = [];
      const right: [number, number][] = [];
      for (let yy = y; yy <= y + len; yy += step) {
        const row = Math.round(yy);
        if (row < 0 || row >= H) continue;
        const hw = geo.hw[row];
        if (hw <= 0.4) continue;
        // Width tracks the actual column, with a pixel floor so a narrow fall
        // still resolves into distinct streaks rather than a grey smear.
        const half = Math.max(0.9, hw * 0.17 * (0.55 + lenJit));
        const cx = geo.cx[row] + lateral * hw;
        left.push([cx - half, yy]);
        right.push([cx + half, yy]);
      }
      if (left.length < 2) continue;
      c.beginPath();
      c.moveTo(left[0][0], left[0][1]);
      for (const [lx, ly] of left) c.lineTo(lx, ly);
      for (let i = right.length - 1; i >= 0; i--) c.lineTo(right[i][0], right[i][1]);
      c.closePath();
      c.fill();
    }

    // Foam where the water lands. Brightens and settles once per cycle.
    if (f.mist > 0.01) {
      const pulse = 0.55 + 0.45 * Math.sin(TAU * u);
      const mg = c.createRadialGradient(W / 2, H * 0.97, 0, W / 2, H * 0.97, Math.max(W * 0.55, H * 0.2));
      mg.addColorStop(0, `rgba(255,255,255,${(f.mist * 0.55 * pulse).toFixed(3)})`);
      mg.addColorStop(1, 'rgba(128,128,128,0)');
      c.fillStyle = mg;
      c.fillRect(0, H * 0.6, W, H * 0.4);
    }

    // Dissolve into the static art at every edge the region does not share with
    // the artwork border, so the moving water has no visible rectangle.
    c.globalCompositeOperation = 'destination-in';
    const feather = 0.14;
    const fullX = rx <= 0.001 && rx + rw >= 0.999;
    const fullY = ry <= 0.001 && ry + rh >= 0.999;
    const edgeMask = (horizontal: boolean) => {
      const g = horizontal ? c.createLinearGradient(0, 0, W, 0) : c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(feather, 'rgba(0,0,0,1)');
      g.addColorStop(1 - feather, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    };
    if (!fullX) edgeMask(true);
    if (!fullY) edgeMask(false);

    // The region is a bounding box, not the shape of the water. Without this
    // mask the streaks fall over sky, rock and foliage and read as rain rather
    // than a waterfall. Derive the water's own silhouette from the artwork.
    if (geo) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(geo.canvas, 0, 0, W, H);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.drawImage(scratch.canvas, 0, 0, W, H, dx, dy, dw, dh);
    ctx.restore();
    releaseScratch(scratch);
  }

  /**
   * A soft alpha mask of the WATER inside a fall region, derived from the
   * artwork itself: falling water is bright and desaturated, foliage and rock
   * are neither. Cached per asset + region + size, because reading pixels every
   * frame would be far too slow.
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
      const a = new Float32Array(W * H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lum = (max + min) / 2;
        const sat = max <= 0 ? 0 : (max - min) / max;
        // White water: bright AND low saturation. Smooth both so the mask has
        // no hard cut-out edge against the rock.
        const bright = clamp((lum - 0.46) / 0.30, 0, 1);
        const grey = 1 - clamp(sat / 0.42, 0, 1);
        a[p] = (bright * bright * (3 - 2 * bright)) * grey * (d[i + 3] / 255);
      }
      // Separable box blur so the silhouette is soft, not a pixel staircase.
      const r = Math.max(1, Math.round(Math.min(W, H) * 0.02));
      const tmp = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let sum = 0, n = 0;
          for (let k = -r; k <= r; k++) {
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
          for (let k = -r; k <= r; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= H) continue;
            sum += tmp[yy * W + x]; n++;
          }
          a[y * W + x] = sum / n;
        }
      }
      // If the artwork has no bright, desaturated water at all - a stylised
      // painting, or an import whose water is dark or strongly tinted - a strict
      // mask would silently switch the animation OFF. Fall back to the declared
      // region so the water still flows, rather than appearing broken.
      let total = 0;
      for (let i = 0; i < a.length; i++) total += a[i];
      if (total / (W * H) < 0.012) return null;

      // Per-row centre and half-width of the water, so streaks follow the
      // column as it narrows, widens and shifts on the way down.
      const cx = new Float32Array(H);
      const hw = new Float32Array(H);
      for (let y = 0; y < H; y++) {
        let sum = 0, wx = 0;
        for (let x = 0; x < W; x++) { const v = a[y * W + x]; sum += v; wx += v * x; }
        if (sum < 0.6) { cx[y] = W / 2; hw[y] = 0; continue; }
        const mean = wx / sum;
        let varsum = 0;
        for (let x = 0; x < W; x++) { const dv = x - mean; varsum += a[y * W + x] * dv * dv; }
        cx[y] = mean;
        hw[y] = Math.min(W * 0.5, 1.9 * Math.sqrt(varsum / sum));
      }
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = Math.round(clamp(a[p], 0, 1) * 255);
      }
      c.putImageData(img, 0, 0);
      // Bound the cache: masks are small, but imports are unbounded.
      if (this.fallMasks.size > 24) this.fallMasks.delete(this.fallMasks.keys().next().value as string);
      const geo: FallGeometry = { canvas, cx, hw };
      this.fallMasks.set(key, geo);
      return geo;
    } catch {
      return null;   // tainted canvas or no 2D context: fall back to unmasked
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
    ctx.globalAlpha = clamp(node.opacity, 0, 1);
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
