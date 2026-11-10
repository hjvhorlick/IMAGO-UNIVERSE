/** Painted birds with separately articulated wings, flying across the sky.
 * Sprite masks are prepared once per source image, not per frame. */
import { clamp, frac, TAU } from '../core/util';
import { pr } from '../animation/effectPrimitives';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Point = [number, number];
interface BirdSpec { crop: [number, number, number, number]; pivot: Point; wing: Point[]; outline?: Point[]; level: number }
interface BirdSprite { body: Canvas; wing: Canvas; width: number; height: number; pivot: Point; level: number }

// Coordinates are in the common original 1000 × 545 plate. The three look
// variants share precisely the same painted silhouettes and proportions.
// Both source birds were painted climbing, so `level` records the clockwise
// rotation (radians) that brings each body horizontal, beak into the wind.
/** Clockwise rotation (radians) that levels each painted climbing pose. */
const LEVELS = [0.5, 0.66];
const BIRDS: BirdSpec[] = [
  { crop: [180, 30, 160, 190], pivot: [94, 95], level: LEVELS[0],
    wing: [[0, 0], [113, 0], [113, 72], [105, 81], [99, 85], [83, 100], [70, 114], [35, 116], [0, 102]],
    outline: [[0, 0], [160, 0], [160, 190], [53, 190], [53, 158], [0, 158]] },
  { crop: [215, 335, 150, 170], pivot: [93, 67], level: LEVELS[1],
    wing: [[0, 0], [102, 0], [105, 46], [101, 55], [93, 65], [73, 88], [54, 104], [0, 108]] },
];
const cache = new WeakMap<object, BirdSprite[]>();

function canvas(w: number, h: number): Canvas {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
}
function polygon(ctx: Ctx, pts: Point[]) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
}
function makeSprites(src: CanvasImageSource, iw: number, ih: number): BirdSprite[] {
  const cached = cache.get(src as object);
  if (cached) return cached;
  const result = BIRDS.map((spec) => {
    const [x, y, w, h] = spec.crop;
    // Keep the source artwork's native resolution for close-up/export use.
    const sx = iw / 1000, sy = ih / 545;
    const W = Math.ceil(w * sx), H = Math.ceil(h * sy);
    const cut = canvas(W, H), cc = cut.getContext('2d') as Ctx;
    cc.scale(W / w, H / h);
    if (spec.outline) { polygon(cc, spec.outline); cc.clip(); }
    cc.drawImage(src, x * sx, y * sy, w * sx, h * sy, 0, 0, w, h);
    const body = canvas(W, H), bc = body.getContext('2d') as Ctx;
    bc.drawImage(cut, 0, 0); bc.scale(W / w, H / h);
    bc.globalCompositeOperation = 'destination-out'; polygon(bc, spec.wing); bc.fill();
    // Keep a small feathered shoulder over the moving wing. It conceals the
    // cut line as the wing folds, instead of a detached, rotating cardboard flap.
    bc.globalCompositeOperation = 'source-over';
    bc.save(); bc.beginPath(); bc.arc(spec.pivot[0], spec.pivot[1], 10, 0, TAU); bc.clip();
    bc.drawImage(cut, 0, 0, W, H, 0, 0, w, h); bc.restore();
    const wing = canvas(W, H), wc = wing.getContext('2d') as Ctx;
    wc.scale(W / w, H / h); polygon(wc, spec.wing); wc.clip();
    wc.drawImage(cut, 0, 0, W, H, 0, 0, w, h);
    return { body, wing, width: w, height: h, pivot: spec.pivot, level: spec.level };
  });
  cache.set(src as object, result);
  return result;
}

/** A seeded loose group with real flock texture: birds gather in a few
 * sub-clusters of different density (flocks are never evenly spaced), with
 * stragglers between them. Only a minimum gap is enforced, so neighbours end
 * up at very different distances from each other. */
const groupCache = new Map<number, Point[]>();
export function flockFormation(seed = 1): Point[] {
  const key = seed | 0;
  const cached = groupCache.get(key);
  if (cached) return cached;
  const clusters = 4 + Math.floor(pr(key, 0, 201) * 3);
  const centres = Array.from({ length: clusters }, (_, c) => [
    0.14 + 0.72 * pr(key, c, 203), 0.16 + 0.68 * pr(key, c, 205)] as Point);
  const radii = centres.map((_, c) => 0.05 + 0.15 * pr(key, c, 207));
  const points: Point[] = [];
  for (let candidate = 0; candidate < 2400 && points.length < 18; candidate++) {
    const c = Math.floor(pr(key, candidate, 209) * clusters);
    const a = TAU * pr(key, candidate, 211), r = Math.sqrt(pr(key, candidate, 213));
    const x = clamp(centres[c][0] + Math.cos(a) * r * radii[c] * 1.7, 0.03, 0.97);
    const y = clamp(centres[c][1] + Math.sin(a) * r * radii[c] * 1.1, 0.06, 0.94);
    if (points.every(([px, py]) => (x - px) ** 2 + (y - py) ** 2 >= 0.07 ** 2)) points.push([x, y]);
  }
  // Rare seeds pack every cluster too tight for eighteen; top up widely.
  for (let candidate = 0; candidate < 1200 && points.length < 18; candidate++) {
    const x = 0.03 + 0.94 * pr(key, candidate, 101);
    const y = 0.06 + 0.88 * pr(key, candidate, 103);
    if (points.every(([px, py]) => (x - px) ** 2 + (y - py) ** 2 >= 0.07 ** 2)) points.push([x, y]);
  }
  if (groupCache.size >= 32) groupCache.delete(groupCache.keys().next().value as number);
  groupCache.set(key, points);
  return points;
}

/** How strongly this bird is flapping right now, 0 = gliding, 1 = mid-burst.
 *
 * Real songbirds cruise on intermittent flight: a few quick beats, then a
 * rest with the wings held low or folded, each bird on its own schedule.
 * Every bird therefore gets an integer number of flap bursts per loop with a
 * seeded offset, so bursts never synchronise and the loop still closes. */
export function flockFlapEnvelope(phase: number, amplitude: number, index: number, seed: number): number {
  // One wing cycle per bird - a flap burst and a glide - started at a random
  // point of its own sequence, so at any moment part of the flock is beating
  // its wings while the rest glide.
  const bursts = 3 + (index % 3);
  const duty = 0.32 + 0.16 * pr(seed, index, 317);
  const u = frac(phase * bursts + pr(seed, index, 307));
  return u < duty ? amplitude * Math.sin(Math.PI * u / duty) : 0;
}
export interface WingPose { fold: number; stretch: number }
/** Wing attitude about the shoulder. At rest the painted raised fan is swept
 * back and foreshortened into a low, extended glide line; during a burst it
 * swings between a deep downstroke and just past the raised pose. */
export function flockWingPose(phase: number, beats: number, amplitude: number, index: number, seed: number, turbulence = 0.45): WingPose {
  const env = flockFlapEnvelope(phase, amplitude, index, seed);
  // Gliding holds the wings out level with the bird's side - along the body
  // line, never above the middle - the way a cruising songbird sets them.
  const restFold = -1.35 - 0.15 * pr(seed, index, 311) - 0.1 * turbulence;
  const restStretch = 0.72 + 0.12 * pr(seed, index, 313);
  // A burst swings them from below that line up past the raised pose.
  const f = Math.sin(TAU * (phase * beats + pr(seed, index, 319)));
  const flapFold = -0.95 + 0.75 * f;
  const flapStretch = 0.8 + 0.25 * (0.5 + 0.5 * f);
  return {
    fold: restFold + (flapFold - restFold) * env,
    stretch: restStretch + (flapStretch - restStretch) * env,
  };
}

/** One long crossing of the sky and back, at an uneven, breathing speed.
 *
 * The right-hand leg carries the group clean off the frame before it turns
 * (a flock should not be pinned inside the picture); the left-hand leg only
 * pokes past the edge, so the birds keep re-entering at different depths.
 * The heading flips exactly at each turnaround, where the velocity is zero,
 * so the birds always face the way the group is actually moving. */
export function flockFlight(width: number, groupWidth: number, birdSize: number, phase: number): { center: number; heading: number } {
  const distance = width / 2 + groupWidth * 0.95 + birdSize * 3;
  const t = TAU * frac(phase);
  const sway = (Math.sin(t) + 0.16 * Math.sin(2 * t) + 0.09 * Math.sin(3 * t)) / 1.22;
  // Smooth asymmetric mapping: full excursion one way, partial the other.
  const asym = sway * (1 + 0.3 * sway) / 1.3;
  const velocity = Math.cos(t) + 0.32 * Math.cos(2 * t) + 0.27 * Math.cos(3 * t);
  return { center: width / 2 + distance * asym, heading: velocity < 0 ? -1 : 1 };
}

/** Slow depth cycle of the whole group: it drifts further away (smaller,
 * tighter, a little higher) and then comes back out closer, once per loop. */
export function flockDepth(phase: number, seed: number): number {
  return 1 + 0.22 * Math.sin(TAU * (phase + pr(seed, 0, 327)));
}

export interface FlockBirdState {
  x: number; y: number; heading: number; attitude: number;
  size: number; wingScale: number; fold: number;
}

/** Where every bird is and how it holds itself this frame. The renderer and
 * the regression tests both read this one description of the flock. */
export function flockBirdStates(
  width: number, height: number, phase: number, beats: number, amplitude: number,
  seed: number, turbulence = 0.45, travel = true,
): FlockBirdState[] {
  const depth = travel && amplitude > 0 ? flockDepth(phase, seed) : 1;
  const groupWidth = Math.min(width * 0.50, Math.max(height * 1.1, width * 0.28)) * depth;
  const baseSize = Math.min(groupWidth * 0.075, height * 0.12);
  const flying = travel && amplitude > 0;
  const flight = flying ? flockFlight(width, groupWidth, baseSize, phase) : { center: width / 2, heading: 1 };
  return flockFormation(seed).map(([fx, fy], i) => {
    const pose = flockWingPose(phase, beats, amplitude, i, seed, turbulence);
    const env = flockFlapEnvelope(phase, amplitude, i, seed);
    // A little per-bird attitude, plus the nose lifting into each burst, so
    // the group never looks stamped from one stencil.
    const attitude = LEVELS[i % LEVELS.length] + 0.05 * (pr(seed, i, 111) * 2 - 1)
      + 0.05 * env * Math.sin(TAU * (phase * beats + pr(seed, i, 319)));
    // Each bird keeps its own speed: a slow longitudinal slide along the
    // group, on one or two cycles per loop, so birds overtake each other.
    const slide = flying ? groupWidth * (0.05 + 0.09 * pr(seed, i, 321))
      * Math.sin(TAU * (phase * (1 + (i % 2)) + pr(seed, i, 323))) : 0;
    const driftY = flying ? height * (0.012 * Math.sin(TAU * (phase * 2 + pr(seed, i, 107)))
      + 0.005 * Math.sin(TAU * (phase * 3 + pr(seed, i, 109)))) : 0;
    // Further away the group closes up and rides a little higher in the sky.
    const y = height * (0.5 + (fy - 0.5) * (0.7 + 0.3 * depth)) - height * 0.1 * (1 - depth) + driftY;
    return {
      x: flight.center + groupWidth * (fx - 0.5) + slide,
      y,
      heading: flight.heading,
      attitude,
      size: baseSize * (0.94 + (i % 3) * 0.06),
      wingScale: pose.stretch,
      fold: pose.fold,
    };
  });
}

/** Draw the birds from a painted source, flapping and crossing their sky area. */
export function drawFlyingFlock(
  ctx: Ctx, src: CanvasImageSource, iw: number, ih: number, width: number, height: number,
  phase: number, beats: number, amplitude: number, seed: number, turbulence = 0.45, travel = true,
) {
  const sprites = makeSprites(src, iw, ih);
  const states = flockBirdStates(width, height, phase, beats, amplitude, seed, turbulence, travel);
  for (const [i, s] of states.entries()) {
    const bird = sprites[i % sprites.length];
    const h = s.size * bird.height / bird.width;
    ctx.save();
    ctx.translate(s.x, s.y);
    // Mirror last, so levelled birds face whichever way the group is heading.
    ctx.scale(s.heading, 1);
    ctx.rotate(s.attitude);
    ctx.translate(-s.size * 0.5, -h * 0.61);
    const px = s.size * bird.pivot[0] / bird.width, py = h * bird.pivot[1] / bird.height;
    ctx.save(); ctx.translate(px, py); ctx.rotate(s.fold); ctx.scale(1, s.wingScale); ctx.translate(-px, -py);
    ctx.drawImage(bird.wing, 0, 0, bird.wing.width, bird.wing.height, 0, 0, s.size, h);
    ctx.restore();
    ctx.drawImage(bird.body, 0, 0, bird.body.width, bird.body.height, 0, 0, s.size, h);
    ctx.restore();
  }
}
