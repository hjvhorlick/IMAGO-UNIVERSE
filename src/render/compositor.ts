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
    if (sc.axis === 'y') {
      const off = offset * H;
      for (let k = -1; k <= 1; k++) {
        c.drawImage(source, srx, sry, srw, srh, wobble, k * H - off, W, H);
      }
    } else {
      const off = offset * W;
      for (let k = -1; k <= 1; k++) {
        c.drawImage(source, srx, sry, srw, srh, k * W - off, wobble, W, H);
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
