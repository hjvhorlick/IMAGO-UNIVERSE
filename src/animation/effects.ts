/**
 * LAYER 4 - ATMOSPHERE & IMAGINATION
 * ==================================
 * The universal effect library. Nothing in this file is filtered by artistic
 * style: every effect is available in every world.
 *
 * Each effect declares only the parameters that make sense for it, so the
 * inspector never shows irrelevant controls. Each `draw` is a pure function of
 * (u, seed, params) which guarantees exact looping.
 */
import { clamp, frac, rad, TAU } from '../core/util';
import { readWaterShape, traceWaterShape, waterShapeFeather } from '../core/waterShape';
import { waterCrestPosition, waterCrestSpan, waterCrestStrokeWidths } from '../core/waterSurface';
import {
  butterflyShape, bool, coreDot, envelope, featherShape, glowDot, leafShape, life,
  num, petalShape, pr, runeGlyph, snowflake, sparkleStar, str, withAlpha,
} from './effectPrimitives';
import type { Ctx2D, EffectDrawContext } from './effectPrimitives';
import { SPIRITUAL_EFFECTS } from './spiritualOverlays';

export type EffectFamily = 'magical' | 'symbols' | 'celestial' | 'fantasy' | 'natural' | 'weather' | 'spiritual';

export interface ParamDef {
  key: string;
  label: string;
  type: 'range' | 'color' | 'select' | 'toggle';
  min?: number; max?: number; step?: number;
  default: number | string | boolean;
  unit?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

export interface EffectDef {
  id: string;
  name: string;
  family: EffectFamily;
  subcategory?: string;
  /** Individually placeable effect, rather than a full-scene atmosphere. */
  bounded?: boolean;
  /** Animate the already-composited image beneath this effect. */
  waterDistortion?: 'lake' | 'lake-waves' | 'river';
  /** The canvas exposes eight draggable vertices for this water region. */
  waterShape?: boolean;
  description: string;
  defaultLoop: number;
  blend: GlobalCompositeOperation;
  params: ParamDef[];
  draw: (ctx: Ctx2D, d: EffectDrawContext) => void;
}

const R = (key: string, label: string, min: number, max: number, step: number,
  def: number, unit = '', hint?: string): ParamDef =>
  ({ key, label, type: 'range', min, max, step, default: def, unit, hint });
const C = (key: string, label: string, def: string): ParamDef => ({ key, label, type: 'color', default: def });
const T = (key: string, label: string, def: boolean): ParamDef => ({ key, label, type: 'toggle', default: def });
const S = (key: string, label: string, def: string, options: string[][]): ParamDef =>
  ({ key, label, type: 'select', default: def, options: options.map(([value, l]) => ({ value, label: l })) });

const DENSITY = R('density', 'Density', 4, 400, 1, 90, ' particles');
const GLOW = R('glow', 'Glow', 0, 3, 0.05, 1.2, 'x');

/* ====================================================================== */

/** Heavy rain, including effects already saved with the original density. */
export function rainRippleCount(density: number): number {
  return Math.round(clamp(density, 3, 30)) * 20;
}

/** Three times the earlier number of crests, including saved effects. */
export function waterCrestCount(density: number): number {
  return Math.round(clamp(density, 4, 100)) * 6;
}

/** Broken, shaded crests travel over the deformed water, rather than merely
 * moving the photographed reflection. Both crest and trough fade at the mask. */
function drawChoppySurface(ctx: Ctx2D, d: EffectDrawContext, river: boolean) {
  const strength = clamp(num(d.params, 'strength', river ? 0.60 : 0.55), 0, 1);
  if (strength <= 0) return;
  const points = readWaterShape(d.params.waterShape);
  const count = waterCrestCount(num(d.params, 'density', river ? 52 : 56));
  const length = clamp(num(d.params, 'length', 1), 0.4, 2);
  const rate = Math.round(clamp(num(d.params, 'rate', 2), 1, 4));
  const color = str(d.params, 'color', '#d9edf0');
  const direction = str(d.params, 'direction', 'right');
  ctx.save(); traceWaterShape(ctx, points, d.w, d.h); ctx.clip('evenodd');
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 0; i < count; i++) {
    const seedX = pr(d.seed, i, 921), seedY = pr(d.seed, i, 923);
    const t = d.u * rate;
    const position = waterCrestPosition(seedX, seedY, pr(d.seed, i, 933), d.u, rate,
      river ? 'river' : 'lake-waves', direction);
    const x = d.w * position.x, y = d.h * position.y;
    const fade = waterShapeFeather(x, y, d.w, d.h, points);
    const alpha = strength * fade * position.life;
    if (alpha < 0.01) continue;
    const span = waterCrestSpan(d.w, length, pr(d.seed, i, 927));
    const height = d.h * (0.007 + 0.014 * pr(d.seed, i, 929));
    const strokes = waterCrestStrokeWidths(height, d.scale);
    const agitation = Math.sin(TAU * (t * 2 + pr(d.seed, i, 931)));
    ctx.save(); ctx.translate(x, y);
    // Tapered dark trough and broken bright crest give each little wave a
    // surface and depth, rather than a field of arrow-shaped strokes.
    const shade = ctx.createLinearGradient(-span / 2, 0, span / 2, 0);
    shade.addColorStop(0, 'rgba(22,62,72,0)');
    shade.addColorStop(0.3, `rgba(22,62,72,${alpha * 0.25})`);
    shade.addColorStop(0.7, `rgba(22,62,72,${alpha * 0.25})`);
    shade.addColorStop(1, 'rgba(22,62,72,0)');
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.moveTo(-span * 0.5, 0);
    ctx.quadraticCurveTo(-span * 0.22, -height * (0.8 + agitation * 0.25), span * 0.05, -height * 0.45);
    ctx.quadraticCurveTo(span * 0.3, height * 0.1, span * 0.5, 0);
    ctx.quadraticCurveTo(span * 0.25, height * 0.8, span * 0.05, height * 0.65);
    ctx.quadraticCurveTo(-span * 0.25, height * 0.2, -span * 0.5, 0); ctx.fill();
    const light = ctx.createLinearGradient(-span / 2, 0, span / 2, 0);
    light.addColorStop(0, withAlpha(color, 0));
    light.addColorStop(0.3, withAlpha(color, alpha * 0.98));
    light.addColorStop(0.7, withAlpha(color, alpha * 0.98));
    light.addColorStop(1, withAlpha(color, 0));
    ctx.strokeStyle = light;
    ctx.lineWidth = strokes.edge;
    ctx.beginPath(); ctx.moveTo(-span * 0.5, -height * 0.05);
    ctx.quadraticCurveTo(-span * 0.22, -height * (0.8 + agitation * 0.25), span * 0.05, -height * 0.45);
    ctx.quadraticCurveTo(span * 0.3, height * 0.1, span * 0.5, 0); ctx.stroke();
    // A narrow intermittent specular glint sits on the crest, rather than
    // painting the whole wave white. Its shimmer remains exactly loopable.
    const gleam = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TAU * (t * 2 + pr(d.seed, i, 937))))) * alpha;
    const shine = ctx.createLinearGradient(-span * 0.3, 0, span * 0.22, 0);
    shine.addColorStop(0, 'rgba(255,255,255,0)');
    shine.addColorStop(0.48, `rgba(255,255,255,${gleam * 0.8})`);
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = shine;
    ctx.lineWidth = strokes.glint;
    ctx.beginPath(); ctx.moveTo(-span * 0.5, -height * 0.05);
    ctx.quadraticCurveTo(-span * 0.22, -height * (0.8 + agitation * 0.25), span * 0.05, -height * 0.45);
    ctx.quadraticCurveTo(span * 0.3, height * 0.1, span * 0.5, 0); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

export const EFFECTS: EffectDef[] = [
  {
    // Keep the old ID so water overlays already saved in projects become lakes.
    id: 'gentle-water-waves', name: 'Rain Ripples', family: 'natural', bounded: true,
    waterDistortion: 'lake', waterShape: true, defaultLoop: 12, blend: 'source-over',
    description: 'Dense expanding raindrop ripples on the water. Drag the eight round points to fit the lake; combine with rain for a rainy scene.',
    params: [
      R('strength', 'Ripple strength', 0, 1, 0.01, 0.42, '', 'Lower for calmer water; zero hides the effect.'),
      R('density', 'Ripple density', 3, 30, 1, 9, '', 'Increase for heavier rain.'),
      R('length', 'Ripple size', 0.4, 2, 0.05, 1, 'x'),
      R('rate', 'Ripple speed', 1, 4, 1, 2, ' cycles'),
      C('color', 'Highlight colour', '#d9edf0'),
    ],
    draw(ctx, d) {
      const strength = clamp(num(d.params, 'strength', 0.42), 0, 1);
      if (strength <= 0) return;
      const points = readWaterShape(d.params.waterShape);
      const count = rainRippleCount(num(d.params, 'density', 9));
      const length = clamp(num(d.params, 'length', 1), 0.4, 2);
      const rate = Math.round(clamp(num(d.params, 'rate', 2), 1, 4));
      const color = str(d.params, 'color', '#d9edf0');
      ctx.save();
      traceWaterShape(ctx, points, d.w, d.h);
      ctx.clip('evenodd');
      for (let i = 0; i < count; i++) {
        const p = frac(d.u * rate + pr(d.seed, i, 901));
        const life = Math.sin(Math.PI * p);
        const x = d.w * (0.04 + pr(d.seed, i, 907) * 0.92);
        const y = d.h * (0.04 + pr(d.seed, i, 911) * 0.92);
        const alpha = strength * life * waterShapeFeather(x, y, d.w, d.h, points);
        if (alpha < 0.005) continue;
        const rx = d.w * (0.004 + p * 0.032) * length;
        const ry = d.h * (0.003 + p * 0.022) * length;
        ctx.strokeStyle = withAlpha(color, alpha * 0.72);
        ctx.lineWidth = Math.max(0.8 / Math.max(d.scale, 0.1), d.h * 0.009);
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
        ctx.stroke();
        if (p < 0.28) {
          // A brief bright impact, followed by a second, smaller expanding ring.
          ctx.fillStyle = withAlpha(color, strength * (1 - p / 0.28) * 0.75 * waterShapeFeather(x, y, d.w, d.h, points));
          ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.8 / d.scale, d.w * 0.0025), Math.max(0.6 / d.scale, d.h * 0.004), 0, 0, TAU); ctx.fill();
        }
        if (p > 0.22) {
          ctx.strokeStyle = withAlpha(color, alpha * 0.42);
          ctx.beginPath(); ctx.ellipse(x, y, rx * 0.62, ry * 0.62, 0, 0, TAU); ctx.stroke();
        }
      }
      ctx.restore();
    },
  },
  {
    id: 'lake-water-waves', name: 'Lake Waves', family: 'natural', bounded: true,
    waterDistortion: 'lake-waves', waterShape: true, defaultLoop: 12, blend: 'source-over',
    description: 'Small lake waves sway sideways with a gentle rise and fall, without raindrop rings. Drag the eight round points to fit the water.',
    params: [
      R('strength', 'Wave strength', 0, 1, 0.01, 0.55, '', 'Lower for calmer water; zero hides the effect.'),
      R('density', 'Wave count', 12, 96, 1, 56),
      R('length', 'Wave length', 0.4, 2, 0.05, 1, 'x'),
      R('rate', 'Wave speed', 1, 4, 1, 2, ' cycles'),
      C('color', 'Highlight colour', '#d9edf0'),
    ],
    draw(ctx, d) { drawChoppySurface(ctx, d, false); },
  },
  {
    id: 'river-water-flow', name: 'River Flow', family: 'natural', bounded: true,
    waterDistortion: 'river', waterShape: true, defaultLoop: 12, blend: 'source-over',
    description: 'Side-swaying waves travel along the river in a chosen direction. Drag the eight round points to fit the river; rotate the area to follow its course.',
    params: [
      R('strength', 'Flow strength', 0, 1, 0.01, 0.60, '', 'Lower for gentler flow; zero hides the effect.'),
      R('density', 'Wave count', 4, 100, 1, 52),
      R('length', 'Wave length', 0.4, 2, 0.05, 1, 'x'),
      R('rate', 'Flow speed', 1, 4, 1, 2, ' cycles'),
      S('direction', 'Flow direction', 'right', [['right', 'Right'], ['left', 'Left'], ['down', 'Down'], ['up', 'Up']]),
      C('color', 'Highlight colour', '#d9edf0'),
    ],
    draw(ctx, d) { drawChoppySurface(ctx, d, true); },
  },

  {
    id: 'fairy-dust', name: 'Fairy Dust', family: 'magical', defaultLoop: 10, blend: 'lighter',
    description: 'Glowing motes that blow sideways, rise, scatter and vanish.',
    params: [
      DENSITY, R('size', 'Mote size', 0.2, 4, 0.05, 1, 'x'), GLOW,
      R('direction', 'Wind direction', 0, 360, 1, 20, 'deg'),
      R('travel', 'Travel distance', 0.05, 1.5, 0.01, 0.45, ' of area'),
      R('rise', 'Lift', -0.6, 0.6, 0.01, 0.18),
      R('turbulence', 'Scatter', 0, 1, 0.01, 0.45),
      R('twinkle', 'Twinkle rate', 1, 12, 1, 5, ' cycles'),
      C('color', 'Colour', '#ffe6a8'), C('color2', 'Secondary colour', '#9fe8ff'),
      T('trails', 'Motion trails', true),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 90));
      const size = num(d.params, 'size', 1) * Math.min(d.w, d.h) * 0.006;
      const glow = num(d.params, 'glow', 1.2);
      const dir = rad(num(d.params, 'direction', 20));
      const travel = num(d.params, 'travel', 0.45);
      const rise = num(d.params, 'rise', 0.18);
      const turb = num(d.params, 'turbulence', 0.45);
      const tw = Math.round(num(d.params, 'twinkle', 5));
      const c1 = str(d.params, 'color', '#ffe6a8');
      const c2 = str(d.params, 'color2', '#9fe8ff');
      const trails = bool(d.params, 'trails', true);
      for (let i = 0; i < n; i++) {
        const ox = pr(d.seed, i, 1), oy = pr(d.seed, i, 2);
        const p = life(d.u, ox);
        const a = envelope(p, 0.22, 0.3);
        if (a <= 0.004) continue;
        const wob = Math.sin(TAU * (d.u * 2 + pr(d.seed, i, 3))) * turb;
        const dist = travel * (0.55 + 0.9 * pr(d.seed, i, 4));
        const x = (ox + Math.cos(dir) * dist * p + wob * 0.05) * d.w;
        const y = (oy + Math.sin(dir) * dist * p * 0.4 - rise * p + wob * 0.03) * d.h;
        const twinkle = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(TAU * (d.u * tw + pr(d.seed, i, 5))));
        const alpha = a * twinkle;
        const col = pr(d.seed, i, 6) > 0.62 ? c2 : c1;
        const r = size * (0.5 + pr(d.seed, i, 7));
        if (trails) {
          const tx = x - Math.cos(dir) * r * 7, ty = y - Math.sin(dir) * r * 3 + rise * r * 5;
          const g = ctx.createLinearGradient(tx, ty, x, y);
          g.addColorStop(0, withAlpha(col, 0));
          g.addColorStop(1, withAlpha(col, alpha * 0.32));
          ctx.strokeStyle = g; ctx.lineWidth = r * 0.9; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        }
        glowDot(ctx, x, y, r * 4.5 * glow, col, alpha * 0.5);
        coreDot(ctx, x, y, r * 0.75, '#ffffff', alpha * 0.9);
      }
    },
  },

  {
    id: 'sparkles', name: 'Sparkles & Glitter', family: 'magical', defaultLoop: 6, blend: 'lighter',
    description: 'Four-point flashes that glitter in place.',
    params: [
      R('density', 'Count', 4, 300, 1, 70), R('size', 'Size', 0.2, 5, 0.05, 1.4, 'x'), GLOW,
      R('frequency', 'Flash rate', 1, 10, 1, 3, ' per cycle'),
      R('sharpness', 'Duty cycle', 0.05, 0.9, 0.01, 0.3),
      C('color', 'Colour', '#ffffff'), C('color2', 'Tint', '#cfe6ff'),
      S('distribution', 'Distribution', 'uniform', [['uniform', 'Even'], ['top', 'Upper area'], ['bottom', 'Lower area'], ['center', 'Centre cluster']]),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 70));
      const base = num(d.params, 'size', 1.4) * Math.min(d.w, d.h) * 0.008;
      const glow = num(d.params, 'glow', 1.2);
      const freq = Math.round(num(d.params, 'frequency', 3));
      const sharp = num(d.params, 'sharpness', 0.3);
      const c1 = str(d.params, 'color', '#ffffff');
      const c2 = str(d.params, 'color2', '#cfe6ff');
      const dist = str(d.params, 'distribution', 'uniform');
      for (let i = 0; i < n; i++) {
        let x = pr(d.seed, i, 1), y = pr(d.seed, i, 2);
        if (dist === 'top') y *= 0.5;
        if (dist === 'bottom') y = 0.5 + y * 0.5;
        if (dist === 'center') { x = 0.5 + (x - 0.5) * 0.5; y = 0.5 + (y - 0.5) * 0.5; }
        const phase = pr(d.seed, i, 3);
        const wave = 0.5 + 0.5 * Math.sin(TAU * (d.u * freq + phase));
        const a = Math.pow(wave, 1 / Math.max(0.05, sharp));
        if (a < 0.01) continue;
        const r = base * (0.45 + pr(d.seed, i, 4));
        const col = pr(d.seed, i, 5) > 0.7 ? c2 : c1;
        glowDot(ctx, x * d.w, y * d.h, r * 3.4 * glow, col, a * 0.42);
        sparkleStar(ctx, x * d.w, y * d.h, r * (0.7 + a * 0.8), col, a);
      }
    },
  },

  {
    id: 'fireflies', name: 'Fireflies', family: 'natural', defaultLoop: 12, blend: 'lighter',
    description: 'Warm insects wandering on independent curved paths, blinking softly.',
    params: [
      R('density', 'Count', 1, 120, 1, 26), R('size', 'Size', 0.2, 4, 0.05, 1, 'x'), GLOW,
      R('wander', 'Movement distance', 0.01, 0.5, 0.01, 0.14),
      R('blink', 'Blink rate', 1, 8, 1, 2, ' per cycle'),
      R('pause', 'Resting time', 0, 0.8, 0.01, 0.35),
      C('color', 'Colour', '#ffd76a'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 26));
      const base = num(d.params, 'size', 1) * Math.min(d.w, d.h) * 0.005;
      const glow = num(d.params, 'glow', 1.2);
      const wander = num(d.params, 'wander', 0.14);
      const blink = Math.round(num(d.params, 'blink', 2));
      const pause = num(d.params, 'pause', 0.35);
      const col = str(d.params, 'color', '#ffd76a');
      for (let i = 0; i < n; i++) {
        const ox = pr(d.seed, i, 1), oy = 0.35 + pr(d.seed, i, 2) * 0.62;
        const kx = 1 + Math.round(pr(d.seed, i, 3) * 2);
        const ky = 1 + Math.round(pr(d.seed, i, 4) * 2);
        const ph = pr(d.seed, i, 5) * TAU;
        const x = (ox + Math.sin(TAU * d.u * kx + ph) * wander * (0.4 + pr(d.seed, i, 6))) * d.w;
        const y = (oy + Math.sin(TAU * d.u * ky + ph * 1.7) * wander * 0.55) * d.h;
        let b = 0.5 + 0.5 * Math.sin(TAU * (d.u * blink + pr(d.seed, i, 7)));
        b = clamp((b - pause) / (1 - pause), 0, 1) ** 1.6;
        if (b < 0.01) continue;
        const r = base * (0.6 + pr(d.seed, i, 8) * 0.8);
        glowDot(ctx, x, y, r * 6 * glow, col, b * 0.5);
        coreDot(ctx, x, y, r, '#fff6d0', b);
      }
    },
  },

  {
    id: 'glowing-orbs', name: 'Glowing Orbs', family: 'magical', defaultLoop: 16, blend: 'lighter',
    description: 'Soft spheres of light drifting along closed curved paths.',
    params: [
      R('density', 'Count', 1, 40, 1, 7), R('size', 'Orb size', 0.2, 5, 0.05, 1.6, 'x'),
      R('glow', 'Glow', 0.2, 4, 0.05, 2, 'x'),
      R('travel', 'Path size', 0.02, 0.6, 0.01, 0.18),
      R('pulse', 'Brightness pulse', 0, 1, 0.01, 0.35),
      C('color', 'Colour', '#8fd8ff'), C('color2', 'Second colour', '#d7b3ff'),
      T('core', 'Bright core', true),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 7));
      const base = num(d.params, 'size', 1.6) * Math.min(d.w, d.h) * 0.012;
      const glow = num(d.params, 'glow', 2);
      const travel = num(d.params, 'travel', 0.18);
      const pulse = num(d.params, 'pulse', 0.35);
      const c1 = str(d.params, 'color', '#8fd8ff');
      const c2 = str(d.params, 'color2', '#d7b3ff');
      const core = bool(d.params, 'core', true);
      for (let i = 0; i < n; i++) {
        const ox = 0.1 + pr(d.seed, i, 1) * 0.8, oy = 0.15 + pr(d.seed, i, 2) * 0.7;
        const kx = 1 + Math.round(pr(d.seed, i, 3));
        const ky = 1 + Math.round(pr(d.seed, i, 4));
        const ph = pr(d.seed, i, 5) * TAU;
        const x = (ox + Math.sin(TAU * d.u * kx + ph) * travel) * d.w;
        const y = (oy + Math.cos(TAU * d.u * ky + ph) * travel * 0.7) * d.h;
        const b = 1 - pulse * (0.5 + 0.5 * Math.sin(TAU * (d.u * 2 + pr(d.seed, i, 6))));
        const r = base * (0.55 + pr(d.seed, i, 7) * 0.9);
        const col = pr(d.seed, i, 8) > 0.5 ? c1 : c2;
        glowDot(ctx, x, y, r * 3.2 * glow, col, 0.42 * b);
        glowDot(ctx, x, y, r * 1.25, col, 0.75 * b);
        if (core) coreDot(ctx, x, y, r * 0.34, '#ffffff', 0.85 * b);
      }
    },
  },

  {
    id: 'magic-circle', name: 'Magic Circle', family: 'symbols', defaultLoop: 12, blend: 'lighter',
    description: 'Concentric rotating rings, tick marks and rune-inspired glyphs.',
    params: [
      R('size', 'Radius', 0.05, 1.2, 0.01, 0.34, ' of area'),
      R('cx', 'Centre X', 0, 1, 0.01, 0.5), R('cy', 'Centre Y', 0, 1, 0.01, 0.5),
      R('rotations', 'Rotations per cycle', -4, 4, 1, 1),
      R('rings', 'Ring count', 1, 6, 1, 3),
      R('glyphs', 'Glyph count', 0, 24, 1, 12),
      R('glow', 'Glow', 0, 3, 0.05, 1.4, 'x'),
      R('pulse', 'Pulse', 0, 1, 0.01, 0.3),
      R('thickness', 'Line weight', 0.3, 4, 0.1, 1.2, 'x'),
      C('color', 'Colour', '#9fd8ff'),
      T('counter', 'Counter-rotate inner ring', true),
      T('ticks', 'Tick marks', true),
    ],
    draw(ctx, d) {
      const R0 = num(d.params, 'size', 0.34) * Math.min(d.w, d.h) * 0.5;
      const cx = num(d.params, 'cx', 0.5) * d.w, cy = num(d.params, 'cy', 0.5) * d.h;
      const rot = TAU * frac(Math.round(num(d.params, 'rotations', 1)) * d.u);
      const rings = Math.round(num(d.params, 'rings', 3));
      const glyphs = Math.round(num(d.params, 'glyphs', 12));
      const glow = num(d.params, 'glow', 1.4);
      const pulse = 1 - num(d.params, 'pulse', 0.3) * (0.5 + 0.5 * Math.sin(TAU * d.u * 2));
      const lw = num(d.params, 'thickness', 1.2) * Math.min(d.w, d.h) * 0.0022;
      const col = str(d.params, 'color', '#9fd8ff');
      const counter = bool(d.params, 'counter', true);
      const ticks = bool(d.params, 'ticks', true);
      ctx.save();
      ctx.translate(cx, cy);
      glowDot(ctx, 0, 0, R0 * 1.5 * glow, col, 0.14 * pulse);
      for (let r = 0; r < rings; r++) {
        const rr = R0 * (1 - r * 0.17);
        const dirSign = counter && r % 2 === 1 ? -1 : 1;
        ctx.save();
        ctx.rotate(rot * dirSign * (1 + r));
        ctx.strokeStyle = withAlpha(col, 0.75 * pulse);
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.stroke();
        ctx.strokeStyle = withAlpha(col, 0.28 * pulse);
        ctx.lineWidth = lw * 3.2;
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.stroke();
        if (ticks && r === 0) {
          for (let t = 0; t < 48; t++) {
            const a = (t / 48) * TAU;
            const len = t % 4 === 0 ? rr * 0.09 : rr * 0.045;
            ctx.strokeStyle = withAlpha(col, 0.6 * pulse);
            ctx.lineWidth = lw * 0.9;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
            ctx.lineTo(Math.cos(a) * (rr - len), Math.sin(a) * (rr - len));
            ctx.stroke();
          }
        }
        if (r === 1 && glyphs > 0) {
          for (let g = 0; g < glyphs; g++) {
            const a = (g / glyphs) * TAU;
            runeGlyph(ctx, Math.cos(a) * rr * 0.9, Math.sin(a) * rr * 0.9,
              R0 * 0.055, a + Math.PI / 2, g, col, 0.85 * pulse, lw);
          }
        }
        if (r === rings - 1 && rings >= 2) {
          const sides = 6;
          ctx.strokeStyle = withAlpha(col, 0.5 * pulse);
          ctx.lineWidth = lw * 0.8;
          ctx.beginPath();
          for (let s = 0; s <= sides; s++) {
            const a = (s / sides) * TAU;
            const px = Math.cos(a) * rr * 0.92, py = Math.sin(a) * rr * 0.92;
            if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    },
  },

  {
    id: 'mandala', name: 'Ornamental Mandala', family: 'symbols', defaultLoop: 20, blend: 'lighter',
    description: 'Layered geometric ornament that slowly turns and breathes.',
    params: [
      R('size', 'Radius', 0.05, 1.2, 0.01, 0.3),
      R('cx', 'Centre X', 0, 1, 0.01, 0.5), R('cy', 'Centre Y', 0, 1, 0.01, 0.5),
      R('petals', 'Symmetry', 3, 24, 1, 12),
      R('layers', 'Layers', 1, 5, 1, 3),
      R('rotations', 'Rotations per cycle', -3, 3, 1, 1),
      R('glow', 'Glow', 0, 3, 0.05, 1.1, 'x'),
      R('pulse', 'Breathe', 0, 0.6, 0.01, 0.18),
      C('color', 'Colour', '#ffd9a0'), C('color2', 'Accent', '#ffb3d9'),
    ],
    draw(ctx, d) {
      const petals = Math.round(num(d.params, 'petals', 12));
      const layers = Math.round(num(d.params, 'layers', 3));
      const rot = TAU * frac(Math.round(num(d.params, 'rotations', 1)) * d.u);
      const breathe = 1 + num(d.params, 'pulse', 0.18) * Math.sin(TAU * d.u);
      const R0 = num(d.params, 'size', 0.3) * Math.min(d.w, d.h) * 0.5 * breathe;
      const col = str(d.params, 'color', '#ffd9a0');
      const col2 = str(d.params, 'color2', '#ffb3d9');
      const glow = num(d.params, 'glow', 1.1);
      const lw = Math.min(d.w, d.h) * 0.0022;
      ctx.save();
      ctx.translate(num(d.params, 'cx', 0.5) * d.w, num(d.params, 'cy', 0.5) * d.h);
      glowDot(ctx, 0, 0, R0 * 1.4 * glow, col, 0.12);
      for (let l = 0; l < layers; l++) {
        const rr = R0 * (1 - l * 0.22);
        ctx.save();
        ctx.rotate(rot * (l % 2 === 0 ? 1 : -1) + l * 0.2);
        ctx.strokeStyle = withAlpha(l % 2 ? col2 : col, 0.6);
        ctx.lineWidth = lw;
        for (let p = 0; p < petals; p++) {
          const a = (p / petals) * TAU;
          ctx.save(); ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.bezierCurveTo(rr * 0.4, -rr * 0.3, rr * 0.85, -rr * 0.16, rr, 0);
          ctx.bezierCurveTo(rr * 0.85, rr * 0.16, rr * 0.4, rr * 0.3, 0, 0);
          ctx.stroke();
          ctx.restore();
        }
        ctx.beginPath(); ctx.arc(0, 0, rr * 0.42, 0, TAU); ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    },
  },

  {
    id: 'floating-runes', name: 'Floating Runes', family: 'symbols', defaultLoop: 14, blend: 'lighter',
    description: 'Rune-inspired markings that drift, twirl, pulse and fade.',
    params: [
      R('density', 'Count', 1, 60, 1, 12), R('size', 'Size', 0.2, 4, 0.05, 1.2, 'x'),
      R('glow', 'Glow', 0, 3, 0.05, 1.3, 'x'),
      R('rise', 'Rise distance', -0.5, 0.5, 0.01, 0.16),
      R('drift', 'Sideways drift', -0.5, 0.5, 0.01, 0.06),
      R('spin', 'Twirl', -3, 3, 1, 1, ' turns'),
      R('pulse', 'Pulse', 0, 1, 0.01, 0.4),
      C('color', 'Colour', '#a8e6ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 12));
      const base = num(d.params, 'size', 1.2) * Math.min(d.w, d.h) * 0.018;
      const glow = num(d.params, 'glow', 1.3);
      const rise = num(d.params, 'rise', 0.16);
      const drift = num(d.params, 'drift', 0.06);
      const spin = Math.round(num(d.params, 'spin', 1));
      const pulse = num(d.params, 'pulse', 0.4);
      const col = str(d.params, 'color', '#a8e6ff');
      for (let i = 0; i < n; i++) {
        const ox = pr(d.seed, i, 1), oy = pr(d.seed, i, 2);
        const p = life(d.u, pr(d.seed, i, 3));
        const a = envelope(p, 0.25, 0.3);
        if (a < 0.01) continue;
        const x = (ox + drift * p) * d.w;
        const y = (oy - rise * p) * d.h;
        const rot = TAU * frac(spin * d.u) + pr(d.seed, i, 4) * TAU;
        const b = a * (1 - pulse * (0.5 + 0.5 * Math.sin(TAU * (d.u * 3 + pr(d.seed, i, 5)))));
        const s = base * (0.6 + pr(d.seed, i, 6) * 0.8);
        glowDot(ctx, x, y, s * 2.6 * glow, col, b * 0.3);
        runeGlyph(ctx, x, y, s, rot, i, col, b * 0.95, Math.max(1, s * 0.12));
      }
    },
  },

  {
    id: 'constellation', name: 'Constellation', family: 'celestial', defaultLoop: 18, blend: 'lighter',
    description: 'A connected star pattern that fades in, glows and turns slowly.',
    params: [
      R('stars', 'Star count', 4, 20, 1, 9),
      R('size', 'Star size', 0.2, 4, 0.05, 1.2, 'x'),
      R('spread', 'Spread', 0.1, 1, 0.01, 0.6),
      R('cx', 'Centre X', 0, 1, 0.01, 0.5), R('cy', 'Centre Y', 0, 1, 0.01, 0.35),
      R('rotations', 'Rotations per cycle', -2, 2, 1, 0),
      R('lineOpacity', 'Line strength', 0, 1, 0.01, 0.35),
      R('twinkle', 'Twinkle', 0, 1, 0.01, 0.4),
      C('color', 'Colour', '#dbe9ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'stars', 9));
      const spread = num(d.params, 'spread', 0.6) * Math.min(d.w, d.h) * 0.5;
      const rot = TAU * frac(Math.round(num(d.params, 'rotations', 0)) * d.u);
      const lineA = num(d.params, 'lineOpacity', 0.35);
      const tw = num(d.params, 'twinkle', 0.4);
      const base = num(d.params, 'size', 1.2) * Math.min(d.w, d.h) * 0.006;
      const col = str(d.params, 'color', '#dbe9ff');
      const pts: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = pr(d.seed, i, 1) * TAU;
        const r = (0.25 + pr(d.seed, i, 2) * 0.75) * spread;
        const x = Math.cos(a + rot) * r, y = Math.sin(a + rot) * r * 0.72;
        const b = 1 - tw * (0.5 + 0.5 * Math.sin(TAU * (d.u * 3 + pr(d.seed, i, 3))));
        pts.push([x, y, b]);
      }
      ctx.save();
      ctx.translate(num(d.params, 'cx', 0.5) * d.w, num(d.params, 'cy', 0.35) * d.h);
      ctx.strokeStyle = withAlpha(col, lineA);
      ctx.lineWidth = Math.max(0.6, base * 0.28);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      for (const [x, y, b] of pts) {
        glowDot(ctx, x, y, base * 5, col, 0.4 * b);
        sparkleStar(ctx, x, y, base * 1.5, col, b);
      }
      ctx.restore();
    },
  },

  {
    id: 'starfield', name: 'Twinkling Stars', family: 'celestial', defaultLoop: 10, blend: 'lighter',
    description: 'A field of stars with independent brightness patterns.',
    params: [
      R('density', 'Star count', 10, 600, 1, 180),
      R('size', 'Size', 0.2, 4, 0.05, 1, 'x'), GLOW,
      R('twinkle', 'Twinkle amount', 0, 1, 0.01, 0.6),
      R('rate', 'Twinkle rate', 1, 8, 1, 2, ' per cycle'),
      R('horizon', 'Vertical limit', 0.1, 1, 0.01, 0.6, ' of height'),
      C('color', 'Colour', '#ffffff'), C('color2', 'Warm stars', '#ffe2b8'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 180));
      const base = num(d.params, 'size', 1) * Math.min(d.w, d.h) * 0.0026;
      const glow = num(d.params, 'glow', 1.2);
      const tw = num(d.params, 'twinkle', 0.6);
      const rate = Math.round(num(d.params, 'rate', 2));
      const horizon = num(d.params, 'horizon', 0.6);
      const c1 = str(d.params, 'color', '#ffffff');
      const c2 = str(d.params, 'color2', '#ffe2b8');
      for (let i = 0; i < n; i++) {
        const x = pr(d.seed, i, 1) * d.w;
        const y = pr(d.seed, i, 2) ** 1.3 * horizon * d.h;
        const b = (1 - tw) + tw * (0.5 + 0.5 * Math.sin(TAU * (d.u * rate + pr(d.seed, i, 3))));
        const r = base * (0.4 + pr(d.seed, i, 4) ** 2 * 1.8);
        const col = pr(d.seed, i, 5) > 0.82 ? c2 : c1;
        if (r > base * 1.2) glowDot(ctx, x, y, r * 5 * glow, col, b * 0.35);
        coreDot(ctx, x, y, r, col, b);
      }
    },
  },

  {
    id: 'shooting-stars', name: 'Shooting Stars', family: 'celestial', defaultLoop: 12, blend: 'lighter',
    description: 'Occasional meteors streaking across the sky and fading out.',
    params: [
      R('density', 'Meteors per cycle', 1, 12, 1, 3),
      R('length', 'Trail length', 0.05, 0.8, 0.01, 0.28),
      R('angle', 'Angle', 0, 360, 1, 150, 'deg'),
      R('speed', 'Crossing fraction', 0.1, 1, 0.01, 0.5),
      R('thickness', 'Thickness', 0.3, 4, 0.1, 1.2, 'x'),
      C('color', 'Colour', '#ffffff'), C('color2', 'Trail tint', '#9fd0ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 3));
      const len = num(d.params, 'length', 0.28) * Math.hypot(d.w, d.h);
      const ang = rad(num(d.params, 'angle', 150));
      const cross = num(d.params, 'speed', 0.5);
      const lw = num(d.params, 'thickness', 1.2) * Math.min(d.w, d.h) * 0.0025;
      const c1 = str(d.params, 'color', '#ffffff');
      const c2 = str(d.params, 'color2', '#9fd0ff');
      for (let i = 0; i < n; i++) {
        const p = life(d.u, pr(d.seed, i, 1));
        const a = envelope(p, 0.12, 0.45);
        if (a < 0.01) continue;
        const sx = pr(d.seed, i, 2) * d.w;
        const sy = pr(d.seed, i, 3) * d.h * 0.5;
        const dist = cross * Math.hypot(d.w, d.h) * p;
        const x = sx + Math.cos(ang) * dist, y = sy + Math.sin(ang) * dist;
        const tx = x - Math.cos(ang) * len, ty = y - Math.sin(ang) * len;
        const g = ctx.createLinearGradient(tx, ty, x, y);
        g.addColorStop(0, withAlpha(c2, 0));
        g.addColorStop(0.75, withAlpha(c2, a * 0.5));
        g.addColorStop(1, withAlpha(c1, a));
        ctx.strokeStyle = g; ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        glowDot(ctx, x, y, lw * 7, c1, a * 0.7);
      }
    },
  },

  {
    id: 'aurora', name: 'Northern Lights', family: 'celestial', defaultLoop: 24, blend: 'lighter',
    description: 'Slow ribbons of coloured light rippling across the sky.',
    params: [
      R('ribbons', 'Ribbon count', 1, 8, 1, 3),
      R('height', 'Curtain height', 0.1, 1.2, 0.01, 0.55),
      R('width', 'Ribbon width', 0.02, 0.4, 0.01, 0.12),
      R('wave', 'Wave amount', 0, 0.4, 0.01, 0.12),
      R('intensity', 'Intensity', 0.05, 1, 0.01, 0.45),
      R('speed', 'Ripples per cycle', 1, 5, 1, 1),
      C('color', 'Primary', '#5cffc0'), C('color2', 'Secondary', '#6aa8ff'),
      C('color3', 'Fringe', '#c47dff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'ribbons', 3));
      const hgt = num(d.params, 'height', 0.55) * d.h;
      const wid = num(d.params, 'width', 0.12) * d.w;
      const wave = num(d.params, 'wave', 0.12) * d.w;
      const inten = num(d.params, 'intensity', 0.45);
      const speed = Math.round(num(d.params, 'speed', 1));
      const cols = [str(d.params, 'color', '#5cffc0'), str(d.params, 'color2', '#6aa8ff'), str(d.params, 'color3', '#c47dff')];
      for (let i = 0; i < n; i++) {
        const baseX = (0.18 + pr(d.seed, i, 1) * 0.64) * d.w;
        const ph = pr(d.seed, i, 2) * TAU;
        const col = cols[i % cols.length];
        for (let pass = 0; pass < 3; pass++) {
          const scale = [1.9, 1.15, 0.55][pass];
          const alpha = inten * [0.16, 0.26, 0.4][pass];
          ctx.beginPath();
          for (let s = 0; s <= 26; s++) {
            const v = s / 26;
            const x = baseX + Math.sin(v * 3.1 + TAU * d.u * speed + ph) * wave
              + Math.sin(v * 7.3 - TAU * d.u * speed * 2 + ph) * wave * 0.3;
            const y = v * hgt;
            if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          const g = ctx.createLinearGradient(0, 0, 0, hgt);
          g.addColorStop(0, withAlpha(col, 0));
          g.addColorStop(0.25, withAlpha(col, alpha));
          g.addColorStop(0.75, withAlpha(col, alpha * 0.6));
          g.addColorStop(1, withAlpha(col, 0));
          ctx.strokeStyle = g;
          ctx.lineWidth = wid * scale;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }
    },
  },

  {
    id: 'light-beams', name: 'Light Beams', family: 'magical', defaultLoop: 16, blend: 'lighter',
    description: 'Volumetric shafts of light with gentle intensity movement.',
    params: [
      R('beams', 'Beam count', 1, 14, 1, 5),
      R('angle', 'Angle', 0, 360, 1, 110, 'deg'),
      R('width', 'Beam width', 0.01, 0.3, 0.005, 0.06),
      R('length', 'Length', 0.2, 2, 0.01, 1.3),
      R('intensity', 'Intensity', 0.02, 1, 0.01, 0.3),
      R('flicker', 'Flicker', 0, 1, 0.01, 0.3),
      R('originX', 'Source X', -0.5, 1.5, 0.01, 0.25),
      R('originY', 'Source Y', -0.5, 1.5, 0.01, -0.1),
      C('color', 'Colour', '#ffe9bd'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'beams', 5));
      const ang = rad(num(d.params, 'angle', 110));
      const wid = num(d.params, 'width', 0.06) * Math.min(d.w, d.h);
      const len = num(d.params, 'length', 1.3) * Math.hypot(d.w, d.h);
      const inten = num(d.params, 'intensity', 0.3);
      const flick = num(d.params, 'flicker', 0.3);
      const ox = num(d.params, 'originX', 0.25) * d.w;
      const oy = num(d.params, 'originY', -0.1) * d.h;
      const col = str(d.params, 'color', '#ffe9bd');
      for (let i = 0; i < n; i++) {
        const spread = (pr(d.seed, i, 1) - 0.5) * 0.5;
        const a = ang + spread;
        const b = inten * (1 - flick * (0.5 + 0.5 * Math.sin(TAU * (d.u * 2 + pr(d.seed, i, 2)))));
        const w = wid * (0.5 + pr(d.seed, i, 3));
        const ex = ox + Math.cos(a) * len, ey = oy + Math.sin(a) * len;
        const nx = -Math.sin(a) * w, ny = Math.cos(a) * w;
        const g = ctx.createLinearGradient(ox, oy, ex, ey);
        g.addColorStop(0, withAlpha(col, b * 0.85));
        g.addColorStop(0.5, withAlpha(col, b * 0.35));
        g.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(ox - nx * 0.25, oy - ny * 0.25);
        ctx.lineTo(ox + nx * 0.25, oy + ny * 0.25);
        ctx.lineTo(ex + nx * 2.2, ey + ny * 2.2);
        ctx.lineTo(ex - nx * 2.2, ey - ny * 2.2);
        ctx.closePath();
        ctx.fill();
      }
    },
  },

  {
    id: 'mist', name: 'Drifting Mist', family: 'weather', defaultLoop: 30, blend: 'lighter',
    description: 'Soft banks of fog drifting across the environment.',
    params: [
      R('density', 'Bank count', 2, 40, 1, 12),
      R('size', 'Bank size', 0.1, 1.2, 0.01, 0.45),
      R('opacity', 'Thickness', 0.02, 0.6, 0.01, 0.16),
      R('direction', 'Drift direction', 0, 360, 1, 0, 'deg'),
      R('travel', 'Drift distance', 0.05, 1.5, 0.01, 0.5),
      R('band', 'Vertical centre', 0, 1, 0.01, 0.72),
      R('spreadY', 'Vertical spread', 0, 0.6, 0.01, 0.16),
      C('color', 'Colour', '#cfe0ef'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 12));
      const size = num(d.params, 'size', 0.45) * Math.min(d.w, d.h);
      const alpha = num(d.params, 'opacity', 0.16);
      const dir = rad(num(d.params, 'direction', 0));
      const travel = num(d.params, 'travel', 0.5);
      const band = num(d.params, 'band', 0.72);
      const spreadY = num(d.params, 'spreadY', 0.16);
      const col = str(d.params, 'color', '#cfe0ef');
      for (let i = 0; i < n; i++) {
        const p = life(d.u, pr(d.seed, i, 1));
        const a = envelope(p, 0.3, 0.3) * alpha;
        if (a < 0.004) continue;
        const ox = pr(d.seed, i, 2), oy = band + (pr(d.seed, i, 3) - 0.5) * spreadY * 2;
        const x = (ox + Math.cos(dir) * travel * (p - 0.5)) * d.w;
        const y = (oy + Math.sin(dir) * travel * (p - 0.5) * 0.3) * d.h;
        const r = size * (0.6 + pr(d.seed, i, 4) * 0.9);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1.9, 0.55);
        glowDot(ctx, 0, 0, r, col, a);
        ctx.restore();
      }
    },
  },

  {
    id: 'rising-mist', name: 'Waterfall Mist & Spray', family: 'weather', defaultLoop: 12, blend: 'source-over',
    description: 'Billowing vapor plumes and fine spray rising upward and drifting outward from turbulent water.',
    params: [
      R('density', 'Plume count', 4, 60, 1, 24),
      R('spray', 'Spray droplets', 0, 160, 1, 55),
      R('size', 'Plume size', 0.05, 0.8, 0.01, 0.24),
      R('rise', 'Rise height', 0.1, 0.9, 0.01, 0.46),
      R('spread', 'Lateral billow', 0.02, 0.8, 0.01, 0.34),
      R('baseY', 'Source height', 0.2, 1, 0.01, 0.78),
      R('opacity', 'Thickness', 0.05, 0.8, 0.01, 0.32),
      C('color', 'Mist colour', '#e8f6ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 24));
      const spray = Math.round(num(d.params, 'spray', 55));
      const baseSize = num(d.params, 'size', 0.24) * Math.min(d.w, d.h);
      const rise = num(d.params, 'rise', 0.46);
      const spread = num(d.params, 'spread', 0.34);
      const baseY = num(d.params, 'baseY', 0.78);
      const alpha = num(d.params, 'opacity', 0.32);
      const col = str(d.params, 'color', '#e8f6ff');

      for (let i = 0; i < n; i++) {
        const cycles = i % 3 === 0 ? 2 : 1;
        const p = life(d.u, pr(d.seed, i, 1), cycles);
        const a = envelope(p, 0.22, 0.38) * alpha;
        if (a < 0.004) continue;
        const ox = 0.22 + pr(d.seed, i, 2) * 0.56;
        const oy = baseY + (pr(d.seed, i, 3) - 0.5) * 0.08;
        const drift = ((ox - 0.5) * 1.1 + (pr(d.seed, i, 4) - 0.5) * 0.9) * spread;
        const swirl = Math.sin(TAU * (d.u * cycles + pr(d.seed, i, 5))) * 0.04;
        const x = (ox + drift * p + swirl * Math.sin(Math.PI * p)) * d.w;
        const y = (oy - rise * (0.65 + 0.6 * pr(d.seed, i, 6)) * p) * d.h;
        const r = baseSize * (0.55 + pr(d.seed, i, 7) * 0.6) * (0.7 + 1.15 * p);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1.65, 0.72);
        glowDot(ctx, 0, 0, r, col, a);
        ctx.restore();
      }

      for (let i = 0; i < spray; i++) {
        const p = life(d.u, pr(d.seed, i + 500, 1), 3);
        const a = envelope(p, 0.12, 0.35) * Math.min(1, alpha * 2.2);
        if (a < 0.01) continue;
        const ox = 0.25 + pr(d.seed, i + 500, 2) * 0.5;
        const vx = (pr(d.seed, i + 500, 3) - 0.5) * spread * 0.9;
        const vy = 0.14 + 0.18 * pr(d.seed, i + 500, 4);
        const g = vy * 2.35;
        const x = (ox + vx * p) * d.w;
        const y = (baseY - vy * p + 0.5 * g * p * p) * d.h;
        const r = Math.max(1.1, Math.min(d.w, d.h) * (0.0022 + 0.0028 * pr(d.seed, i + 500, 5)));
        coreDot(ctx, x, y, r, '#ffffff', a * 0.9);
      }
    },
  },

  {
    id: 'energy-rings', name: 'Energy Waves', family: 'magical', defaultLoop: 8, blend: 'lighter',
    description: 'Glowing rings expanding outward and dissolving.',
    params: [
      R('density', 'Rings per cycle', 1, 10, 1, 3),
      R('cx', 'Centre X', 0, 1, 0.01, 0.5), R('cy', 'Centre Y', 0, 1, 0.01, 0.6),
      R('maxRadius', 'Max radius', 0.05, 1.5, 0.01, 0.5),
      R('thickness', 'Thickness', 0.2, 5, 0.1, 1.4, 'x'),
      R('squash', 'Perspective squash', 0.1, 1, 0.01, 0.45),
      R('glow', 'Glow', 0, 3, 0.05, 1.5, 'x'),
      C('color', 'Colour', '#9fe0ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 3));
      const maxR = num(d.params, 'maxRadius', 0.5) * Math.min(d.w, d.h);
      const lw = num(d.params, 'thickness', 1.4) * Math.min(d.w, d.h) * 0.003;
      const squash = num(d.params, 'squash', 0.45);
      const glow = num(d.params, 'glow', 1.5);
      const col = str(d.params, 'color', '#9fe0ff');
      const cx = num(d.params, 'cx', 0.5) * d.w, cy = num(d.params, 'cy', 0.6) * d.h;
      for (let i = 0; i < n; i++) {
        const p = life(d.u, i / n);
        const a = envelope(p, 0.08, 0.6);
        if (a < 0.01) continue;
        const r = maxR * (0.08 + p * 0.92);
        ctx.save();
        ctx.translate(cx, cy); ctx.scale(1, squash);
        ctx.strokeStyle = withAlpha(col, a * 0.75);
        ctx.lineWidth = lw * (1 - p * 0.5);
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
        ctx.strokeStyle = withAlpha(col, a * 0.22 * glow);
        ctx.lineWidth = lw * 5 * (1 - p * 0.5);
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
        ctx.restore();
      }
    },
  },

  {
    id: 'butterflies', name: 'Butterflies', family: 'fantasy', defaultLoop: 16, blend: 'source-over',
    description: 'Sprites with flapping wings following independent flight paths.',
    params: [
      R('density', 'Count', 1, 40, 1, 6),
      R('size', 'Wing size', 0.2, 4, 0.05, 1.7, 'x'),
      R('travel', 'Flight range', 0.05, 0.8, 0.01, 0.3),
      R('flap', 'Wing beats per cycle', 4, 60, 1, 24),
      R('opacity', 'Opacity', 0.1, 1, 0.01, 0.95),
      C('color', 'Wing colour', '#f7c96b'), C('color2', 'Lower wing', '#e0793f'),
      T('glow', 'Faint glow', false),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 6));
      const base = num(d.params, 'size', 1.7) * Math.min(d.w, d.h) * 0.016;
      const travel = num(d.params, 'travel', 0.3);
      const flap = Math.round(num(d.params, 'flap', 24));
      const alpha = num(d.params, 'opacity', 0.95);
      const c1 = str(d.params, 'color', '#f7c96b');
      const c2 = str(d.params, 'color2', '#e0793f');
      const glow = bool(d.params, 'glow', false);
      for (let i = 0; i < n; i++) {
        const ox = 0.12 + pr(d.seed, i, 1) * 0.76, oy = 0.2 + pr(d.seed, i, 2) * 0.62;
        const kx = 1 + Math.round(pr(d.seed, i, 3) * 2);
        const ky = 1 + Math.round(pr(d.seed, i, 4) * 2);
        const ph = pr(d.seed, i, 5) * TAU;
        const fx = Math.sin(TAU * d.u * kx + ph), fy = Math.sin(TAU * d.u * ky + ph * 1.4);
        const x = (ox + fx * travel) * d.w;
        const y = (oy + fy * travel * 0.55) * d.h;
        const dx = Math.cos(TAU * d.u * kx + ph) * kx;
        const dy = Math.cos(TAU * d.u * ky + ph * 1.4) * ky * 0.55;
        const heading = Math.atan2(dy, dx) + Math.PI / 2;
        const s = base * (0.7 + pr(d.seed, i, 6) * 0.7);
        if (glow) glowDot(ctx, x, y, s * 3.4, c1, alpha * 0.25);
        butterflyShape(ctx, x, y, s, heading, TAU * d.u * flap + ph, c1, c2, alpha);
      }
    },
  },

  {
    id: 'falling-leaves', name: 'Falling Leaves', family: 'natural', defaultLoop: 14, blend: 'source-over',
    description: 'Leaves tumbling down with individual sway, spin and speed.',
    params: [
      R('density', 'Count', 1, 200, 1, 34),
      R('size', 'Leaf size', 0.2, 4, 0.05, 1, 'x'),
      R('sway', 'Sideways sway', 0, 0.4, 0.01, 0.1),
      R('spin', 'Tumble', 0, 6, 0.1, 2, ' turns'),
      R('direction', 'Wind push', -0.6, 0.6, 0.01, 0.12),
      R('speedSpread', 'Speed variation', 0, 1, 0.01, 0.5),
      R('opacity', 'Opacity', 0.1, 1, 0.01, 0.95),
      C('color', 'Colour', '#d99a3f'), C('color2', 'Second colour', '#b6552f'),
      C('color3', 'Third colour', '#8fae4a'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 34));
      const base = num(d.params, 'size', 1) * Math.min(d.w, d.h) * 0.011;
      const sway = num(d.params, 'sway', 0.1);
      const spin = num(d.params, 'spin', 2);
      const push = num(d.params, 'direction', 0.12);
      const spread = num(d.params, 'speedSpread', 0.5);
      const alpha = num(d.params, 'opacity', 0.95);
      const cols = [str(d.params, 'color', '#d99a3f'), str(d.params, 'color2', '#b6552f'), str(d.params, 'color3', '#8fae4a')];
      for (let i = 0; i < n; i++) {
        const cycles = 1 + Math.round(pr(d.seed, i, 1) * spread * 2);
        const p = life(d.u, pr(d.seed, i, 2), cycles);
        const ox = pr(d.seed, i, 3);
        const x = (ox + push * p + Math.sin(TAU * (p * 2 + pr(d.seed, i, 4))) * sway) * d.w;
        const y = (p * 1.25 - 0.12) * d.h;
        const rot = TAU * (p * spin + pr(d.seed, i, 5));
        const squash = 0.35 + 0.65 * Math.abs(Math.cos(TAU * (p * spin * 0.7 + pr(d.seed, i, 6))));
        const s = base * (0.6 + pr(d.seed, i, 7) * 0.8);
        leafShape(ctx, x, y, s, rot, cols[i % cols.length], alpha, squash);
      }
    },
  },

  {
    id: 'drifting-petals', name: 'Drifting Petals', family: 'fantasy', defaultLoop: 16, blend: 'source-over',
    description: 'Blossom petals carried on the breeze.',
    params: [
      R('density', 'Count', 1, 200, 1, 40),
      R('size', 'Petal size', 0.2, 4, 0.05, 0.9, 'x'),
      R('direction', 'Wind direction', 0, 360, 1, 25, 'deg'),
      R('travel', 'Travel', 0.2, 2, 0.01, 1.1),
      R('sway', 'Flutter', 0, 0.3, 0.01, 0.07),
      R('spin', 'Twirl', 0, 6, 0.1, 2.5),
      R('opacity', 'Opacity', 0.1, 1, 0.01, 0.9),
      C('color', 'Colour', '#ffd0e2'), C('color2', 'Second colour', '#fff2f7'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 40));
      const base = num(d.params, 'size', 0.9) * Math.min(d.w, d.h) * 0.009;
      const dir = rad(num(d.params, 'direction', 25));
      const travel = num(d.params, 'travel', 1.1);
      const sway = num(d.params, 'sway', 0.07);
      const spin = num(d.params, 'spin', 2.5);
      const alpha = num(d.params, 'opacity', 0.9);
      const c1 = str(d.params, 'color', '#ffd0e2');
      const c2 = str(d.params, 'color2', '#fff2f7');
      for (let i = 0; i < n; i++) {
        const p = life(d.u, pr(d.seed, i, 1));
        const a = envelope(p, 0.1, 0.15) * alpha;
        if (a < 0.01) continue;
        const ox = pr(d.seed, i, 2) * 1.2 - 0.1, oy = pr(d.seed, i, 3) * 0.8 - 0.1;
        const x = (ox + Math.cos(dir) * travel * p + Math.sin(TAU * (p * 3 + pr(d.seed, i, 4))) * sway) * d.w;
        const y = (oy + Math.sin(dir) * travel * p * 0.6 + p * 0.25) * d.h;
        const rot = TAU * (p * spin + pr(d.seed, i, 5));
        const squash = 0.3 + 0.7 * Math.abs(Math.cos(TAU * (p * spin * 0.8)));
        petalShape(ctx, x, y, base * (0.6 + pr(d.seed, i, 6) * 0.8), rot,
          pr(d.seed, i, 7) > 0.5 ? c1 : c2, a, squash);
      }
    },
  },

  {
    id: 'snow', name: 'Snowfall', family: 'weather', defaultLoop: 18, blend: 'source-over',
    description: 'Snowflakes falling at varied speeds with gentle lateral drift.',
    params: [
      R('density', 'Count', 5, 500, 1, 140),
      R('size', 'Flake size', 0.2, 4, 0.05, 1, 'x'),
      R('sway', 'Drift', 0, 0.3, 0.01, 0.05),
      R('direction', 'Wind push', -0.5, 0.5, 0.01, 0.06),
      R('speedSpread', 'Speed variation', 0, 1, 0.01, 0.6),
      R('opacity', 'Opacity', 0.1, 1, 0.01, 0.85),
      R('depthBlur', 'Depth variation', 0, 1, 0.01, 0.5),
      C('color', 'Colour', '#ffffff'),
      T('crystals', 'Draw crystal shapes', false),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 140));
      const base = num(d.params, 'size', 1) * Math.min(d.w, d.h) * 0.0045;
      const sway = num(d.params, 'sway', 0.05);
      const push = num(d.params, 'direction', 0.06);
      const spread = num(d.params, 'speedSpread', 0.6);
      const alpha = num(d.params, 'opacity', 0.85);
      const depth = num(d.params, 'depthBlur', 0.5);
      const col = str(d.params, 'color', '#ffffff');
      const crystals = bool(d.params, 'crystals', false);
      for (let i = 0; i < n; i++) {
        const cycles = 1 + Math.round(pr(d.seed, i, 1) * spread * 2);
        const p = life(d.u, pr(d.seed, i, 2), cycles);
        const near = pr(d.seed, i, 3);
        const x = (pr(d.seed, i, 4) + push * p + Math.sin(TAU * (p * 2 + pr(d.seed, i, 5))) * sway) * d.w;
        const y = (p * 1.2 - 0.1) * d.h;
        const r = base * (0.4 + near * 1.4);
        const a = alpha * (1 - depth * (1 - near) * 0.7);
        if (crystals && r > base) snowflake(ctx, x, y, r * 1.6, col, a, TAU * p);
        else {
          if (near > 0.75) glowDot(ctx, x, y, r * 3, col, a * 0.25);
          coreDot(ctx, x, y, r, col, a);
        }
      }
    },
  },

  {
    id: 'rain', name: 'Rain', family: 'weather', defaultLoop: 6, blend: 'source-over',
    description: 'Streaking rain with optional ground splashes.',
    params: [
      R('density', 'Drop count', 10, 800, 1, 220),
      R('length', 'Streak length', 0.01, 0.2, 0.005, 0.055),
      R('angle', 'Fall angle', 60, 120, 1, 96, 'deg'),
      R('thickness', 'Thickness', 0.2, 3, 0.1, 0.9, 'x'),
      R('speedSpread', 'Speed variation', 0, 1, 0.01, 0.4),
      R('opacity', 'Opacity', 0.05, 1, 0.01, 0.4),
      C('color', 'Colour', '#cfe4f5'),
      T('splashes', 'Ground splashes', true),
      R('splashLine', 'Ground line', 0, 1, 0.01, 0.94),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 220));
      const len = num(d.params, 'length', 0.055) * d.h;
      const ang = rad(num(d.params, 'angle', 96));
      const lw = num(d.params, 'thickness', 0.9) * Math.min(d.w, d.h) * 0.0016;
      const spread = num(d.params, 'speedSpread', 0.4);
      const alpha = num(d.params, 'opacity', 0.4);
      const col = str(d.params, 'color', '#cfe4f5');
      const splashes = bool(d.params, 'splashes', true);
      const ground = num(d.params, 'splashLine', 0.94) * d.h;
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const cycles = 2 + Math.round(pr(d.seed, i, 1) * spread * 4);
        const p = life(d.u, pr(d.seed, i, 2), cycles);
        const near = 0.45 + pr(d.seed, i, 3) * 0.8;
        const x = (pr(d.seed, i, 4) * 1.3 - 0.15) * d.w + Math.cos(ang) * p * d.h * 1.2;
        const y = (p * 1.25 - 0.12) * d.h;
        const l = len * near;
        ctx.strokeStyle = withAlpha(col, alpha * near);
        ctx.lineWidth = lw * near;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(ang) * l, y - Math.sin(ang) * l);
        ctx.stroke();
        if (splashes && y > ground && y < ground + d.h * 0.05 && pr(d.seed, i, 5) > 0.7) {
          const sp = (y - ground) / (d.h * 0.05);
          ctx.strokeStyle = withAlpha(col, alpha * (1 - sp) * 0.8);
          ctx.lineWidth = lw * 0.8;
          ctx.beginPath();
          ctx.ellipse(x, ground, lw * 6 * sp + 1, lw * 2 * sp + 0.5, 0, 0, TAU);
          ctx.stroke();
        }
      }
    },
  },

  {
    id: 'bubbles', name: 'Floating Bubbles', family: 'natural', defaultLoop: 14, blend: 'lighter',
    description: 'Iridescent spheres rising and wobbling.',
    params: [
      R('density', 'Count', 1, 120, 1, 22),
      R('size', 'Size', 0.2, 4, 0.05, 1.2, 'x'),
      R('rise', 'Rise distance', 0.2, 1.6, 0.01, 1.1),
      R('wobble', 'Wobble', 0, 0.2, 0.01, 0.04),
      R('opacity', 'Opacity', 0.05, 1, 0.01, 0.5),
      C('color', 'Rim colour', '#bfe9ff'), C('color2', 'Sheen', '#ffd9f2'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 22));
      const base = num(d.params, 'size', 1.2) * Math.min(d.w, d.h) * 0.012;
      const rise = num(d.params, 'rise', 1.1);
      const wob = num(d.params, 'wobble', 0.04);
      const alpha = num(d.params, 'opacity', 0.5);
      const c1 = str(d.params, 'color', '#bfe9ff');
      const c2 = str(d.params, 'color2', '#ffd9f2');
      for (let i = 0; i < n; i++) {
        const p = life(d.u, pr(d.seed, i, 1));
        const a = envelope(p, 0.12, 0.18) * alpha;
        if (a < 0.01) continue;
        const r = base * (0.4 + pr(d.seed, i, 2) * 1.1);
        const x = (pr(d.seed, i, 3) + Math.sin(TAU * (p * 2 + pr(d.seed, i, 4))) * wob) * d.w;
        const y = (1.1 - p * rise) * d.h;
        ctx.strokeStyle = withAlpha(c1, a * 0.8);
        ctx.lineWidth = Math.max(0.5, r * 0.09);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
        const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.05, x, y, r);
        g.addColorStop(0, withAlpha('#ffffff', a * 0.35));
        g.addColorStop(0.6, withAlpha(c2, a * 0.08));
        g.addColorStop(1, withAlpha(c1, a * 0.16));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
        coreDot(ctx, x - r * 0.35, y - r * 0.38, r * 0.16, '#ffffff', a * 0.8);
      }
    },
  },

  {
    id: 'feathers', name: 'Floating Feathers', family: 'fantasy', defaultLoop: 18, blend: 'source-over',
    description: 'Feathers rocking slowly downward on the air.',
    params: [
      R('density', 'Count', 1, 80, 1, 12),
      R('size', 'Size', 0.2, 4, 0.05, 1.2, 'x'),
      R('sway', 'Rocking', 0, 0.4, 0.01, 0.12),
      R('spin', 'Rotation', -3, 3, 0.1, 0.6),
      R('opacity', 'Opacity', 0.1, 1, 0.01, 0.85),
      C('color', 'Colour', '#f2f6ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 12));
      const base = num(d.params, 'size', 1.2) * Math.min(d.w, d.h) * 0.014;
      const sway = num(d.params, 'sway', 0.12);
      const spin = num(d.params, 'spin', 0.6);
      const alpha = num(d.params, 'opacity', 0.85);
      const col = str(d.params, 'color', '#f2f6ff');
      for (let i = 0; i < n; i++) {
        const p = life(d.u, pr(d.seed, i, 1));
        const a = envelope(p, 0.12, 0.15) * alpha;
        if (a < 0.01) continue;
        const rock = Math.sin(TAU * (p * 2 + pr(d.seed, i, 2)));
        const x = (pr(d.seed, i, 3) + rock * sway) * d.w;
        const y = (p * 1.2 - 0.1) * d.h;
        featherShape(ctx, x, y, base * (0.6 + pr(d.seed, i, 4) * 0.7),
          rock * 0.7 + TAU * p * spin, col, a);
      }
    },
  },

  {
    id: 'glowing-symbols', name: 'Glowing Symbols', family: 'symbols', defaultLoop: 12, blend: 'lighter',
    description: 'Celestial and geometric marks that pulse, rotate and drift.',
    params: [
      R('density', 'Count', 1, 40, 1, 8),
      R('size', 'Size', 0.2, 4, 0.05, 1.3, 'x'),
      S('shape', 'Shape', 'mixed', [['mixed', 'Mixed'], ['circle', 'Rings'], ['triangle', 'Triangles'], ['star', 'Stars'], ['diamond', 'Diamonds']]),
      R('spin', 'Rotation per cycle', -3, 3, 1, 1),
      R('pulse', 'Pulse', 0, 1, 0.01, 0.5),
      R('drift', 'Drift', 0, 0.4, 0.01, 0.08),
      R('glow', 'Glow', 0, 3, 0.05, 1.4, 'x'),
      C('color', 'Colour', '#ffe1a8'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 8));
      const base = num(d.params, 'size', 1.3) * Math.min(d.w, d.h) * 0.016;
      const shape = str(d.params, 'shape', 'mixed');
      const spin = Math.round(num(d.params, 'spin', 1));
      const pulse = num(d.params, 'pulse', 0.5);
      const drift = num(d.params, 'drift', 0.08);
      const glow = num(d.params, 'glow', 1.4);
      const col = str(d.params, 'color', '#ffe1a8');
      const kinds = ['circle', 'triangle', 'star', 'diamond'];
      for (let i = 0; i < n; i++) {
        const p = life(d.u, pr(d.seed, i, 1));
        const a = envelope(p, 0.22, 0.28);
        if (a < 0.01) continue;
        const x = (pr(d.seed, i, 2) + Math.sin(TAU * (d.u + pr(d.seed, i, 3))) * drift) * d.w;
        const y = (pr(d.seed, i, 4) - drift * p) * d.h;
        const b = a * (1 - pulse * (0.5 + 0.5 * Math.sin(TAU * (d.u * 2 + pr(d.seed, i, 5)))));
        const s = base * (0.6 + pr(d.seed, i, 6) * 0.8);
        const kind = shape === 'mixed' ? kinds[i % kinds.length] : shape;
        glowDot(ctx, x, y, s * 2.8 * glow, col, b * 0.32);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(TAU * frac(d.u * spin) + pr(d.seed, i, 7) * TAU);
        ctx.strokeStyle = withAlpha(col, b);
        ctx.lineWidth = Math.max(0.8, s * 0.12);
        ctx.beginPath();
        if (kind === 'circle') {
          ctx.arc(0, 0, s, 0, TAU);
          ctx.moveTo(s * 0.45, 0); ctx.arc(0, 0, s * 0.45, 0, TAU);
        } else if (kind === 'triangle') {
          for (let k = 0; k <= 3; k++) {
            const ang = (k / 3) * TAU - Math.PI / 2;
            const px = Math.cos(ang) * s, py = Math.sin(ang) * s;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
        } else if (kind === 'diamond') {
          ctx.moveTo(0, -s); ctx.lineTo(s * 0.66, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.66, 0); ctx.closePath();
        } else {
          for (let k = 0; k < 10; k++) {
            const ang = (k / 10) * TAU - Math.PI / 2;
            const rr = k % 2 === 0 ? s : s * 0.42;
            const px = Math.cos(ang) * rr, py = Math.sin(ang) * rr;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        }
        ctx.stroke();
        ctx.restore();
      }
    },
  },

  {
    id: 'mythic-emblem', name: 'Mythic Emblems', family: 'symbols', defaultLoop: 20, blend: 'lighter',
    description: 'An animated fantasy seal with selectable fae, Norse-inspired, Chinese-knot-inspired, or Japanese-garden motifs.',
    params: [
      S('motif', 'Motif', 'fae-seal', [
        ['fae-seal', 'Fae crescent'], ['norse-compass', 'Norse compass'],
        ['chinese-knot', 'Chinese knot'], ['japanese-torii', 'Japanese torii'],
      ]),
      R('size', 'Seal size', 0.1, 1.2, 0.01, 0.42),
      R('cx', 'Centre X', 0, 1, 0.01, 0.5), R('cy', 'Centre Y', 0, 1, 0.01, 0.5),
      R('rotations', 'Turns per cycle', -2, 2, 1, 1),
      R('pulse', 'Breathing glow', 0, 0.5, 0.01, 0.12),
      C('color', 'Main colour', '#f2d59a'), C('color2', 'Accent colour', '#b8d8ff'),
    ],
    draw(ctx, d) {
      const motif = str(d.params, 'motif', 'fae-seal');
      const col = str(d.params, 'color', '#f2d59a');
      const col2 = str(d.params, 'color2', '#b8d8ff');
      const radius = Math.min(d.w, d.h) * 0.28 * num(d.params, 'size', 0.42);
      const turn = TAU * frac(Math.round(num(d.params, 'rotations', 1)) * d.u);
      const pulse = 1 + num(d.params, 'pulse', 0.12) * Math.sin(TAU * d.u);
      ctx.save();
      ctx.translate(num(d.params, 'cx', 0.5) * d.w, num(d.params, 'cy', 0.5) * d.h);
      ctx.rotate(turn);
      ctx.scale(pulse, pulse);
      ctx.strokeStyle = withAlpha(col2, 0.7);
      ctx.lineWidth = Math.max(1.2, radius * 0.018);
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
      if (motif === 'norse-compass') {
        for (let i = 0; i < 8; i++) {
          ctx.save(); ctx.rotate(i * TAU / 8);
          ctx.beginPath(); ctx.moveTo(0, radius * 0.18); ctx.lineTo(0, radius * 0.92);
          ctx.moveTo(-radius * 0.08, radius * 0.63); ctx.lineTo(0, radius * 0.92);
          ctx.lineTo(radius * 0.08, radius * 0.63); ctx.stroke();
          ctx.restore();
        }
        ctx.strokeStyle = withAlpha(col, 0.9);
        ctx.beginPath(); ctx.moveTo(-radius * 0.42, 0); ctx.lineTo(-radius * 0.16, -radius * 0.35);
        ctx.lineTo(0, radius * 0.1); ctx.lineTo(radius * 0.18, -radius * 0.35);
        ctx.lineTo(radius * 0.42, 0); ctx.stroke();
      } else if (motif === 'chinese-knot') {
        // Symmetric interlocking loops: a decorative fantasy knot, not a specific sacred character.
        ctx.strokeStyle = withAlpha(col, 0.92);
        ctx.lineWidth = Math.max(1.5, radius * 0.055);
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(0, 0);
          ctx.bezierCurveTo(s * radius * 0.95, -radius * 0.86, s * radius * 0.95, radius * 0.86, 0, 0);
          ctx.bezierCurveTo(-s * radius * 0.78, -radius * 0.82, -s * radius * 0.78, radius * 0.82, 0, 0);
          ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(0, 0, radius * 0.2, 0, TAU); ctx.stroke();
      } else if (motif === 'japanese-torii') {
        const w = radius * 0.92;
        ctx.strokeStyle = withAlpha(col, 0.95);
        ctx.lineWidth = Math.max(1.5, radius * 0.06);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-w * 0.82, -radius * 0.5); ctx.quadraticCurveTo(0, -radius * 0.72, w * 0.82, -radius * 0.5);
        ctx.moveTo(-w * 0.62, -radius * 0.3); ctx.lineTo(w * 0.62, -radius * 0.3);
        ctx.moveTo(-w * 0.48, -radius * 0.28); ctx.lineTo(-w * 0.42, radius * 0.56);
        ctx.moveTo(w * 0.48, -radius * 0.28); ctx.lineTo(w * 0.42, radius * 0.56);
        ctx.moveTo(-w * 0.58, radius * 0.12); ctx.lineTo(w * 0.58, radius * 0.12);
        ctx.stroke();
        ctx.strokeStyle = withAlpha(col2, 0.75);
        for (let i = 0; i < 3; i++) {
          const yy = radius * (0.62 + i * 0.1);
          ctx.beginPath(); ctx.moveTo(-radius * 0.7, yy);
          ctx.quadraticCurveTo(-radius * 0.3, yy - radius * 0.11, 0, yy);
          ctx.quadraticCurveTo(radius * 0.3, yy + radius * 0.11, radius * 0.7, yy);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = withAlpha(col, 0.92);
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.42, Math.PI * 0.18, Math.PI * 1.82);
        ctx.stroke();
        for (let i = 0; i < 4; i++) {
          const a = i * TAU / 4 + Math.PI / 4;
          const x = Math.cos(a) * radius * 0.7, y = Math.sin(a) * radius * 0.7;
          ctx.save(); ctx.translate(x, y); ctx.rotate(a);
          ctx.beginPath(); ctx.ellipse(0, 0, radius * 0.12, radius * 0.28, 0, 0, TAU); ctx.stroke();
          ctx.restore();
        }
        sparkleStar(ctx, 0, 0, radius * 0.16, col2, 0.95, 6);
      }
      ctx.restore();
    },
  },

  {
    id: 'wind-currents', name: 'Visible Air Currents', family: 'natural', defaultLoop: 10, blend: 'lighter',
    description: 'Soft, curling ribbons of air stream across the scene in repeating gusts.',
    params: [
      R('density', 'Current count', 2, 40, 1, 14),
      R('speed', 'Gust speed', 1, 8, 1, 3, ' passes per cycle'),
      R('sway', 'Curl', 0, 0.25, 0.01, 0.08),
      R('thickness', 'Ribbon weight', 0.3, 4, 0.1, 1.2, 'x'),
      R('opacity', 'Opacity', 0.05, 0.8, 0.01, 0.28),
      C('color', 'Air tint', '#c9e8ff'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 14));
      const speed = Math.round(num(d.params, 'speed', 3));
      const sway = num(d.params, 'sway', 0.08);
      const opacity = num(d.params, 'opacity', 0.28);
      const col = str(d.params, 'color', '#c9e8ff');
      const min = Math.min(d.w, d.h);
      for (let i = 0; i < n; i++) {
        const phase = pr(d.seed, i, 1);
        const len = d.w * (0.12 + 0.18 * pr(d.seed, i, 2));
        const x = frac(d.u * speed + phase) * (d.w + len) - len;
        const y = (0.06 + 0.88 * pr(d.seed, i, 3)) * d.h;
        const amp = sway * d.h * (0.25 + 0.75 * pr(d.seed, i, 4));
        const a = opacity * (0.5 + 0.5 * pr(d.seed, i, 5));
        const grad = ctx.createLinearGradient(x, y, x + len, y);
        grad.addColorStop(0, withAlpha(col, 0));
        grad.addColorStop(0.28, withAlpha(col, a * 0.45));
        grad.addColorStop(0.72, withAlpha(col, a));
        grad.addColorStop(1, withAlpha(col, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = Math.max(1, min * 0.0022 * num(d.params, 'thickness', 1.2));
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + len * 0.28, y - amp, x + len * 0.62, y + amp, x + len, y);
        ctx.stroke();
      }
    },
  },

  {
    id: 'zodiac-wheel', name: 'Mythic Zodiac Wheel', family: 'celestial', defaultLoop: 24, blend: 'lighter',
    description: 'A slow-turning celestial seal of twelve zodiac-inspired marks, star paths and orbit rings.',
    params: [
      R('size', 'Wheel size', 0.1, 1.2, 0.01, 0.68),
      R('cx', 'Centre X', 0, 1, 0.01, 0.5), R('cy', 'Centre Y', 0, 1, 0.01, 0.5),
      R('rotations', 'Turns per cycle', -2, 2, 1, 1),
      R('pulse', 'Breathing glow', 0, 0.5, 0.01, 0.12),
      T('labels', 'Show sign names', true),
      C('color', 'Star colour', '#ffe5ae'), C('color2', 'Orbit colour', '#a9d9ff'),
    ],
    draw(ctx, d) {
      const names = ['ARIES', 'TAURUS', 'GEMINI', 'CANCER', 'LEO', 'VIRGO',
        'LIBRA', 'SCORPIO', 'SAGITTARIUS', 'CAPRICORN', 'AQUARIUS', 'PISCES'];
      // Small invented line-art interpretations of the twelve familiar sky signs.
      const marks: number[][][] = [
        [[-1, 0.8], [-0.72, 0.05], [-0.35, -0.35], [0, 0.25], [0.35, -0.35], [0.72, 0.05], [1, 0.8]],
        [[-0.8, -0.55], [-0.52, -0.9], [-0.18, -0.55], [0.18, -0.55], [0.52, -0.9], [0.8, -0.55], [0, 0.8], [-0.8, -0.55]],
        [[-0.75, -0.9], [0.75, -0.9], [0.75, 0.9], [-0.75, 0.9], [-0.75, -0.9], [0.75, 0.9]],
        [[-0.9, -0.5], [-0.45, -0.1], [0, -0.5], [0.45, -0.1], [0.9, -0.5], [0.45, 0.35], [0, 0.7], [-0.45, 0.35], [-0.9, -0.5]],
        [[-0.9, 0.6], [-0.7, -0.8], [-0.3, -0.1], [0.1, -0.75], [0.85, 0.5], [0.2, 0.85], [-0.3, 0.35], [-0.9, 0.6]],
        [[-0.9, -0.7], [-0.55, 0.7], [-0.1, -0.2], [0.35, 0.65], [0.9, -0.7]],
        [[-0.8, -0.6], [0.8, -0.6], [0, 0], [-0.8, 0.6], [0.8, 0.6]],
        [[-0.9, -0.65], [-0.55, 0.2], [-0.2, -0.6], [0.15, 0.2], [0.5, -0.6], [0.9, 0.25], [0.45, 0.75]],
        [[-0.8, 0.75], [0.45, -0.7], [0.8, -0.7], [0.68, -0.25], [0.95, -0.3]],
        [[-0.9, -0.7], [-0.25, 0.15], [-0.65, 0.8], [0, 0.25], [0.72, 0.8], [0.35, -0.1], [0.9, -0.65]],
        [[-0.9, -0.5], [-0.35, 0.2], [0.15, -0.5], [0.72, 0.2], [0.9, -0.05], [0.15, 0.72], [-0.35, 0.05], [-0.9, 0.72]],
        [[-0.85, -0.2], [-0.35, -0.7], [0.2, -0.2], [0.8, -0.7], [0.8, 0.2], [0.3, 0.7], [-0.25, 0.2], [-0.85, 0.7]],
      ];
      const col = str(d.params, 'color', '#ffe5ae');
      const col2 = str(d.params, 'color2', '#a9d9ff');
      const min = Math.min(d.w, d.h);
      const unit = min * 0.027 * num(d.params, 'size', 0.68);
      const orbit = min * 0.32 * num(d.params, 'size', 0.68);
      const rot = TAU * frac(Math.round(num(d.params, 'rotations', 1)) * d.u);
      const breath = 1 + num(d.params, 'pulse', 0.12) * Math.sin(TAU * d.u);
      ctx.save();
      ctx.translate(num(d.params, 'cx', 0.5) * d.w, num(d.params, 'cy', 0.5) * d.h);
      ctx.rotate(rot);
      ctx.strokeStyle = withAlpha(col2, 0.48);
      ctx.lineWidth = Math.max(1, min * 0.0015);
      ctx.beginPath(); ctx.arc(0, 0, orbit * breath, 0, TAU); ctx.stroke();
      ctx.strokeStyle = withAlpha(col, 0.24);
      ctx.beginPath(); ctx.arc(0, 0, orbit * 1.13 * breath, 0, TAU); ctx.stroke();
      glowDot(ctx, 0, 0, min * 0.045, col, 0.18 + 0.08 * Math.sin(TAU * d.u));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU - Math.PI / 2;
        const x = Math.cos(a) * orbit * breath, y = Math.sin(a) * orbit * breath;
        ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
        ctx.strokeStyle = withAlpha(i % 2 ? col2 : col, 0.88);
        ctx.lineWidth = Math.max(1, min * 0.0018);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        marks[i].forEach(([mx, my], j) => {
          const px = mx * unit, py = my * unit;
          if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
        for (let k = 0; k < marks[i].length; k += 2) {
          const [mx, my] = marks[i][k];
          glowDot(ctx, mx * unit, my * unit, min * 0.008, col, 0.9);
        }
        if (bool(d.params, 'labels', true)) {
          ctx.fillStyle = withAlpha(col, 0.8);
          ctx.font = `600 ${Math.max(7, min * 0.009)}px sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(names[i], 0, unit * 1.12);
        }
        ctx.restore();
      }
      ctx.restore();
    },
  },

  {
    id: 'floating-lanterns', name: 'Floating Lanterns', family: 'fantasy', defaultLoop: 16, blend: 'lighter',
    description: 'Warm paper lanterns bob upward and sway gently through drifting mist.',
    params: [
      R('density', 'Lantern count', 1, 36, 1, 7),
      R('size', 'Lantern size', 0.2, 3, 0.05, 1),
      R('sway', 'Air sway', 0, 0.3, 0.01, 0.08),
      R('glow', 'Light bloom', 0, 3, 0.05, 1.35),
      C('color', 'Lantern colour', '#e84232'), C('color2', 'Light colour', '#ffd889'),
    ],
    draw(ctx, d) {
      const n = Math.round(num(d.params, 'density', 7));
      const min = Math.min(d.w, d.h);
      const unit = min * 0.038 * num(d.params, 'size', 1);
      const sway = num(d.params, 'sway', 0.08);
      const glow = num(d.params, 'glow', 1.35);
      const body = str(d.params, 'color', '#e84232');
      const light = str(d.params, 'color2', '#ffd889');
      for (let i = 0; i < n; i++) {
        const phase = pr(d.seed, i, 1);
        const p = frac(d.u + phase);
        const alpha = Math.sin(Math.PI * p);
        if (alpha < 0.025) continue;
        const x = (pr(d.seed, i, 2) + Math.sin(TAU * (d.u + phase)) * sway) * d.w;
        const y = (1.1 - 1.3 * p) * d.h;
        const w = unit * (0.72 + 0.45 * pr(d.seed, i, 3));
        const h = w * 1.38;
        const a = alpha * (0.7 + 0.25 * pr(d.seed, i, 4));
        glowDot(ctx, x, y, h * 1.8 * glow, light, a * 0.22);
        ctx.save(); ctx.translate(x, y);
        ctx.rotate(Math.sin(TAU * (d.u + phase)) * 0.07);
        ctx.fillStyle = withAlpha(body, a * 0.9);
        ctx.beginPath(); ctx.ellipse(0, 0, w * 0.5, h * 0.48, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = withAlpha(light, a * 0.85);
        ctx.lineWidth = Math.max(1, w * 0.035);
        ctx.beginPath();
        ctx.moveTo(-w * 0.42, -h * 0.22); ctx.quadraticCurveTo(0, -h * 0.36, w * 0.42, -h * 0.22);
        ctx.moveTo(-w * 0.43, h * 0.24); ctx.quadraticCurveTo(0, h * 0.37, w * 0.43, h * 0.24);
        ctx.stroke();
        ctx.fillStyle = withAlpha(light, a);
        ctx.fillRect(-w * 0.3, -h * 0.48, w * 0.6, h * 0.12);
        ctx.fillRect(-w * 0.27, h * 0.42, w * 0.54, h * 0.09);
        ctx.strokeStyle = withAlpha(light, a * 0.85);
        ctx.beginPath(); ctx.moveTo(0, h * 0.47); ctx.lineTo(0, h * 0.75); ctx.stroke();
        ctx.restore();
      }
    },
  },
  ...SPIRITUAL_EFFECTS,
];

export const EFFECT_MAP = new Map(EFFECTS.map((e) => [e.id, e]));

export const FAMILY_LABEL: Record<EffectFamily, string> = {
  magical: 'Magical',
  symbols: 'Symbols & ornament',
  celestial: 'Celestial',
  fantasy: 'Fantasy',
  natural: 'Natural',
  weather: 'Weather',
  spiritual: 'Spiritual & Mystical Overlays',
};

export function effectDefaults(id: string): Record<string, number | string | boolean> {
  const def = EFFECT_MAP.get(id);
  const out: Record<string, number | string | boolean> = {};
  if (!def) return out;
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

/* ------------------------------------------------------- theme collections
 * Artistic interpretations offered as starting points. They are never locked
 * to a style, and every parameter stays fully editable after applying one.
 */
export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  effects: { id: string; params?: Record<string, number | string | boolean>; loop?: number }[];
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'norse', name: 'Norse Night', description: 'Aurora, drifting snow and rune marks under a cold sky.',
    effects: [
      { id: 'aurora', params: { color: '#5cffc0', color2: '#6aa8ff', intensity: 0.4 } },
      { id: 'snow', params: { density: 90, opacity: 0.6 } },
      { id: 'floating-runes', params: { color: '#a8e6ff', density: 8 } },
      { id: 'mythic-emblem', params: { motif: 'norse-compass', color: '#a8e6ff', color2: '#5cffc0' } },
      { id: 'wind-currents', params: { color: '#a8e6ff', opacity: 0.16, density: 9 } },
    ],
  },
  {
    id: 'greek', name: 'Hellenic Celestial', description: 'Golden ornament, constellations and soft light shafts.',
    effects: [
      { id: 'constellation', params: { color: '#ffe9bd', stars: 11 } },
      { id: 'mandala', params: { color: '#ffd9a0', color2: '#fff0c9', size: 0.24 } },
      { id: 'light-beams', params: { color: '#ffe9bd', intensity: 0.22 } },
    ],
  },
  {
    id: 'chinese', name: 'Eastern Fantasy', description: 'Blossom petals, mist and drifting lantern-like orbs.',
    effects: [
      { id: 'drifting-petals', params: { color: '#ffd0e2', density: 46 } },
      { id: 'mist', params: { color: '#e6f0f5', opacity: 0.14 } },
      { id: 'floating-lanterns', params: { color: '#cf3b30', color2: '#ffd36b', density: 7 } },
      { id: 'mythic-emblem', params: { motif: 'chinese-knot', color: '#cf3b30', color2: '#ffd36b' } },
      { id: 'wind-currents', params: { color: '#ffd9a0', opacity: 0.12, density: 8 } },
    ],
  },
  {
    id: 'japanese', name: 'Japanese Moonlit Garden',
    description: 'A stylized fantasy garden of sakura-like petals, soft lantern light and silver mist; not a historical reconstruction.',
    effects: [
      { id: 'drifting-petals', params: { color: '#ffd9e8', density: 36 } },
      { id: 'mist', params: { color: '#d9e7f7', opacity: 0.12, band: 0.72 } },
      { id: 'floating-lanterns', params: { color: '#f0dfbd', color2: '#fff0c7', density: 4, size: 0.78, sway: 0.04 } },
      { id: 'mythic-emblem', params: { motif: 'japanese-torii', color: '#d96f79', color2: '#e8c782', size: 0.5 } },
      { id: 'wind-currents', params: { color: '#e6e2f2', opacity: 0.11, density: 7 } },
      { id: 'constellation', params: { color: '#d8e7ff', stars: 7, lineOpacity: 0.18 } },
    ],
  },
  {
    id: 'mythic-zodiac', name: 'Mythic Zodiac',
    description: 'Twelve invented star-sign marks encircle a rotating celestial seal.',
    effects: [
      { id: 'zodiac-wheel', params: { color: '#ffe6ad', color2: '#9fcfff', size: 0.7 } },
      { id: 'shooting-stars', params: { density: 5, color: '#ffe6ad' } },
      { id: 'magic-circle', params: { color: '#9fcfff', size: 0.23, rings: 3, glyphs: 12 } },
    ],
  },
  {
    id: 'gothic', name: 'Gothic Gloom', description: 'Low fog, rain and a pale celestial glow.',
    effects: [
      { id: 'mist', params: { color: '#9fb0c4', opacity: 0.22, band: 0.8 } },
      { id: 'rain', params: { density: 160, opacity: 0.28 } },
      { id: 'glowing-symbols', params: { color: '#b9c9e8', density: 5, shape: 'circle' } },
    ],
  },
  {
    id: 'fairy', name: 'Fairy Tale', description: 'Fairy dust, butterflies and glittering sparkles.',
    effects: [
      { id: 'fairy-dust', params: { density: 110 } },
      { id: 'butterflies', params: { density: 5 } },
      { id: 'mythic-emblem', params: { motif: 'fae-seal', color: '#edb9ff', color2: '#a9f7df' } },
      { id: 'wind-currents', params: { color: '#d4ffe7', opacity: 0.16, sway: 0.12 } },
      { id: 'sparkles', params: { density: 60 } },
    ],
  },
  {
    id: 'meditation', name: 'Meditation', description: 'Slow orbs, a breathing mandala and a quiet starfield.',
    effects: [
      { id: 'glowing-orbs', params: { density: 5, pulse: 0.5, color: '#9fd8ff' }, loop: 24 },
      { id: 'mandala', params: { pulse: 0.25, size: 0.26 }, loop: 30 },
      { id: 'starfield', params: { density: 120, twinkle: 0.4 } },
    ],
  },
];
