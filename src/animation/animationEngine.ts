/**
 * ANIMATION ENGINE
 * ================
 * Turns (node, time) into a description of how that node should be drawn.
 * It never touches a canvas: the compositor consumes the description. That
 * separation is what lets the same animation drive the live preview, the
 * still renderer and the video renderer identically.
 *
 * Every motion here is a function of the normalised cycle position `u in 0..1`
 * built from integer harmonics, so state(u=0) === state(u=1). Different
 * techniques are used for different materials - there is no single generic
 * "wiggle" applied to everything.
 */
import type { AssetMeta, Scene, SceneNode } from '../core/types';
import { clamp, frac, periodic, periodic2, rad, smoothstep, TAU } from '../core/util';
import type { LoopManager } from './loopManager';
import { isActive } from './loopManager';
import type { FieldFn } from '../render/deform';

/**
 * How strongly a vertical position belongs to a rigged region.
 *
 * The falloff is deliberately smooth and reaches exactly zero *at* the region
 * border. A hard 0/1 mask makes the displacement jump between two adjacent mesh
 * rows, which shows up as a tear across the artwork; and a mask that is still
 * non-zero on the border row stops the compositor from drawing the surrounding
 * area as a single clean image.
 */
function regionMask(vv: number, ry: number, rh: number, feather = 0.08): number {
  const f = Math.max(0.01, Math.min(feather, rh / 2));
  const edge = Math.min((vv - ry) / f, (ry + rh - vv) / f);
  return smoothstep(clamp(edge, 0, 1));
}

export interface RegionScroll {
  axis: 'x' | 'y';
  region: [number, number, number, number];  // normalised within the node
  cycles: number;                            // whole tiles per loop (integer)
  feather: number;                           // 0..0.5 edge softness
  wobble: number;                            // lateral instability, px fraction
  /**
   * +1 travels along the positive axis (DOWN for y, right for x), -1 against it.
   * Gravity is not optional: a waterfall must fall. Getting this sign wrong
   * makes water climb, which is immediately obvious to anyone looking at it.
   */
  direction: 1 | -1;
}

/**
 * Falling water. A painted waterfall already looks like a waterfall; sliding
 * the whole painted region just drags the lip and the pool along with it and
 * marches a tiling seam through the picture. What actually reads as falling is
 * a set of bright streaks travelling DOWN over stationary artwork.
 *
 * Every streak completes a whole number of traversals per cycle, so the whole
 * field returns exactly to its start - the loop is genuinely seamless.
 */
export interface FallSpec {
  region: [number, number, number, number];
  cycles: number;      // integer traversals per loop
  density: number;     // water curtain count
  length: number;      // curtain length, fraction of cascade height
  width: number;       // curtain width, fraction of region width
  opacity: number;     // 0..1 water contrast
  seed: number;
  splash: number;      // 0..1.2 plunge boil, leaping droplets & pool ripples
  mist: number;        // 0..1.2 big rising & drifting mist plumes
}

export interface LocalAtmosphereSpec {
  /** Fireplace: x, y, width, height. Steam: origin x/y, width and rise height. */
  region: [number, number, number, number];
  phase: number;
  amplitude: number;
  turbulence: number;
  seed: number;
}

export interface NodeRenderState {
  offsetX: number;
  offsetY: number;
  rotation: number;      // extra degrees
  scale: number;
  alpha: number;
  glow: number;          // 0..1 additive bloom around the object
  warp: null | {
    mode: 'strip' | 'mesh'; cols: number; rows: number; field: FieldFn;
    /** Normalised v positions that must land exactly on a mesh row line. Put the
     *  edges of a masked region here so no triangle band straddles the boundary
     *  and drags stationary artwork along with the moving part. */
    breaks?: number[];
    /** Normalised v range outside which the field is guaranteed to be zero at
     *  every phase. Declaring it makes the stationary bands deterministic: a
     *  band must not flip between triangle and plain-slice rendering as the
     *  displacement passes through zero, or the still artwork re-resamples and
     *  appears to shimmer. */
    active?: [number, number];
  };
  scroll: RegionScroll | null;
  fall: FallSpec | null;
  flame: LocalAtmosphereSpec | null;
  steam: LocalAtmosphereSpec | null;
  animated: boolean;
}

export type Quality = 'preview' | 'export';

const IDENTITY: NodeRenderState = {
  offsetX: 0, offsetY: 0, rotation: 0, scale: 1, alpha: 1, glow: 0,
  warp: null, scroll: null, fall: null, flame: null, steam: null, animated: false,
};

export class AnimationEngine {
  /**
   * @param time  absolute scene time in seconds
   * @param loops the Loop Manager, which owns cycle harmonisation
   */
  evaluate(
    scene: Scene, node: SceneNode, time: number, loops: LoopManager,
    meta: AssetMeta | undefined, quality: Quality = 'preview', audition = false,
  ): NodeRenderState {
    if (node.kind === 'effect') return { ...IDENTITY, animated: true };
    const a = node.animation;
    if (!a || !a.enabled || a.type === 'none' || !isActive(node, time, audition)) {
      return { ...IDENTITY };
    }

    const u = loops.phaseAt(scene, node, time);
    const amp = clamp(a.amplitude, 0, 1);
    const turb = clamp(a.turbulence, 0, 1);
    const seed = a.seed || 1;
    const w = node.width, h = node.height;
    const state: NodeRenderState = { ...IDENTITY, animated: true };
    const detail = quality === 'export' ? 1 : 0.7;
    const dirX = Math.cos(rad(a.direction - 90));
    const dirY = Math.sin(rad(a.direction - 90));

    switch (a.type) {
      /* Trees: the trunk stays planted, the canopy moves, and each branch
         cluster runs slightly out of phase so it never looks like one rigid
         object being rotated. */
      case 'canopy-sway': {
        const canopyStart = meta?.rig?.canopyStart ?? 0.66;
        const stiffness = meta?.rig?.stiffness ?? 0.7;
        const gusts = Math.max(1, Math.round(meta?.rig?.gusts ?? 3));
        const reach = w * 0.045 * amp;
        const field: FieldFn = (uu, vv) => {
          const canopyWeight = vv < canopyStart
            ? smoothstep(clamp((canopyStart - vv) / Math.max(0.05, canopyStart), 0, 1))
            : 0;
          const trunkWeight = (1 - vv) ** 2 * (1 - stiffness) * 0.22;
          const weight = canopyWeight + trunkWeight;
          const branch = periodic2(u, uu * 3.1, vv * 2.3, seed, 3);
          const main = Math.sin(TAU * u) * 0.65 + Math.sin(TAU * gusts * u + 1.1) * 0.22;
          const sway = main * (1 - turb * 0.55) + branch * turb;
          return {
            dx: sway * reach * weight * (dirX >= 0 ? 1 : -1),
            dy: Math.abs(sway) * reach * 0.16 * weight * -1 + branch * reach * 0.07 * weight,
          };
        };
        state.warp = {
          mode: 'mesh',
          cols: Math.max(4, Math.round(7 * detail)),
          rows: Math.max(5, Math.round(9 * detail)),
          field,
        };
        break;
      }

      /* Grass and bushes: anchored at the soil, tips travel furthest. */
      case 'grass-wind': {
        const reach = w * 0.20 * amp;
        const gusts = Math.max(1, Math.round(meta?.rig?.gusts ?? 4));
        const field: FieldFn = (_uu, vv) => {
          const weight = (1 - vv) ** 1.7;
          const gust = 0.62 + 0.38 * Math.sin(TAU * gusts * u + 0.7);
          const organic = periodic(u, seed, 4) * turb;
          const sway = (Math.sin(TAU * u) * 0.7 + organic * 0.9) * gust;
          return { dx: sway * reach * weight * (dirX >= 0 ? 1 : -1), dy: -Math.abs(sway) * reach * 0.10 * weight };
        };
        state.warp = { mode: 'strip', cols: 1, rows: Math.max(10, Math.round(22 * detail)), field };
        break;
      }

      /* Flowers: the stem bends and the head lags behind it. */
      case 'stem-bend': {
        const reach = w * 0.16 * amp;
        const field: FieldFn = (_uu, vv) => {
          const stem = (1 - vv) ** 2.1;
          const headLag = vv < 0.3 ? Math.sin(TAU * u - 0.9) * 0.35 : 0;
          const sway = Math.sin(TAU * u) * 0.75 + periodic(u, seed, 3) * turb * 0.6 + headLag;
          return {
            dx: sway * reach * stem * (dirX >= 0 ? 1 : -1),
            dy: -Math.abs(sway) * reach * 0.14 * stem + Math.sin(TAU * 2 * u) * h * 0.006 * amp * stem,
          };
        };
        state.warp = { mode: 'strip', cols: 1, rows: Math.max(10, Math.round(24 * detail)), field };
        break;
      }

      /* Water surfaces: travelling waves, not a sliding picture. */
      case 'water-flow':
      case 'water-shimmer': {
        const reach = w * 0.012 * amp;
        const region = meta?.rig?.region;
        const field: FieldFn = (_uu, vv) => {
          let mask = 1;
          if (region) {
            const [, ry, , rh] = region;
            mask = regionMask(vv, ry, rh);
          } else if (a.type === 'water-shimmer') {
            mask = smoothstep(clamp((vv - 0.55) / 0.2, 0, 1));
          }
          const wave = Math.sin(TAU * (vv * 7 - u * 2)) + 0.5 * Math.sin(TAU * (vv * 13 - u * 3));
          return { dx: wave * reach * mask, dy: Math.sin(TAU * (vv * 9 - u)) * reach * 0.25 * mask };
        };
        // A grid (not bands) so the displacement is interpolated smoothly and
        // the surface never tears along a band edge.
        state.warp = {
          mode: 'mesh',
          cols: Math.max(4, Math.round(7 * detail)),
          rows: Math.max(10, Math.round(22 * detail)),
          field,
          breaks: region ? [region[1], region[1] + region[3]] : undefined,
          active: region ? [region[1], region[1] + region[3]] : [0.55, 1],
        };
        break;
      }

      case 'waterfall-flow': {
        const region = (meta?.rig?.region ?? [0.16, 0.10, 0.68, 0.85]) as [number, number, number, number];
        const speed = typeof meta?.rig?.speed === 'number' ? meta.rig.speed : 1;
        // Multi-stage falling water: rushing curtains and droplets plunging down
        // the cascades, whitewater splash & ballistic spray at the impact line,
        // expanding plunge-pool ripples, and big billowing mist clouds rising
        // and drifting across the canyon. The painted rock and foliage stay put.
        state.fall = {
          region,
          cycles: Math.max(2, Math.round(3 * speed * (0.65 + amp * 0.65))),
          // Dense enough to read as continuously moving water at preview size.
          density: Math.max(48, Math.round(76 * detail)),
          length: 0.25,
          width: 0.032,
          opacity: clamp(0.55 + amp * 0.42, 0, 0.98),
          seed: a.seed || 1337,
          splash: clamp((0.45 + amp * 0.55) * (0.55 + turb * 0.65), 0, 1.2),
          mist: clamp((0.50 + amp * 0.50) * (0.55 + turb * 0.70), 0, 1.25),
        };
        // Deliberately NO mesh warp here. regionMask only gates vertically, so a
        // lateral wobble smeared rock and foliage across the full width of the
        // plate in horizontal bands - the artwork visibly slid, which is exactly
        // what made this read as "a picture of a waterfall" rather than water.
        break;
      }

      case 'ripple': {
        const reach = Math.min(w, h) * 0.02 * amp;
        const field: FieldFn = (uu, vv) => {
          const dx0 = uu - 0.5, dy0 = vv - 0.5;
          const r = Math.hypot(dx0, dy0) * 2;
          const wave = Math.sin(TAU * (r * 3 - u * 2)) * Math.max(0, 1 - r);
          return { dx: wave * reach * (dx0 / (r || 1)), dy: wave * reach * (dy0 / (r || 1)) };
        };
        state.warp = {
          mode: 'mesh', cols: Math.max(5, Math.round(9 * detail)), rows: Math.max(5, Math.round(9 * detail)), field,
        };
        break;
      }

      case 'flag-wave': {
        const reach = h * 0.14 * amp;
        const field: FieldFn = (uu, vv) => {
          const anchor = uu ** 1.3;
          return {
            dx: 0,
            dy: Math.sin(TAU * (uu * 2 - u * 2)) * reach * anchor
              + Math.sin(TAU * (uu * 4 - u * 3)) * reach * 0.3 * anchor * (0.5 + vv * 0.5),
          };
        };
        state.warp = {
          mode: 'mesh', cols: Math.max(6, Math.round(12 * detail)), rows: Math.max(3, Math.round(5 * detail)), field,
        };
        break;
      }

      case 'float': {
        const rx = w * 0.05 * amp, ry = h * 0.06 * amp;
        state.offsetX = Math.sin(TAU * u) * rx + periodic(u, seed, 3) * rx * turb;
        state.offsetY = Math.sin(TAU * 2 * u + 1.2) * ry * 0.6 + periodic(u, seed + 9, 3) * ry * turb;
        state.rotation = Math.sin(TAU * u + 0.4) * 2.2 * amp;
        break;
      }

      case 'spin':
        state.rotation = 360 * frac(u) * (dirY >= 0 ? 1 : -1);
        break;

      case 'pulse':
        state.scale = 1 + Math.sin(TAU * u) * 0.07 * amp;
        state.alpha = 1 - (0.5 + 0.5 * Math.sin(TAU * u + Math.PI)) * 0.25 * amp;
        state.glow = (0.5 + 0.5 * Math.sin(TAU * u)) * amp * 0.6;
        break;

      case 'lantern-glow':
        state.glow = (0.55 + 0.45 * Math.sin(TAU * u)) * (0.35 + amp * 0.65);
        break;

      case 'hearth-fire':
        state.flame = { region: meta?.rig?.region ?? [0.35, 0.45, 0.3, 0.3],
          phase: u, amplitude: amp, turbulence: turb, seed };
        if (meta?.rig?.steamRegion) {
          state.steam = { region: meta.rig.steamRegion, phase: u, amplitude: amp, turbulence: turb, seed };
        }
        break;

      case 'coffee-steam':
        state.steam = { region: meta?.rig?.region ?? [0.5, 0.12, 0.3, 0.65],
          phase: u, amplitude: amp, turbulence: turb, seed };
        break;

      case 'cloud-drift': {
        state.scroll = {
          axis: 'x', region: [0, 0, 1, 0.42], cycles: 1, feather: 0.22, wobble: 0,
          direction: -1,   // clouds drift left; unchanged from before
        };
        break;
      }

      case 'parallax':
        state.scale = 1 + Math.sin(TAU * u) * 0.012 * amp + 0.012 * amp;
        state.offsetY = Math.sin(TAU * u) * h * 0.004 * amp;
        break;

      default:
        return { ...IDENTITY };
    }
    return state;
  }
}

export const animationEngine = new AnimationEngine();
