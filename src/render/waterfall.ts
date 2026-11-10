/**
 * FALLING WATER
 * =============
 * Waterfalls are the hardest thing in the library to fake, because the eye
 * knows exactly what falling water does:
 *
 *   1. it gathers on a shelf, darkens, and **tips over the lip** in a rounded
 *      crest - it does not appear out of thin air at the top of a rock;
 *   2. it leaves the lip as a coherent sheet, accelerating, thinning and
 *      breaking up into whitewater as it goes;
 *   3. where it strikes a ledge or the plunge pool it explodes into spray and
 *      the spray hangs there, drifting, before it dissolves.
 *
 * So this module does not scroll a picture. It reads the painted water mask
 * out of the plate, extracts each cascade as a **stream** (a left/right tube
 * for every row, from its lip to its foot), and then draws:
 *
 *   - a travelling brightness field inside each tube (the film of water),
 *   - bright streaks that run down it at several speeds,
 *   - a rounded spilling crest at every lip,
 *   - splash bursts wherever the stream crosses a painted ledge,
 *   - plunge-pool foam, ballistic spray and ripples at the foot,
 *   - soft mist puffs that rise, drift and *hover* over the impact line.
 *
 * Everything is a pure function of the normalised loop phase `u`, and every
 * period is an integer number of cycles, so the frame at `u = 1` is identical
 * to `u = 0` and the Loop Manager can tile it forever without a seam.
 */
import { clamp, frac, smoothstep, TAU } from '../core/util';
import type { FallSpec } from '../animation/animationEngine';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface WaterSpan {
  x0: number;
  x1: number;
}

interface FallRow extends WaterSpan {
  y: number;
}

export interface FallStep {
  y: number;
  x0: number;
  x1: number;
  /** 0..1 - how hard the water hits this ledge (width jump + fall height). */
  strength: number;
}

/** One continuous cascade: a tube of water from a lip down to a foot. */
export interface FallStream {
  rows: FallRow[];        // sampled top -> bottom at `rowStep`
  rowStep: number;
  lipY: number;
  footY: number;
  lip: WaterSpan;
  foot: WaterSpan;
  steps: FallStep[];
  area: number;
  /** The narrow core the water actually falls in. A plunge pool spreads the
   *  painted mask wide across the foam; the falling curtain does not. */
  coreW: number;
}

export interface FallGeometry {
  width: number;
  height: number;
  /** Soft water silhouette, white RGB with the segmentation in alpha. */
  mask: HTMLCanvasElement | OffscreenCanvas;
  /** The region exactly as painted: the base our water is drawn on top of. */
  base: HTMLCanvasElement | OffscreenCanvas;
  streams: FallStream[];
  impactY: number;
  impactSpans: WaterSpan[];
  troughRgb: string;
  crestRgb: string;
  mistRgb: string;
  /** Vertically periodic tiles of the plate's own water: scroll them and the
   *  water moves. Shadow carries the lace, light carries the glints. Both are
   *  null when the plate has too little water to sample. */
  texDark: HTMLCanvasElement | OffscreenCanvas | null;
  texLight: HTMLCanvasElement | OffscreenCanvas | null;
  /** Height of one repeat of the tiles. */
  texH: number;
  /** Reusable sprites - building gradients per frame is the main cost here. */
  sprites: FallSprites;
}

interface FallSprites {
  streak: HTMLCanvasElement | OffscreenCanvas;
  puff: HTMLCanvasElement | OffscreenCanvas;
  foam: HTMLCanvasElement | OffscreenCanvas;
  crest: HTMLCanvasElement | OffscreenCanvas;
  /** A broad soft-edged sheet of water: the body of the fall, not a detail. */
  veil: HTMLCanvasElement | OffscreenCanvas;
  /** The same sheet in shadow, so veils can both lighten and darken. */
  veilDark: HTMLCanvasElement | OffscreenCanvas;
  /** The gap between two columns of water: a dark seam, not a bright thread. */
  streakDark: HTMLCanvasElement | OffscreenCanvas;
}

/* ------------------------------------------------------------------ utils */

/** Deterministic per-particle hash. No sequential RNG, so no order dependence. */
function pr(seed: number, i: number, k = 0): number {
  let n = (seed * 7919 + i * 104729 + k * 15485863) | 0;
  n = Math.imul(n ^ (n >>> 15), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, w);
  cv.height = Math.max(1, h);
  return cv;
}

function ctxOf(cv: HTMLCanvasElement | OffscreenCanvas): Ctx2D | null {
  return (cv as HTMLCanvasElement).getContext('2d') as Ctx2D | null;
}

const rgbaStr = (rgb: string, a: number) => `rgba(${rgb},${clamp(a, 0, 1).toFixed(3)})`;

/* --------------------------------------------------------------- sprites */

function buildSprites(troughRgb: string, crestRgb: string, mistRgb: string): FallSprites {
  // A streak: a soft-edged vertical lozenge, brightest at the head.
  const streak = makeCanvas(8, 96);
  const sc = ctxOf(streak)!;
  const sg = sc.createLinearGradient(0, 0, 0, 96);
  sg.addColorStop(0, `rgba(${crestRgb},0)`);
  sg.addColorStop(0.22, `rgba(${crestRgb},0.30)`);
  sg.addColorStop(0.55, `rgba(255,255,255,0.78)`);
  sg.addColorStop(0.86, `rgba(255,255,255,1)`);
  sg.addColorStop(1, `rgba(255,255,255,0)`);
  sc.fillStyle = sg;
  sc.fillRect(0, 0, 8, 96);
  // Feather the left/right edges so a streak never has a hard cut.
  sc.globalCompositeOperation = 'destination-in';
  const hg = sc.createLinearGradient(0, 0, 8, 0);
  hg.addColorStop(0, 'rgba(0,0,0,0)');
  hg.addColorStop(0.4, 'rgba(0,0,0,1)');
  hg.addColorStop(0.6, 'rgba(0,0,0,1)');
  hg.addColorStop(1, 'rgba(0,0,0,0)');
  sc.fillStyle = hg;
  sc.fillRect(0, 0, 8, 96);

  const softSprite = (rgb: string, core: number, mid: number, radiusStop: number) => {
    const cv = makeCanvas(96, 96);
    const c = ctxOf(cv)!;
    const g = c.createRadialGradient(48, 48, 0, 48, 48, 48);
    g.addColorStop(0, `rgba(${rgb},${core})`);
    g.addColorStop(radiusStop, `rgba(${rgb},${mid})`);
    g.addColorStop(0.82, `rgba(${rgb},${mid * 0.28})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.beginPath();
    c.arc(48, 48, 48, 0, TAU);
    c.fill();
    return cv;
  };

  // A crest lozenge: wide, short, hot core - used at the lip and at ledges.
  const crest = makeCanvas(96, 32);
  const cc = ctxOf(crest)!;
  const cg = cc.createRadialGradient(48, 16, 0, 48, 16, 46);
  cg.addColorStop(0, `rgba(255,255,255,0.98)`);
  cg.addColorStop(0.45, `rgba(${crestRgb},0.55)`);
  cg.addColorStop(1, `rgba(${troughRgb},0)`);
  cc.save();
  cc.translate(48, 16);
  cc.scale(1, 0.34);
  cc.translate(-48, -16);
  cc.fillStyle = cg;
  cc.beginPath();
  cc.arc(48, 16, 46, 0, TAU);
  cc.fill();
  cc.restore();

  // A dark seam: the same lozenge as a streak, in the trough colour.
  const streakDark = makeCanvas(8, 96);
  const kc = ctxOf(streakDark)!;
  const kg = kc.createLinearGradient(0, 0, 0, 96);
  kg.addColorStop(0, `rgba(${troughRgb},0)`);
  kg.addColorStop(0.25, `rgba(${troughRgb},0.25)`);
  kg.addColorStop(0.6, `rgba(${troughRgb},0.65)`);
  kg.addColorStop(0.9, `rgba(${troughRgb},0.85)`);
  kg.addColorStop(1, `rgba(${troughRgb},0)`);
  kc.fillStyle = kg;
  kc.fillRect(0, 0, 8, 96);
  kc.globalCompositeOperation = 'destination-in';
  const kh = kc.createLinearGradient(0, 0, 8, 0);
  kh.addColorStop(0, 'rgba(0,0,0,0)');
  kh.addColorStop(0.45, 'rgba(0,0,0,1)');
  kh.addColorStop(0.55, 'rgba(0,0,0,1)');
  kh.addColorStop(1, 'rgba(0,0,0,0)');
  kc.fillStyle = kh;
  kc.fillRect(0, 0, 8, 96);

  // A veil: a tall, soft-edged sheet with no hard ends, so overlapping veils
  // read as one body of water rather than as stacked ribbons.
  const buildVeil = (rgb: string, hot: string) => {
    const cv = makeCanvas(48, 256);
    const vc = ctxOf(cv)!;
    const vh = vc.createLinearGradient(0, 0, 48, 0);
    vh.addColorStop(0, `rgba(${rgb},0)`);
    vh.addColorStop(0.28, `rgba(${rgb},0.55)`);
    vh.addColorStop(0.5, `rgba(${hot},0.75)`);
    vh.addColorStop(0.72, `rgba(${rgb},0.55)`);
    vh.addColorStop(1, `rgba(${rgb},0)`);
    vc.fillStyle = vh;
    vc.fillRect(0, 0, 48, 256);
    vc.globalCompositeOperation = 'destination-in';
    const vv = vc.createLinearGradient(0, 0, 0, 256);
    vv.addColorStop(0, 'rgba(0,0,0,0)');
    vv.addColorStop(0.2, 'rgba(0,0,0,1)');
    vv.addColorStop(0.8, 'rgba(0,0,0,1)');
    vv.addColorStop(1, 'rgba(0,0,0,0)');
    vc.fillStyle = vv;
    vc.fillRect(0, 0, 48, 256);
    return cv;
  };
  const veil = buildVeil(crestRgb, '255,255,255');
  const veilDark = buildVeil(troughRgb, troughRgb);
  return {
    streak,
    puff: softSprite(mistRgb, 0.95, 0.42, 0.42),
    foam: softSprite(crestRgb, 1, 0.5, 0.38),
    crest,
    veil,
    veilDark,
    streakDark,
  };
}

/* -------------------------------------------------------------- geometry */

/**
 * Segment the painted water inside `region` and extract its cascades.
 *
 * The segmentation normalises against the region's own median colour balance,
 * so a daylight, moonlit or autumn waterfall all separate their water from
 * rock, moss and fern the same way. Connected row spans become streams, and
 * vertical breaks with matching x ranges are stitched back together: water
 * does not stop falling because the painting shows a ledge.
 */
export function buildFallGeometry(
  source: CanvasImageSource,
  rect: { sx: number; sy: number; sw: number; sh: number },
  region: [number, number, number, number],
  W: number,
  H: number,
  impactYHint?: number,
): FallGeometry | null {
  if (W < 8 || H < 8) return null;
  const canvas = makeCanvas(W, H);
  const c = ctxOf(canvas);
  if (!c) return null;

  const [rx, ry, rw, rh] = region;
  c.drawImage(
    source,
    rect.sx + rx * rect.sw, rect.sy + ry * rect.sh,
    Math.max(1, rw * rect.sw), Math.max(1, rh * rect.sh),
    0, 0, W, H,
  );

  let img: ImageData;
  try {
    img = c.getImageData(0, 0, W, H);
  } catch {
    return null;
  }
  const d = img.data;
  const N = W * H;
  const base = makeCanvas(W, H);
  const bctx = ctxOf(base);
  if (bctx) bctx.putImageData(img, 0, 0);

  /* --- 1. Scene statistics ------------------------------------------- */
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
  // A flat synthetic plate has no water/rock contrast: treat the whole region
  // as water rather than inventing a silhouette.
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

  /* --- 2. Water likelihood per pixel ---------------------------------- */
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

  /* --- 3. Soften, so the mesh of streaks never ends on a hard edge ----- */
  const radBlur = Math.max(2, Math.round(Math.min(W, H) * 0.014));
  const blur = (field: Float32Array, radius: number) => {
    const tmp2 = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= W) continue;
          sum += field[row + xx]; n++;
        }
        tmp2[row + x] = sum / n;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= H) continue;
          sum += tmp2[yy * W + x]; n++;
        }
        field[y * W + x] = sum / n;
      }
    }
  };
  blur(a, radBlur);

  /* --- 3b. Keep only the bodies of water ------------------------------- */
  // Bright wet rock and sunlit moss survive the colour test as small blobs.
  // A waterfall is a few big vertical masses, so every island much smaller
  // than the biggest one is painting noise. Masking them out (and softening
  // the cut) leaves a clean silhouette instead of a speckled haze.
  {
    const THRESH = 0.16;
    const seen = new Uint8Array(N);
    const stack = new Int32Array(N);
    const keep = new Float32Array(N);
    const islands: number[][] = [];
    for (let seed = 0; seed < N; seed++) {
      if (seen[seed] || a[seed] < THRESH) continue;
      let sp = 0;
      stack[sp++] = seed;
      seen[seed] = 1;
      const pixels: number[] = [];
      while (sp > 0) {
        const p = stack[--sp];
        pixels.push(p);
        const x = p % W, y = (p - x) / W;
        if (x > 0 && !seen[p - 1] && a[p - 1] >= THRESH) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < W - 1 && !seen[p + 1] && a[p + 1] >= THRESH) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && !seen[p - W] && a[p - W] >= THRESH) { seen[p - W] = 1; stack[sp++] = p - W; }
        if (y < H - 1 && !seen[p + W] && a[p + W] >= THRESH) { seen[p + W] = 1; stack[sp++] = p + W; }
      }
      islands.push(pixels);
    }
    let biggest = 0;
    for (const isl of islands) biggest = Math.max(biggest, isl.length);
    const minArea = Math.max(64, biggest * 0.05);
    for (const isl of islands) {
      if (isl.length < minArea) continue;
      for (const p of isl) keep[p] = 1;
    }
    // Soften the cut so the mask edge stays feathery, then intersect.
    blur(keep, radBlur * 2);
    for (let i = 0; i < N; i++) a[i] *= clamp(keep[i] * 1.4, 0, 1);
  }

  let total = 0;
  for (let i = 0; i < N; i++) total += a[i];
  if (total / N < 0.012) return null;

  /* --- 4. Colours borrowed from the painting --------------------------- */
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

  /* --- 5. Row spans ---------------------------------------------------- */
  const minGap = Math.max(2, Math.round(W * 0.014));
  const minWidth = Math.max(2, Math.round(W * 0.010));
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

  /* --- 6. Where the water lands --------------------------------------- */
  // Foam is the brightest water, and it pools where the fall strikes. Take the
  // strongest foam row in the lower half; fall back to the widest water row.
  const yLo = Math.floor(0.5 * H), yHi = Math.floor(0.9 * H);
  let bestFoam = -1, impactY = Math.round(0.78 * H);
  for (let y = yLo; y < yHi; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) s += foamScore[y * W + x];
    if (s > bestFoam) { bestFoam = s; impactY = y; }
  }
  if (bestFoam <= 0) {
    let bestW = -1;
    for (let y = yLo; y < yHi; y++) {
      let s = 0;
      for (const sp of spans[y]) s += sp.x1 - sp.x0;
      if (s > bestW) { bestW = s; impactY = y; }
    }
  }

  // A bright patch halfway down a fall can be mistaken for its plunge pool.
  // Use an authored impact line when available so lower cascades keep flowing.
  if (impactYHint !== undefined && Number.isFinite(impactYHint)) {
    impactY = Math.round(clamp(impactYHint, 0, 1) * (H - 1));
  }

  /* --- 7. Streams (connected components of row spans) ------------------ */
  interface Comp { rows: FallRow[]; }
  const comps: Comp[] = [];
  let open: { comp: Comp; last: WaterSpan }[] = [];
  for (let y = 0; y < H; y++) {
    const row = spans[y];
    const nextOpen: { comp: Comp; last: WaterSpan }[] = [];
    for (const sp of row) {
      const hit = open.find((o) => {
        const ov = Math.min(o.last.x1, sp.x1) - Math.max(o.last.x0, sp.x0);
        return ov > Math.min(o.last.x1 - o.last.x0, sp.x1 - sp.x0) * 0.34;
      });
      if (hit) {
        hit.comp.rows.push({ y, x0: sp.x0, x1: sp.x1 });
        nextOpen.push({ comp: hit.comp, last: sp });
        open = open.filter((o) => o !== hit);
      } else {
        const comp: Comp = { rows: [{ y, x0: sp.x0, x1: sp.x1 }] };
        comps.push(comp);
        nextOpen.push({ comp, last: sp });
      }
    }
    open = nextOpen;
  }

  // Stitch vertically adjacent components that overlap in x: a painted ledge
  // splits the mask, but the water keeps falling.
  const maxGapRows = Math.max(3, Math.round(H * 0.09));
  const mergedComps: Comp[] = [];
  comps.sort((x, y) => x.rows[0].y - y.rows[0].y);
  for (const comp of comps) {
    const first = comp.rows[0], last = comp.rows[comp.rows.length - 1];
    const target = mergedComps.find((m) => {
      const mLast = m.rows[m.rows.length - 1];
      const mFirst = m.rows[0];
      const overlap = Math.min(mLast.x1, first.x1) - Math.max(mLast.x0, first.x0);
      const minW = Math.min(mLast.x1 - mLast.x0, first.x1 - first.x0);
      return first.y - mLast.y >= -1 && first.y - mLast.y <= maxGapRows
        && overlap > minW * 0.45
        && last.y > mFirst.y;
    });
    if (target) {
      // Bridge the gap so the tube is continuous: interpolate the edge rows.
      const mLast = target.rows[target.rows.length - 1];
      const gap = first.y - mLast.y;
      for (let g = 1; g < gap; g++) {
        const t = g / gap;
        target.rows.push({
          y: mLast.y + g,
          x0: mLast.x0 + (first.x0 - mLast.x0) * t,
          x1: mLast.x1 + (first.x1 - mLast.x1) * t,
        });
      }
      target.rows.push(...comp.rows);
    } else {
      mergedComps.push({ rows: [...comp.rows] });
    }
  }

  // The lower curtain can split into a new component when the water fans out.
  // Rejoin an overlapping continuation at the end of a tall stream; otherwise
  // each piece gets a new artificial lip and a conspicuous horizontal seam.
  if (impactYHint !== undefined && Number.isFinite(impactYHint)) {
    for (let i = 0; i < mergedComps.length; i++) {
      const upper = mergedComps[i];
      for (let j = 0; j < mergedComps.length; j++) {
        if (i === j) continue;
        const lower = mergedComps[j];
        const first = lower.rows[0], last = upper.rows[upper.rows.length - 1];
        if (first.y < upper.rows[0].y + H * 0.15 || first.y > last.y + maxGapRows
          || first.y < last.y - H * 0.04 || lower.rows[lower.rows.length - 1].y <= last.y) continue;
        // A small offshoot can start beside the main curtain and widen into it
        // a few rows later. Look ahead for the first genuinely overlapping row.
        const joinIndex = lower.rows.findIndex((r) => {
          if (r.y <= last.y || r.y > last.y + maxGapRows) return false;
          const overlap = Math.min(last.x1, r.x1) - Math.max(last.x0, r.x0);
          return overlap > Math.min(last.x1 - last.x0, r.x1 - r.x0) * 0.45;
        });
        if (joinIndex < 0) continue;
        const join = lower.rows[joinIndex];
        const gap = join.y - last.y;
        for (let k = 1; k < gap; k++) {
          const t = k / gap;
          upper.rows.push({ y: last.y + k, x0: last.x0 + (join.x0 - last.x0) * t,
            x1: last.x1 + (join.x1 - last.x1) * t });
        }
        upper.rows.push(...lower.rows.slice(joinIndex));
        mergedComps.splice(j, 1);
        if (j < i) i--;
        j = -1;
      }
    }
  }

  const rowStep = Math.max(2, Math.round(H / 150));
  const streams: FallStream[] = [];
  for (const comp of mergedComps) {
    const rows = comp.rows.filter((r) => r.y <= impactY);
    if (rows.length < 6) continue;
    const lipRow = rows[0], footRow = rows[rows.length - 1];
    if (footRow.y - lipRow.y < H * 0.06) continue;
    let area = 0;
    for (const r of rows) area += r.x1 - r.x0;
    // Ignore puddles: a stream must be tall and reasonably narrow.
    if (area < W * H * 0.004) continue;

    // Sample, but always keep the first and last row.
    const sampled: FallRow[] = [];
    for (let i = 0; i < rows.length; i += rowStep) sampled.push(rows[i]);
    if (sampled[sampled.length - 1] !== footRow) sampled.push(footRow);

    const lipWin = sampled.slice(0, Math.min(4, sampled.length));
    const lip = {
      x0: lipWin.reduce((s, r) => s + r.x0, 0) / lipWin.length,
      x1: lipWin.reduce((s, r) => s + r.x1, 0) / lipWin.length,
    };

    // Ledge detection: a sudden sideways shift or a width collapse means the
    // water just ran over a step in the rock.
    const steps: FallStep[] = [];
    for (let i = 2; i < sampled.length; i++) {
      const prev = sampled[i - 2], cur = sampled[i];
      const wPrev = prev.x1 - prev.x0, wCur = cur.x1 - cur.x0;
      const cPrev = (prev.x0 + prev.x1) / 2, cCur = (cur.x0 + cur.x1) / 2;
      const shift = Math.abs(cCur - cPrev) / W;
      const squeeze = Math.abs(wCur - wPrev) / Math.max(1, wPrev);
      if (shift > 0.035 || squeeze > 0.55) {
        if (!steps.some((s) => Math.abs(s.y - cur.y) < H * 0.05)) {
          steps.push({
            y: cur.y, x0: cur.x0, x1: cur.x1,
            strength: clamp(shift * 8 + squeeze * 0.6, 0.2, 1),
          });
        }
      }
    }

    // The falling curtain keeps roughly the width it had in its upper half;
    // the painted mask fans out into foam where it hits the pool. Sampling the
    // upper width keeps the sheet from washing across the whole plunge pool.
    const upper = sampled.filter((r) => r.y < lipRow.y + (footRow.y - lipRow.y) * 0.6);
    const widths = upper.map((r) => r.x1 - r.x0).sort((x, y) => x - y);
    const coreW = widths.length ? widths[Math.floor(widths.length / 2)] : (footRow.x1 - footRow.x0);

    streams.push({
      rows: sampled,
      rowStep,
      lipY: lipRow.y,
      footY: footRow.y,
      lip,
      foot: { x0: footRow.x0, x1: footRow.x1 },
      steps,
      area,
      coreW,
    });
  }

  // Draw order: far / small cascades first, the hero cascade last. Tiny
  // ribbons (a glint on wet stone) are not cascades and are dropped.
  streams.sort((x, y) => y.area - x.area);
  const biggestArea = streams.length ? streams[0].area : 0;
  for (let i = streams.length - 1; i >= 0; i--) {
    if (streams[i].area < biggestArea * 0.10) streams.splice(i, 1);
  }

  let impactSpans = extractRowSpans(clamp(impactY, 0, H - 1), 0.16);
  if (!impactSpans.length) {
    const footSpans: WaterSpan[] = [];
    for (const st of streams) footSpans.push(st.foot);
    impactSpans = footSpans.length ? footSpans : [{ x0: W * 0.2, x1: W * 0.8 }];
  }

  /* --- 8. A tileable water texture ------------------------------------- *
   * The photograph stays the base, but it cannot move. So the plate's own
   * water is lifted into a tile and made vertically periodic by crossfading
   * its tail into its head: scrolling that tile inside a stream gives water
   * that really travels downward, carrying the photographic texture of the
   * fall, and it wraps without a seam.
   *
   * The tile is a *local* high-pass of the water's luminance, not a global
   * contrast curve: painted water is nearly white everywhere, and only the
   * detail around each pixel (the lace of spray, the seams between columns of
   * water) is dark enough to be seen moving.
   */
  let texDark: HTMLCanvasElement | OffscreenCanvas | null = null;
  let texLight: HTMLCanvasElement | OffscreenCanvas | null = null;
  let texH = 0;
  {
    // Local mean of the water's luminance, so the high-pass keeps the lace and
    // drops the fall's overall brightness.
    const lumField = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const i = p * 4;
      lumField[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    }
    const localMean = Float32Array.from(lumField);
    blur(localMean, Math.max(3, Math.round(Math.min(W, H) * 0.045)));

    let detail = 0, detailSq = 0, nDet = 0;
    for (let p = 0; p < N; p++) {
      if (a[p] < 0.6) continue;
      const dv = lumField[p] - localMean[p];
      detail += dv; detailSq += dv * dv; nDet++;
    }
    const detSd = nDet > 32 ? Math.sqrt(Math.max(1e-6, detailSq / nDet - (detail / nDet) ** 2)) : 0.02;

    // Sample the water-rich band of the region, not a random stripe of rock.
    const bandMax = Math.min(H, 288);
    let bestY = 0, bestScore = -1;
    for (let y = 0; y + bandMax <= H; y += Math.max(2, Math.round(H * 0.03))) {
      let score = 0;
      for (let i = 0; i < bandMax; i += 3) {
        const row = y + i;
        for (let x = 0; x < W; x += 4) score += a[row * W + x];
      }
      if (score > bestScore) { bestScore = score; bestY = y; }
    }

    if (bestScore > 0 && nDet > 32) {
      const fade = Math.max(6, Math.round(bandMax * 0.34));
      const tileH = Math.max(16, bandMax - fade);
      // Half resolution on purpose: the tile is upscaled when it is drawn, so
      // its grain lands soft instead of as a barcode of one-pixel stripes.
      const tw = Math.max(8, Math.round(W / 2));
      const th = Math.max(8, Math.round(tileH / 2));
      texDark = makeCanvas(tw, th);
      texLight = makeCanvas(tw, th);
      const dc = ctxOf(texDark);
      const lc = ctxOf(texLight);
      if (dc && lc) {
        const tImg = dc.createImageData(tw, th);
        const td = tImg.data;
        const lImg = lc.createImageData(tw, th);
        const ld = lImg.data;
        const gain = 1 / (2.6 * detSd);
        for (let y = 0; y < th; y++) {
          const sy2 = Math.min(tileH - 1, y * 2);
          // Rows in the fade zone blend the head of the band with its tail, so
          // the bottom row of the tile flows back into the top one.
          const k = sy2 < fade ? 1 - sy2 / fade : 0;
          const rA = Math.min(H - 1, bestY + sy2);
          const rB = Math.min(H - 1, bestY + Math.min(bandMax - 1, tileH + sy2));
          for (let x = 0; x < tw; x++) {
            const sx2 = Math.min(W - 1, x * 2);
            const pA = rA * W + sx2, pB = rB * W + sx2;
            const dvA = lumField[pA] - localMean[pA];
            const dvB = lumField[pB] - localMean[pB];
            const dv = k * dvB + (1 - k) * dvA;
            const am = clamp((k * a[pB] + (1 - k) * a[pA] - 0.22) / 0.55, 0, 1);
            const t = clamp(0.5 + dv * gain, 0, 1);
            const o = (y * tw + x) * 4;
            // Shadow where the water is darker than its surroundings, light
            // where it is brighter: two sprites, because one pixel cannot be
            // both.
            td[o] = 22; td[o + 1] = 48; td[o + 2] = 68;
            td[o + 3] = Math.round((1 - t) * am * 245);
            const lt = clamp((t - 0.55) / 0.45, 0, 1);
            ld[o] = 255; ld[o + 1] = 255; ld[o + 2] = 255;
            ld[o + 3] = Math.round(lt * am * 235);
          }
        }
        dc.putImageData(tImg, 0, 0);
        lc.putImageData(lImg, 0, 0);
        texH = tileH;
      }
    }
  }

  /* --- 8. Mask canvas -------------------------------------------------- */
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
    d[i + 3] = Math.round(clamp(a[p] * 1.18, 0, 1) * 255);
  }
  c.putImageData(img, 0, 0);

  return {
    width: W, height: H, mask: canvas, base, streams, impactY, impactSpans,
    troughRgb, crestRgb, mistRgb, texDark, texLight, texH,
    sprites: buildSprites(troughRgb, crestRgb, mistRgb),
  };
}

/* -------------------------------------------------------------- drawing */

/** Linear interpolation of a stream's left/right edge at row `y`. */
export function spanAt(st: FallStream, y: number): WaterSpan {
  const rows = st.rows;
  if (y <= rows[0].y) return { x0: rows[0].x0, x1: rows[0].x1 };
  const last = rows[rows.length - 1];
  if (y >= last.y) return { x0: last.x0, x1: last.x1 };
  const i = clamp(Math.floor((y - rows[0].y) / st.rowStep), 0, rows.length - 2);
  const r0 = rows[i], r1 = rows[i + 1];
  const t = clamp((y - r0.y) / Math.max(0.001, r1.y - r0.y), 0, 1);
  return { x0: r0.x0 + (r1.x0 - r0.x0) * t, x1: r0.x1 + (r1.x1 - r0.x1) * t };
}

/**
 * The falling span at row `y`: the painted span narrowed to the stream's core
 * width and centred on the painted centre, so foam fans at the foot do not
 * turn into a moving wash across the pool.
 */
export function curtainSpan(st: FallStream, y: number): WaterSpan {
  const raw = spanAt(st, y);
  const cx = (raw.x0 + raw.x1) / 2;
  const w = Math.min(raw.x1 - raw.x0, Math.max(st.coreW * 1.12, 2));
  return { x0: cx - w / 2, x1: cx + w / 2 };
}

/** Build the closed tube path for a slice of a stream (core width). */
function traceTube(c: Ctx2D, st: FallStream, y0: number, y1: number) {
  const rows = st.rows;
  const edges = rows.map((r) => ({ y: r.y, ...curtainSpan(st, r.y) }));
  let started = false;
  c.beginPath();
  for (let i = 0; i < edges.length; i++) {
    const r = edges[i];
    if (r.y < y0 || r.y > y1) continue;
    if (!started) { c.moveTo(r.x0, r.y); started = true; }
    else c.lineTo(r.x0, r.y);
  }
  for (let i = edges.length - 1; i >= 0; i--) {
    const r = edges[i];
    if (r.y < y0 || r.y > y1) continue;
    if (!started) { c.moveTo(r.x1, r.y); started = true; }
    else c.lineTo(r.x1, r.y);
  }
  if (started) c.closePath();
}

/**
 * PASS 1 - the body of the water.
 *
 * Drawn into the fall scratch canvas and then masked by the painted water
 * silhouette, so no streak can wander onto rock or fern.
 */
export function drawFallSheet(
  c: Ctx2D, W: number, H: number, geo: FallGeometry | null,
  f: FallSpec, u: number, detail: number,
) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, W, H);

  const streams = geo?.streams ?? [];
  const fallback: FallStream = {
    rows: (() => {
      const rows: FallRow[] = [];
      const top = 0, bottom = H * 0.98;
      for (let y = top; y <= bottom; y += 4) rows.push({ y, x0: W * 0.06, x1: W * 0.94 });
      return rows;
    })(),
    rowStep: 4,
    lipY: 0,
    footY: H * 0.98,
    lip: { x0: W * 0.06, x1: W * 0.94 },
    foot: { x0: W * 0.06, x1: W * 0.94 },
    steps: [],
    area: W * H,
    coreW: W * 0.88,
  };
  const list = streams.length ? streams : [fallback];
  const impactY = geo?.impactY ?? H * 0.9;
  const sprites = geo?.sprites;
  const crestRgb = geo?.crestRgb ?? '248,253,255';
  const troughRgb = geo?.troughRgb ?? '16,64,84';
  const cycles = Math.max(1, Math.round(f.cycles));
  const seed = f.seed || 1;
  const natural = f.naturalFlow === true;

  for (let si = 0; si < list.length; si++) {
    const st = list[si];
    const y0 = st.lipY;
    const y1 = Math.min(st.footY, impactY * 1.02);
    const span = y1 - y0;
    if (span < 4) continue;

    c.save();
    traceTube(c, st, y0 - 1, y1 + 1);
    c.clip();

    /* --- the body of the sheet: our water, over the painted water --- */
    // The plate's water is only a base here. Everything that reads as falling
    // water - the rounded body, the veils, the streaks, the foam - is drawn by
    // this pass and moves; the photograph itself never does.
    let tubeX0 = Infinity, tubeX1 = -Infinity, tubeSum = 0, tubeRows = 0;
    for (const r of st.rows) {
      const sp2 = curtainSpan(st, r.y);
      tubeX0 = Math.min(tubeX0, sp2.x0);
      tubeX1 = Math.max(tubeX1, sp2.x1);
      tubeSum += (sp2.x0 + sp2.x1) / 2;
      tubeRows++;
    }
    const tubeMid = tubeRows ? tubeSum / tubeRows : W / 2;
    const tubeHalf = tubeRows ? Math.max(6, (tubeX1 - tubeX0) / 2) : W * 0.2;

    // The plate's own water, laid down as the base of the sheet. Everything
    // after this modulates *it*, so the fall keeps the photograph's colour and
    // its texture - but none of it stays still.
    if (geo?.base) {
      c.globalAlpha = 0.55;
      c.drawImage(geo.base, 0, 0, W, H);
      c.globalAlpha = 1;
    }

    // The body: our water, not the photograph's. Cool and deep in the middle
    // of the fall, aerated white at the lip and thrown into foam at the foot.
    // Kept opaque enough that the moving structure drawn after it is visible:
    // white on white is why the waterfall used to read as a still picture.
    const deepBody = c.createLinearGradient(0, y0, 0, y1);
    deepBody.addColorStop(0.00, rgbaStr(troughRgb, 0.20 * f.opacity));
    deepBody.addColorStop(0.15, rgbaStr(troughRgb, (natural ? 0.42 : 0.40) * f.opacity));
    deepBody.addColorStop(0.55, rgbaStr(troughRgb, (natural ? 0.48 : 0.46) * f.opacity));
    deepBody.addColorStop(0.90, rgbaStr(troughRgb, 0.30 * f.opacity));
    deepBody.addColorStop(1.00, rgbaStr(troughRgb, 0.18 * f.opacity));
    c.fillStyle = deepBody;
    c.fillRect(0, y0, W, span);

    const body = c.createLinearGradient(0, y0, 0, y1);
    body.addColorStop(0.00, rgbaStr(crestRgb, 0.48 * f.opacity));
    body.addColorStop(0.10, rgbaStr('255,255,255', 0.36 * f.opacity));
    body.addColorStop(0.40, rgbaStr(crestRgb, 0.34 * f.opacity));
    body.addColorStop(0.78, rgbaStr(crestRgb, 0.44 * f.opacity));
    body.addColorStop(0.94, rgbaStr(crestRgb, 0.48 * f.opacity));
    body.addColorStop(1.00, rgbaStr(crestRgb, 0.50 * f.opacity));
    c.fillStyle = body;
    c.fillRect(0, y0, W, span);

    /* --- the film: a surge that runs down the fall ------------------- */
    // Coherent, always-down motion, and the one pass that works even when the
    // plate has no usable water mask: the body itself travels.
    const stops = detail > 0.8 ? 72 : 44;
    const filmG = c.createLinearGradient(0, y0, 0, y1);
    for (let k = 0; k <= stops; k++) {
      const v = k / stops;
      const surge = 0.5 + 0.5 * Math.sin(TAU * (v * 3 - u * cycles) + si * 1.3);
      const ripple = 0.5 + 0.5 * Math.sin(TAU * (v * 7 - u * cycles * 2) + si * 1.7);
      const shade = 0.5 + 0.5 * Math.sin(TAU * (v * 3 - u * cycles + 0.5) + si * 1.3);
      const a2 = clamp(f.opacity * (0.05 + 0.20 * surge + 0.10 * ripple) * (natural ? 0.6 : 1), 0, 0.85);
      const dark = clamp(f.opacity * (natural ? 0.19 : 0.16) * shade, 0, 0.5);
      // Alternate between sheen and shadow along the fall: a light-only film on
      // white water would be invisible.
      const rgb = dark > a2 ? troughRgb : crestRgb;
      filmG.addColorStop(v, rgbaStr(rgb, Math.max(a2, dark)));
    }
    c.fillStyle = filmG;
    c.fillRect(0, y0, W, span);

    // A rounded column, not a flat wash: cool shade at both edges, bright
    // water down the middle. This is what makes the fall read as a solid
    // volume of water instead of a bright patch on the rock.
    const round = c.createLinearGradient(tubeMid - tubeHalf, 0, tubeMid + tubeHalf, 0);
    round.addColorStop(0.00, rgbaStr(troughRgb, 0.30 * f.opacity));
    round.addColorStop(0.16, rgbaStr(troughRgb, 0.08 * f.opacity));
    round.addColorStop(0.50, rgbaStr(crestRgb, 0.08 * f.opacity));
    round.addColorStop(0.84, rgbaStr(troughRgb, 0.10 * f.opacity));
    round.addColorStop(1.00, rgbaStr(troughRgb, 0.32 * f.opacity));
    c.fillStyle = round;
    c.fillRect(0, y0, W, span);

    /* --- the water itself, scrolling down the fall ------------------- */
    // Two layers of the same tile at different speeds: the fast one reads as
    // the surface rushing past, the slow one as the body of the fall.
    if (geo && geo.texH > 4 && (geo.texDark || geo.texLight)) {
      const tileH = geo.texH;
      // The shadow tile is the lace of the fall - gaps between columns of
      // water - and it scrolls at the speed of the water. The light tile rides
      // faster, as the glints on the surface do.
      // Multiply, not paint: the base is opaque water now, so the tile darkens
      // the seams between columns of water as they travel down the fall. This
      // is the motion - everything else is detail on top of it.
      if (geo.texDark) {
        c.globalCompositeOperation = 'multiply';
        const offD = frac(u * cycles) * tileH;
        c.globalAlpha = clamp((natural ? 0.45 : 0.95) * f.opacity, 0, 1);
        for (let ty = y0 - tileH + offD; ty < y1; ty += tileH) c.drawImage(geo.texDark, 0, ty, W, tileH);
      }
      // The glints ride faster than the water they sit on, as glints do.
      if (geo.texLight) {
        c.globalCompositeOperation = 'lighter';
        const offL = frac(u * (natural ? Math.round(cycles * 1.75) : cycles * 1.75)) * tileH;
        c.globalAlpha = clamp((natural ? 0.12 : 0.25) * f.opacity, 0, 1);
        for (let ty = y0 - tileH + offL; ty < y1; ty += tileH) c.drawImage(geo.texLight, 0, ty, W, tileH);
      }
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
    }

    if (sprites) {
      /* --- veils: sheets of water sliding down at different speeds --- */
      // Fast and slow veils together give the fall depth: the eye reads the
      // speed difference as water in front of water.
      const veilCount = natural ? (detail > 0.8 ? 48 : 32)
        : Math.max(10, Math.round((detail > 0.8 ? 30 : 18) * (0.55 + f.density * 0.7)));
      for (let i = 0; i < veilCount; i++) {
        const q = pr(seed, i, 131 + si);
        const sp2 = natural ? 1 : 0.5 + pr(seed, i, 137 + si) * 0.9;
        const lenJit = pr(seed, i, 139 + si);
        const len = span * (natural ? 0.15 + 0.30 * lenJit : 0.35 + 0.55 * lenJit);
        const r = curtainSpan(st, y0 + span * (0.15 + 0.7 * pr(seed, i, 157 + si)));
        const sw = Math.max(6, r.x1 - r.x0);
        const cx = r.x0 + (0.10 + 0.80 * q) * sw;
        const wpx = sw * (natural ? 0.06 + 0.16 * pr(seed, i, 149 + si) : 0.20 + 0.50 * pr(seed, i, 149 + si));
        const y = y0 + frac(u * cycles * sp2 + pr(seed, i, 151 + si)) * (span + len) - len;
        // Alternate shadow and sheen: a veil that only brightens white water is
        // invisible, and the pair reads as one sheet of water catching light.
        const dark = natural ? i % 3 !== 0 : i % 2 === 1;
        c.globalAlpha = clamp(f.opacity * (natural ? (dark ? 0.15 + 0.13 * lenJit : 0.05 + 0.08 * lenJit)
          : (dark ? 0.16 + 0.16 * lenJit : 0.14 + 0.18 * lenJit)), 0, 0.55);
        c.drawImage(dark ? sprites.veilDark : sprites.veil, cx - wpx / 2, y, wpx, len);
      }

      /* --- bright streaks, the read of rushing water --- */
      // Dense and thin: a handful of fat streaks reads as scratched film, many
      // narrow ones with mixed speeds read as water.
      const streakCount = natural ? (detail > 0.8 ? 100 : 64)
        : Math.max(12, Math.round((28 + f.density * 22) * (detail > 0.8 ? 1 : 0.6)));
      for (let i = 0; i < streakCount; i++) {
        const q = pr(seed, i, 11 + si);          // lateral position 0..1
        const k2 = pr(seed, i, 23 + si) < 0.35 ? 2 : 1;   // speed harmonic
        const ph = pr(seed, i, 37 + si);
        const lenJit = pr(seed, i, 41 + si);
        const wide = pr(seed, i, 53 + si);
        const len = span * (natural ? 0.035 + 0.12 * lenJit : 0.10 + 0.26 * lenJit) * (k2 === 2 ? 1.25 : 1);
        const travel = span + len;
        const y = y0 + frac(u * cycles * k2 + ph) * travel - len;
        const r = curtainSpan(st, clamp(y + len * 0.5, y0, y1));
        const sw = r.x1 - r.x0;
        const cx = r.x0 + (0.10 + 0.80 * q) * sw;
        const wpx = Math.max(2, sw * (0.012 + 0.032 * wide));
        // The head of a streak fades as it nears the plunge pool.
        const head = clamp(1 - (y + len - impactY) / (H * 0.10), 0, 1);
        c.globalAlpha = clamp(f.opacity * (natural ? 0.10 + 0.17 * wide : 0.26 + 0.34 * wide) * (0.35 + 0.65 * head), 0, 0.85);
        if (natural) {
          c.save();
          c.translate(cx, y + len / 2);
          c.rotate((pr(seed, i, 59 + si) - 0.5) * 0.30);
          c.drawImage(sprites.streak, -wpx / 2, -len / 2, wpx, len);
          c.restore();
        } else c.drawImage(sprites.streak, cx - wpx / 2, y, wpx, len);
        // Every third streak is a dark seam instead of a bright thread: on
        // white water it is the gaps between columns that read as movement.
        if (i % 3 === 0) {
          c.globalAlpha = clamp(f.opacity * (0.18 + 0.24 * wide), 0, 0.6);
          c.drawImage(sprites.streakDark, cx + wpx * 0.8, y, wpx * 1.6, len);
        }
      }
      if (natural) {
        // Irregular shadow channels snake down through the whitewater. Each
        // travels with gravity but has its own length, angle, and bends; they
        // are clipped to the water rather than drawn on surrounding rock.
        const channels = detail > 0.8 ? 46 : 30;
        c.lineCap = 'round';
        for (let i = 0; i < channels; i++) {
          const q = pr(seed, i, 701 + si);
          const phase = pr(seed, i, 709 + si);
          const len = span * (0.035 + 0.15 * pr(seed, i, 719 + si));
          const y = y0 + frac(u * cycles * (i % 3 === 0 ? 2 : 1) + phase) * (span + len) - len;
          const r = curtainSpan(st, clamp(y + len * 0.5, y0, y1));
          const sw = r.x1 - r.x0;
          const x = r.x0 + (0.08 + 0.84 * q) * sw;
          const bend = sw * (pr(seed, i, 727 + si) - 0.5) * 0.18;
          const drift = sw * (pr(seed, i, 733 + si) - 0.5) * 0.11;
          c.strokeStyle = rgbaStr(troughRgb, f.opacity * (0.22 + 0.16 * pr(seed, i, 739 + si)));
          c.lineWidth = Math.max(0.8, sw * (0.006 + 0.014 * pr(seed, i, 743 + si)));
          c.beginPath();
          c.moveTo(x, y);
          c.bezierCurveTo(x + bend, y + len * 0.30, x + drift - bend * 0.5, y + len * 0.70, x + drift, y + len);
          c.stroke();
        }
      }
      // Hairline threads for the spray caught inside the sheet.
      const threadCount = Math.round(streakCount * 0.45);
      for (let i = 0; i < threadCount; i++) {
        const q = pr(seed, i, 71 + si);
        const ph = pr(seed, i, 83 + si);
        const lenJit = pr(seed, i, 97 + si);
        const len = span * (0.05 + 0.13 * lenJit);
        const travel = span + len;
        const y = y0 + frac(u * (natural ? Math.round(cycles * 2.6) : cycles * 2.6) + ph) * travel - len;
        const r = curtainSpan(st, clamp(y, y0, y1));
        const cx = r.x0 + (0.04 + 0.92 * q) * (r.x1 - r.x0);
        c.globalAlpha = clamp(f.opacity * 0.05 * (0.4 + 0.6 * lenJit), 0, 0.3);
        c.drawImage(sprites.streak, cx, y, Math.max(0.7, (r.x1 - r.x0) * 0.0035), len);
      }

      /* --- foam riding the sheet down --- */
      const foamCount = Math.max(4, Math.round(14 * (detail > 0.8 ? 1 : 0.6)));
      for (let i = 0; i < foamCount; i++) {
        const q = pr(seed, i, 211 + si);
        const ph = pr(seed, i, 223 + si);
        const size = pr(seed, i, 227 + si);
        const foamPhase = frac(u * (natural ? Math.round(cycles * 1.3) : cycles * 1.3) + ph);
        const y = y0 + foamPhase * span;
        const r = curtainSpan(st, clamp(y, y0, y1));
        const cx = r.x0 + (0.12 + 0.76 * q) * (r.x1 - r.x0);
        const rad = Math.max(2, (r.x1 - r.x0) * (0.05 + 0.10 * size));
        c.globalAlpha = clamp(f.opacity * 0.10 * (natural ? Math.sin(Math.PI * foamPhase) : (0.4 + 0.6 * Math.sin(Math.PI * frac(u * cycles + ph)))), 0, 0.35);
        c.drawImage(sprites.foam, cx - rad * 1.4, y - rad * 0.7, rad * 2.8, rad * 1.5);
      }
      c.globalAlpha = 1;
    }
    c.restore();

    /* --- the sheet leaves the lip as a coherent tongue --------------- */
    // A rounded, slightly accelerated wedge in the first few percent of the
    // fall. It sits at the very top of the tube, which is the rock lip.
    if (f.opacity > 0.15) {
      const lipSpan = st.lip;
      const lw = lipSpan.x1 - lipSpan.x0;
      const cxm = (lipSpan.x0 + lipSpan.x1) / 2;
      const tongue = span * 0.055;
      c.save();
      c.globalCompositeOperation = 'lighter';
      const lg = c.createLinearGradient(0, y0, 0, y0 + tongue);
      lg.addColorStop(0, `rgba(255,255,255,${(0.42 * f.opacity).toFixed(3)})`);
      lg.addColorStop(0.45, `rgba(${crestRgb},${(0.16 * f.opacity).toFixed(3)})`);
      lg.addColorStop(1, `rgba(${crestRgb},0)`);
      c.fillStyle = lg;
      c.beginPath();
      c.moveTo(lipSpan.x0 + lw * 0.02, y0);
      c.quadraticCurveTo(cxm, y0 + tongue * 0.55, lipSpan.x1 - lw * 0.02, y0);
      c.lineTo(lipSpan.x1 - lw * 0.10, y0 + tongue);
      c.quadraticCurveTo(cxm, y0 + tongue * 1.5, lipSpan.x0 + lw * 0.10, y0 + tongue);
      c.closePath();
      c.fill();
      c.restore();
    }
  }

  // Blend the end of the falling curtain into the photographed foam rather
  // than cutting it off in a straight horizontal line at the plunge line.
  if (geo && f.impactY !== undefined) {
    c.save();
    c.globalCompositeOperation = 'destination-in';
    const fade = c.createLinearGradient(0, Math.max(0, impactY - H * 0.10), 0, Math.min(H, impactY + H * 0.025));
    fade.addColorStop(0, 'rgba(255,255,255,1)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = fade;
    c.fillRect(0, 0, W, H);
    c.restore();
  }

  /* Plunge-pool ripples. Drawn inside the sheet pass so the water silhouette
     clips them: an expanding ring belongs on water, never on the moss beside
     it. */
  if (geo && f.splash > 0.02 && geo.impactY < H * 0.97) {
    const splashAmp = clamp(f.splash, 0, 1.2);
    const rippleCycles = Math.max(2, Math.round(cycles * 0.5));
    const centres: { x: number; span: number }[] = [];
    for (const sp of geo.impactSpans) {
      const sw = sp.x1 - sp.x0;
      const nC = Math.max(1, Math.min(3, Math.round(sw / (W * 0.2))));
      for (let k = 0; k < nC; k++) {
        centres.push({ x: sp.x0 + ((k + 0.5) / nC) * sw, span: sw / nC });
      }
    }
    c.lineCap = 'round';
    for (let ci = 0; ci < centres.length; ci++) {
      const { x: cxR, span } = centres[ci];
      const jit = pr(seed, ci, 501);
      for (let k = 0; k < 3; k++) {
        const p = frac(u * rippleCycles + k / 3 + jit);
        const env = Math.sin(Math.PI * p);
        if (env <= 0.03) continue;
        // Never wider than the water it sits on.
        const rxR = Math.min(span * 0.5, W * (0.02 + p * 0.11));
        c.strokeStyle = rgbaStr(crestRgb, env * 0.26 * splashAmp);
        c.lineWidth = Math.max(0.8, (1 - p * 0.55) * Math.min(W, H) * 0.0045);
        c.beginPath();
        c.ellipse(cxR, Math.min(H * 0.96, impactY + H * (0.012 + p * 0.07)),
          rxR, rxR * 0.18, 0, 0, TAU);
        c.stroke();
      }
    }
  }
}

/** Forward displacement for a pool texture as it spreads from the impact. */
export function poolOutwardWarp(x: number, y: number, travel: number, W: number, H: number, strength: number) {
  // A stationary, feathered boundary keeps nearby rock still. Inside it every
  // point moves sideways away from the centre and down toward the foreground.
  const edge = Math.sin(Math.PI * x) * Math.sin(Math.PI * y);
  const distance = clamp(travel, 0, 1) * clamp(strength, 0, 1) * edge;
  return { dx: W * 0.18 * (2 * x - 1) * distance, dy: H * 0.38 * distance };
}

/**
 * A separately rigged plunge pool. The photograph stays put: short, broken
 * wavelets drift out from the impact, with a few darker troughs to keep the
 * movement visible on white foam. The soft oval confines them to the water.
 * Coordinates are local to the authored pool rectangle, after crop mapping.
 */
export function drawFallPool(
  c: Ctx2D, W: number, H: number, geo: FallGeometry | null,
  f: FallSpec, u: number, detail: number,
) {
  const strength = clamp(f.splash, 0, 1.2);
  const seed = f.seed || 1;
  if (strength > 0.02) {
    c.save();
    c.beginPath();
    c.ellipse(W * 0.5, H * 0.52, W * 0.49, H * 0.46, 0, 0, TAU);
    c.clip();
    c.lineCap = 'round';
    const count = detail > 0.8 ? 60 : 40;
    for (let i = 0; i < count; i++) {
      const q = pr(seed, i, 901);
      const yq = pr(seed, i, 907);
      const p = frac(u * 2 + pr(seed, i, 911));
      const life = Math.sin(Math.PI * p);
      if (life < 0.04) continue;
      const side = q < 0.5 ? -1 : 1;
      // Individual foam fragments spread sideways and toward the foreground.
      const x = W * (0.5 + (q - 0.5) * 0.65 + side * p * 0.09);
      const y = H * (0.13 + yq * 0.68 + p * 0.10);
      const length = W * (0.018 + 0.055 * pr(seed, i, 919));
      const bend = H * (0.010 + 0.025 * pr(seed, i, 929));
      const shadow = i % 3 === 0;
      c.strokeStyle = rgbaStr(shadow ? '23,45,48' : (geo?.crestRgb ?? '230,241,239'),
        life * strength * (shadow ? 0.27 : 0.34));
      c.lineWidth = Math.max(0.65, H * (shadow ? 0.018 : 0.014));
      c.beginPath();
      c.moveTo(x - length / 2, y + bend * 0.3);
      c.quadraticCurveTo(x, y - bend, x + length / 2, y + bend * 0.3);
      c.stroke();
    }
    c.restore();
  }

  // Small translucent puffs rise only a little, hover, then spread sideways
  // and fade. Whole-number cycles make both their drift and opacity loop.
  if (geo?.sprites && f.mist > 0.02) {
    c.save();
    const opacity = c.globalAlpha;
    for (let i = 0; i < 9; i++) {
      const phase = pr(seed, i, 941);
      const p = frac(u + phase);
      const life = Math.pow(Math.sin(Math.PI * p), 1.5);
      if (life < 0.02) continue;
      const side = i % 2 === 0 ? -1 : 1;
      const x = W * (0.5 + (pr(seed, i, 947) - 0.5) * 0.24 + side * p * 0.22);
      const y = H * (0.18 - life * (0.24 + 0.18 * pr(seed, i, 953))
        + 0.06 * Math.sin(TAU * (u + phase)));
      const width = W * (0.12 + 0.09 * pr(seed, i, 967)) * (0.8 + p * 0.4);
      const height = H * (0.30 + 0.18 * pr(seed, i, 971));
      c.globalAlpha = opacity * clamp(life * f.mist * 0.11, 0, 0.12);
      c.drawImage(geo.sprites.puff, x - width / 2, y - height / 2, width, height);
    }
    c.restore();
  }
}

/**
 * PASS 2 - everything that leaves the water: the spilling crest on the lip,
 * ledge bursts, plunge-pool boil, ballistic spray, ripples and mist.
 *
 * Deliberately *not* masked by the water silhouette: spray hangs in the air
 * over rock, and the crest sits a hair above the painted lip. It is feathered
 * at the region border by the caller instead.
 */
export function drawFallSpray(
  c: Ctx2D, W: number, H: number, geo: FallGeometry | null,
  f: FallSpec, u: number, detail: number, quality: 'preview' | 'export',
) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, W, H);

  const cycles = Math.max(1, Math.round(f.cycles));
  const seed = f.seed || 1;
  const impactY = geo?.impactY ?? H * 0.86;
  const sprites = geo?.sprites;
  const streams = geo?.streams ?? [];
  const mistAmp = clamp(f.mist, 0, 1.25);
  const splashAmp = clamp(f.splash, 0, 1.2);

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

  /* --- A. Water tipping over each lip -------------------------------- */
  for (let si = 0; si < streams.length; si++) {
    const st = streams[si];
    if (st.footY - st.lipY < H * 0.05) continue;
    const lip = st.lip;
    const lw = Math.max(2, lip.x1 - lip.x0);
    const cxm = (lip.x0 + lip.x1) / 2;
    // The crest breathes as volume surges over the edge - one whole cycle.
    const bob = Math.sin(TAU * (u * cycles + si * 0.3));
    const swell = 0.55 + 0.45 * Math.sin(TAU * (u * cycles * 2 + si * 0.61) + Math.PI / 2);
    const lipY = st.lipY + bob * H * 0.004;

    /* The shelf just upstream of the lip. Real water darkens and sheens the
     * rock it runs over before it ever leaves the edge, and rivulets slide
     * towards the overhang. Without this the fall looks like it is switched on
     * at a line rather than pouring over a rock. */
    const shelfH = Math.min(H * 0.045, Math.max(H * 0.012, lw * 0.30));
    if (sprites && shelfH > 1.5 && f.opacity > 0.12) {
      c.save();
      c.beginPath();
      c.rect(lip.x0 - lw * 0.06, lipY - shelfH, lw * 1.12, shelfH + 1);
      c.clip();
      c.globalAlpha = clamp(0.28 * f.opacity, 0, 0.3);
      c.drawImage(sprites.puff, lip.x0 - lw * 0.08, lipY - shelfH * 1.1, lw * 1.16, shelfH * 2.1);
      c.globalAlpha = 1;
      const rivulets = 5;
      c.lineCap = 'round';
      for (let i = 0; i < rivulets; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const q = pr(seed, i, 171 + si);
        const ph = pr(seed, i, 173 + si);
        const p = frac(u * cycles * 2 + ph);
        const env = Math.sin(Math.PI * p);
        if (env < 0.08) continue;
        const startX = cxm + side * lw * (0.16 + 0.42 * q);
        const x = startX + (cxm - startX) * p * 0.7;
        const y = lipY - shelfH * (0.85 - 0.65 * p);
        c.strokeStyle = rgbaStr('255,255,255', clamp(env * 0.30 * f.opacity, 0, 0.4));
        c.lineWidth = Math.max(0.8, lw * 0.012);
        c.beginPath();
        c.moveTo(x, y);
        c.quadraticCurveTo(x + side * lw * 0.05, y + shelfH * 0.4, x - side * lw * 0.02, lipY);
        c.stroke();
      }
      c.restore();
    }

    const w = lw * (1.02 + 0.08 * swell);
    const rimH = Math.max(1.2, Math.min(lw * 0.075, H * 0.012));
    // A soft glow *under* the rim, hugging the lip - not a cap on top of the
    // rock. This is the water gathering and thickening as it tips over.
    if (sprites) {
      c.globalAlpha = clamp(f.opacity * (0.16 + 0.12 * swell), 0, 0.42);
      c.drawImage(sprites.crest, cxm - w / 2, lipY - rimH * 0.4, w, rimH * 3.4);
      c.globalAlpha = 1;
    }
    // The rim itself: a thin, near-white line that sags very slightly in the
    // middle, because water does not go over an edge in a straight line.
    c.lineCap = 'round';
    c.strokeStyle = rgbaStr(geo?.troughRgb ?? '16,64,84', clamp(0.22 * f.opacity, 0, 0.4));
    c.lineWidth = Math.max(1, rimH * 1.1);
    c.beginPath();
    c.moveTo(lip.x0 + lw * 0.06, lipY + rimH * 1.1);
    c.quadraticCurveTo(cxm, lipY + rimH * 1.9, lip.x1 - lw * 0.06, lipY + rimH * 1.1);
    c.stroke();
    c.strokeStyle = rgbaStr('255,255,255', clamp(f.opacity * (0.26 + 0.18 * swell), 0, 0.72));
    c.lineWidth = Math.max(0.9, rimH * 0.45);
    c.beginPath();
    c.moveTo(lip.x0 + lw * 0.07, lipY);
    c.quadraticCurveTo(cxm, lipY + rimH * 0.75, lip.x1 - lw * 0.07, lipY);
    c.stroke();

    // Strands peeling off the edge: each one starts exactly on the lip and
    // stretches as it is carried over, which is the cue that sells "the water
    // is going over the rock", not "the picture starts here".
    if (sprites) {
      const strands = Math.max(6, Math.min(18, Math.round(lw / (W * 0.035))));
      const spanV = st.footY - st.lipY;
      for (let i = 0; i < strands; i++) {
        const q = pr(seed, i, 151 + si);
        const ph = pr(seed, i, 157 + si);
        const p = frac(u * cycles * 2 + ph);
        const env = Math.sin(Math.PI * p);
        if (env < 0.05) continue;
        const sx = lip.x0 + (0.05 + 0.90 * q) * lw;
        const len = spanV * (0.035 + 0.075 * p) * (0.7 + 0.6 * pr(seed, i, 163 + si));
        const sw2 = Math.max(0.9, lw * (0.006 + 0.010 * pr(seed, i, 167 + si)));
        c.globalAlpha = clamp(f.opacity * env * 0.34, 0, 0.5);
        c.drawImage(sprites.streak, sx - sw2 / 2, lipY - len * 0.25 + p * H * 0.012, sw2, len);
      }
      c.globalAlpha = 1;
    }

    // Droplets carried over the edge: detached water, so they can curve out
    // of the tube for a moment before gravity takes them.
    if (splashAmp > 0.15) {
      const n = Math.round(6 * splashAmp);
      for (let i = 0; i < n; i++) {
        const q = pr(seed, i, 131 + si);
        const ph = pr(seed, i, 137 + si);
        const p = frac(u * cycles * 2 + ph);
        const env = Math.sin(Math.PI * p);
        if (env < 0.05) continue;
        const x = lip.x0 + (0.08 + 0.84 * q) * lw + (q - 0.5) * lw * 0.28 * p;
        const y = lipY + rimH * 1.4 + p * H * 0.05;
        c.fillStyle = rgbaStr('255,255,255', env * 0.62 * splashAmp);
        c.beginPath();
        c.arc(x, y, Math.max(0.7, Math.min(W, H) * 0.0035), 0, TAU);
        c.fill();
      }
    }

    /* --- B. Ledge bursts: the water hits a step in the rock ---------- */
    for (let j = 0; j < st.steps.length; j++) {
      const step = st.steps[j];
      const p = frac(u * cycles * 2 + pr(seed, j, 211 + si));
      const env = Math.sin(Math.PI * p);
      if (env < 0.04) continue;
      const sw = step.x1 - step.x0;
      const sx = (step.x0 + step.x1) / 2;
      const r = Math.min(W, H) * (0.03 + 0.05 * envg(step.strength) * env);
      if (sprites) {
        c.globalAlpha = clamp(env * splashAmp * 0.42 * step.strength, 0, 0.6);
        c.drawImage(sprites.foam, sx - r * 1.5, step.y - r * 0.7, r * 3, r * 1.4);
        c.globalAlpha = 1;
      }
      // Water thrown sideways off the ledge, falling back into the stream.
      const nDrops = Math.round(4 * splashAmp * step.strength);
      for (let i = 0; i < nDrops; i++) {
        const side = pr(seed, i + j * 7, 223 + si) < 0.5 ? -1 : 1;
        const q = pr(seed, i + j * 7, 227 + si);
        const pp = frac(u * cycles * 2 + q);
        const e2 = Math.sin(Math.PI * pp);
        const dx = side * sw * (0.22 + 0.18 * q) * e2;
        const dy = -Math.sin(Math.PI * pp * 0.5) * H * 0.018 + pp * H * 0.05;
        c.fillStyle = rgbaStr('255,255,255', e2 * 0.5 * splashAmp * step.strength);
        c.beginPath();
        c.arc(sx + dx, step.y + dy, Math.max(0.6, Math.min(W, H) * 0.003), 0, TAU);
        c.fill();
      }
    }
  }

  /* --- C. The plunge pool: boil, ballistic spray, ripples ------------ */
  if (splashAmp > 0.02) {
    // Boil: foam mounds at the impact line, surging on their own phases.
    const boilCount = Math.round((quality === 'export' ? 26 : 18) * (0.6 + detail * 0.4));
    for (let i = 0; i < boilCount; i++) {
      const q = (i + 0.15 + pr(seed, i, 301) * 0.7) / boilCount;
      const p = frac(u * cycles + pr(seed, i, 307));
      const surge = Math.sin(Math.PI * p);
      if (surge <= 0.02) continue;
      const rSz = pr(seed, i, 311);
      const bx = pickImpactX(q) + (pr(seed, i, 313) - 0.5) * W * 0.03;
      const by = impactY + H * 0.008 - surge * H * (0.018 + 0.032 * rSz);
      const br = Math.min(W, H) * (0.026 + 0.036 * surge * (0.6 + rSz * 0.6));
      if (sprites) {
        c.globalAlpha = clamp(surge * 0.55 * splashAmp, 0, 0.9);
        c.drawImage(sprites.foam, bx - br * 1.6, by - br * 0.85, br * 3.2, br * 1.7);
        c.globalAlpha = 1;
      }
    }

    // Ballistic spray: droplets thrown up and out, falling back under gravity.
    const sprayCycles = Math.max(2, cycles);
    const sprayCount = Math.round((quality === 'export' ? 60 : 38) * (0.6 + detail * 0.4) * splashAmp);
    c.lineCap = 'round';
    for (let i = 0; i < sprayCount; i++) {
      const q = pr(seed, i, 401);
      const phase = pr(seed, i, 409);
      const r1 = pr(seed, i, 419);
      const r2 = pr(seed, i, 421);
      const p = frac(u * sprayCycles + phase);
      const env = Math.sin(Math.PI * p);
      if (env <= 0.04) continue;
      const ox = pickImpactX(q);
      const oy = impactY + (pr(seed, i, 431) - 0.5) * H * 0.014;
      const vx = (r1 - 0.5) * W * 0.20;
      const vy = (0.09 + 0.13 * r2) * H;
      const grav = vy * 2.2;
      const sx = ox + vx * p;
      const sy = oy - vy * p + 0.5 * grav * p * p;
      const vxp = vx, vyp = -vy + grav * p;
      const vLen = Math.hypot(vxp, vyp) || 1;
      const tail = Math.min(W, H) * (0.010 + 0.012 * r2);
      const alpha = Math.min(0.92, env * 0.8 * splashAmp);
      c.strokeStyle = rgbaStr('255,255,255', alpha * 0.8);
      c.lineWidth = Math.max(1.1, Math.min(W, H) * (0.0035 + 0.0035 * r2));
      c.beginPath();
      c.moveTo(sx - (vxp / vLen) * tail, sy - (vyp / vLen) * tail);
      c.lineTo(sx, sy);
      c.stroke();
    }
  }

  /* --- D. Mist that hangs, drifts and hovers -------------------------- */
  if (mistAmp > 0.02 && sprites) {
    // Three families: slow high vapor, base haze hugging the water, and fine
    // wisps that drift sideways across the fall.
    const families = [
      { count: 16, cycles: 1, rise: [0.30, 0.62], size: [0.16, 0.26], alpha: 0.15, speed: 0.55 },
      { count: 14, cycles: 2, rise: [0.08, 0.26], size: [0.10, 0.18], alpha: 0.17, speed: 1.0 },
      { count: 10, cycles: 1, rise: [0.10, 0.45], size: [0.22, 0.34], alpha: 0.075, speed: 0.30 },
    ];
    for (let fam = 0; fam < families.length; fam++) {
      const F = families[fam];
      for (let i = 0; i < F.count; i++) {
        const key = fam * 100 + i;
        const q = clamp((i + 0.5) / F.count + (pr(seed, key, 601) - 0.5) * 0.08, 0.02, 0.98);
        const phase = pr(seed, key, 607);
        const rRise = pr(seed, key, 611);
        const rSize = pr(seed, key, 613);
        const rDrift = pr(seed, key, 617);
        const swirl = pr(seed, key, 619);

        const p = frac(u * F.cycles * 2 + phase);
        const life = Math.pow(Math.sin(Math.PI * p), 1.15);
        if (life <= 0.01) continue;

        const ox = pickImpactX(q);
        const riseDist = H * (F.rise[0] + (F.rise[1] - F.rise[0]) * rRise) * life;
        // A slow bob on top of the rise: this is what makes the vapor *hover*
        // rather than shoot upwards like smoke.
        const hover = Math.sin(TAU * (u * F.cycles + swirl)) * H * 0.018 * (0.5 + life);
        const my = impactY + H * 0.02 - riseDist - hover;
        const outward = ((ox / W) - 0.5) * 0.5;
        const drift = Math.sin(TAU * (u * F.cycles + swirl * 1.7)) * W * 0.055
          + outward * W * 0.16 * life;
        const mx = ox + drift + (rDrift - 0.5) * W * 0.05;
        const baseR = Math.min(W, H) * (F.size[0] + (F.size[1] - F.size[0]) * rSize);
        const breathe = 0.82 + 0.18 * Math.sin(TAU * (u * F.cycles * 2 + swirl * 2.3));
        const r = baseR * (0.75 + 0.55 * life) * breathe;
        const alpha = Math.min(0.34, life * F.alpha * mistAmp * (0.7 + 0.3 * rSize));

        // Puffs, not one big cloud: overlapping blobs read as vapor volume.
        const lobes = 3;
        for (let l = 0; l < lobes; l++) {
          const la = pr(seed, key, 631 + l);
          const lb = pr(seed, key, 641 + l);
          const lx = mx + (la - 0.5) * r * 1.35;
          const ly = my + (lb - 0.5) * r * 0.55;
          const lr = r * (0.62 + 0.42 * la);
          c.globalAlpha = clamp(alpha * (0.55 + 0.45 * lb), 0, 0.4);
          c.drawImage(sprites.puff, lx - lr, ly - lr * 0.62, lr * 2, lr * 1.24);
        }
      }
    }
    c.globalAlpha = 1;

    // A low, bright haze band that clings to the impact line and slides
    // sideways - the wet-air mirage you see at the base of any real fall.
    const hazeA = 0.10 * mistAmp;
    const hz = Math.min(W, H) * 0.05;
    for (let i = 0; i < impactSpans.length; i++) {
      const sp = impactSpans[i];
      const cy = impactY + H * 0.012;
      const drift = Math.sin(TAU * (u * 1 + i * 0.4)) * W * 0.02;
      const lobes = Math.max(2, Math.round((sp.x1 - sp.x0) / (hz * 1.2)));
      for (let l = 0; l < lobes; l++) {
        const lx = sp.x0 + ((l + 0.5) / lobes) * (sp.x1 - sp.x0) + drift;
        c.globalAlpha = clamp(hazeA * (0.7 + 0.3 * Math.sin(l * 1.7 + u * 6.28)), 0, 0.2);
        c.drawImage(sprites.puff, lx - hz, cy - hz * 0.7, hz * 2, hz * 1.4);
      }
    }
    c.globalAlpha = 1;
  }
}

const envg = (v: number) => smoothstep(clamp(v, 0, 1));
