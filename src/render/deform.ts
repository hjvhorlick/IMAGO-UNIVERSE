/**
 * Texture deformation.
 *
 * Two routines, both used to animate artwork without rotating whole objects:
 *
 *  - `stripWarp`  : horizontal bands displaced as a function of height. Cheap
 *                   (one drawImage per band) and exactly right for grass,
 *                   stems and anything anchored at the base.
 *  - `meshWarp`   : a triangle grid with per-vertex displacement. Used where
 *                   motion varies across the object as well as up it, such as
 *                   a tree canopy where individual branch clusters move out of
 *                   phase with each other.
 *
 * Both are pure drawing helpers: they know nothing about wind, time or scenes.
 */

export type FieldFn = (u: number, v: number) => { dx: number; dy: number };

export interface SrcRect { sx: number; sy: number; sw: number; sh: number }
export interface DstRect { dx: number; dy: number; dw: number; dh: number }

/**
 * Band warp. `field(v)` returns a displacement in *destination* pixels for the
 * band at normalised height v (0 = top, 1 = bottom).
 */
export function stripWarp(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource, s: SrcRect, d: DstRect,
  bands: number, field: (v: number) => { dx: number; dy: number; scale?: number },
) {
  const bandH = s.sh / bands;
  const outH = d.dh / bands;
  for (let i = 0; i < bands; i++) {
    const v = (i + 0.5) / bands;
    const f = field(v);
    const scale = f.scale ?? 1;
    const w = d.dw * scale;
    const x = d.dx + f.dx + (d.dw - w) / 2;
    // 1px overlap hides sub-pixel seams between bands
    const overlap = i < bands - 1 ? 1 : 0;
    ctx.drawImage(
      src,
      s.sx, s.sy + i * bandH, s.sw, bandH + (overlap ? bandH * 0.02 : 0),
      x, d.dy + i * outH + f.dy, w, outH + overlap,
    );
  }
}

/** Solve and apply the affine map (u,v) -> (x,y) for one textured triangle. */
function texturedTriangle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource, srcW: number, srcH: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
  bleed: number,
) {
  // Expand around the centroid by ~1.5 *device* pixels so the anti-aliased
  // clip edges of neighbouring triangles fully overlap. Without this the shared
  // edges composite as 0.5 + 0.5 alpha and show up as hairline seams.
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  const ex = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * bleed, y + (dy / len) * bleed] as const;
  };
  const [ax, ay] = ex(x0, y0);
  const [bx, by] = ex(x1, y1);
  const [gx, gy] = ex(x2, y2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(gx, gy);
  ctx.closePath();
  ctx.clip();

  const denom = u0 * (v2 - v1) - u1 * v2 + u2 * v1 + (u1 - u2) * v0;
  if (Math.abs(denom) < 1e-9) { ctx.restore(); return; }
  const a = -(v0 * (x2 - x1) - v1 * x2 + v2 * x1 + (v1 - v2) * x0) / denom;
  const b = (v1 * y2 + v0 * (y1 - y2) - v2 * y1 + (v2 - v1) * y0) / denom;
  const c = (u0 * (x2 - x1) - u1 * x2 + u2 * x1 + (u1 - u2) * x0) / denom;
  const dd = -(u1 * y2 + u0 * (y1 - y2) - u2 * y1 + (u2 - u1) * y0) / denom;
  const e = (u0 * (v2 * x1 - v1 * x2) + v0 * (u1 * x2 - u2 * x1) + (u2 * v1 - u1 * v2) * x0) / denom;
  const f = (u0 * (v2 * y1 - v1 * y2) + v0 * (u1 * y2 - u2 * y1) + (u2 * v1 - u1 * v2) * y0) / denom;
  ctx.transform(a, b, c, dd, e, f);
  ctx.drawImage(src, 0, 0, srcW, srcH);
  ctx.restore();
}

/**
 * Grid warp. `field(u,v)` returns displacement in destination pixels.
 * `src` must be an image/canvas whose full extent maps to the source rect;
 * pass a pre-cropped scratch canvas when the node uses image cropping.
 */
export function meshWarp(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource, s: SrcRect, d: DstRect,
  cols: number, rows: number, field: FieldFn, bleed = 1.5,
) {
  const px: number[][] = [];
  const py: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    px[j] = []; py[j] = [];
    for (let i = 0; i <= cols; i++) {
      const u = i / cols, v = j / rows;
      const f = field(u, v);
      px[j][i] = d.dx + u * d.dw + f.dx;
      py[j][i] = d.dy + v * d.dh + f.dy;
    }
  }
  const fullW = s.sx + s.sw, fullH = s.sy + s.sh;

  // A row band is "flat" when every vertex on both of its bounding rows lands
  // exactly where an unwarped draw would put it. Drawing those bands as plain
  // image slices instead of triangle pairs matters for two reasons: it is much
  // faster, and it removes the faint grid seams that antialiased triangle edges
  // leave across parts of the picture that are not moving at all (e.g. the sky
  // above a shimmering lake).
  const EPS = 0.02;
  const flatRow: boolean[] = [];
  for (let j = 0; j <= rows; j++) {
    let flat = true;
    for (let i = 0; i <= cols; i++) {
      const ex = d.dx + (i / cols) * d.dw, ey = d.dy + (j / rows) * d.dh;
      if (Math.abs(px[j][i] - ex) > EPS || Math.abs(py[j][i] - ey) > EPS) { flat = false; break; }
    }
    flatRow[j] = flat;
  }

  let j = 0;
  while (j < rows) {
    if (flatRow[j] && flatRow[j + 1]) {
      // Coalesce the longest run of flat bands into one drawImage.
      let end = j + 1;
      while (end < rows && flatRow[end + 1]) end++;
      const v0 = j / rows, v1 = end / rows;
      ctx.drawImage(src,
        s.sx, s.sy + v0 * s.sh, s.sw, (v1 - v0) * s.sh,
        d.dx, d.dy + v0 * d.dh, d.dw, (v1 - v0) * d.dh);
      j = end;
      continue;
    }
    for (let i = 0; i < cols; i++) {
      const u0 = s.sx + (i / cols) * s.sw, u1 = s.sx + ((i + 1) / cols) * s.sw;
      const v0 = s.sy + (j / rows) * s.sh, v1 = s.sy + ((j + 1) / rows) * s.sh;
      texturedTriangle(ctx, src, fullW, fullH,
        px[j][i], py[j][i], px[j][i + 1], py[j][i + 1], px[j + 1][i + 1], py[j + 1][i + 1],
        u0, v0, u1, v0, u1, v1, bleed);
      texturedTriangle(ctx, src, fullW, fullH,
        px[j][i], py[j][i], px[j + 1][i + 1], py[j + 1][i + 1], px[j + 1][i], py[j + 1][i],
        u0, v0, u1, v1, u0, v1, bleed);
    }
    j++;
  }
}

/* --------------------------------------------------------- scratch pool */

interface Scratch {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Logical size in use. The backing store may be larger because buffers are
   *  pooled and reused - always draw and sample using w/h, never canvas.width. */
  w: number; h: number;
  busy: boolean;
}
const pool: Scratch[] = [];

export function acquireScratch(w: number, h: number): Scratch {
  const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
  let s = pool.find((p) => !p.busy && p.canvas.width >= W && p.canvas.height >= H
    && p.canvas.width <= W * 3 && p.canvas.height <= H * 3);
  if (!s) {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    s = { canvas, ctx, w: W, h: H, busy: false };
    pool.push(s);
  }
  if (s.canvas.width < W || s.canvas.height < H) { s.canvas.width = W; s.canvas.height = H; }
  s.w = W; s.h = H;
  s.busy = true;
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = 'source-over';
  s.ctx.filter = 'none';
  return s;
}

export function releaseScratch(s: Scratch) { s.busy = false; }

export function scratchStats() {
  return { count: pool.length, pixels: pool.reduce((a, p) => a + p.canvas.width * p.canvas.height, 0) };
}
