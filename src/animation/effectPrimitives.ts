/**
 * Drawing primitives + deterministic randomness for atmospheric effects.
 *
 * Effects hold **no state between frames**. Every particle attribute is a pure
 * function of (seed, index), and every position is a pure function of the
 * normalised cycle position `u`. That is what makes an effect frame at u=0
 * bit-identical to the frame at u=1, and what lets the video renderer encode a
 * single cycle and repeat it.
 */
import { clamp, frac, TAU } from '../core/util';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Fast integer hash -> 0..1. Stable across runs and platforms. */
export function pr(seed: number, i: number, k = 0): number {
  let n = (seed * 7919 + i * 104729 + k * 15485863) | 0;
  n = Math.imul(n ^ (n >>> 15), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export interface EffectDrawContext {
  w: number;
  h: number;
  u: number;                 // 0..1 position in this effect's cycle
  t: number;                 // absolute seconds (for display only)
  params: Record<string, number | string | boolean>;
  seed: number;
  scale: number;             // render pixels per design pixel
}

export const num = (p: EffectDrawContext['params'], k: string, d = 0) => {
  const v = p[k];
  return typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) || d : d;
};
export const str = (p: EffectDrawContext['params'], k: string, d = '#ffffff') => {
  const v = p[k];
  return typeof v === 'string' ? v : d;
};
export const bool = (p: EffectDrawContext['params'], k: string, d = false) => {
  const v = p[k];
  return typeof v === 'boolean' ? v : d;
};

/* --------------------------------------------------------------- shapes */

export function glowDot(ctx: Ctx2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (r <= 0 || alpha <= 0.002) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, withAlpha(color, alpha));
  g.addColorStop(0.35, withAlpha(color, alpha * 0.45));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

export function coreDot(ctx: Ctx2D, x: number, y: number, r: number, color: string, alpha: number) {
  ctx.fillStyle = withAlpha(color, alpha);
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.3, r), 0, TAU);
  ctx.fill();
}

export function sparkleStar(ctx: Ctx2D, x: number, y: number, r: number, color: string, alpha: number, points = 4) {
  if (r <= 0.2 || alpha <= 0.003) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = withAlpha(color, alpha);
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const ang = (i / (points * 2)) * TAU - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.16;
    const px = Math.cos(ang) * rad, py = Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function leafShape(ctx: Ctx2D, x: number, y: number, size: number, rot: number, color: string, alpha: number, squash = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(1, squash);
  ctx.fillStyle = withAlpha(color, alpha);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.bezierCurveTo(size * 0.72, -size * 0.45, size * 0.55, size * 0.6, 0, size);
  ctx.bezierCurveTo(-size * 0.55, size * 0.6, -size * 0.72, -size * 0.45, 0, -size);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#000000', alpha * 0.16);
  ctx.lineWidth = Math.max(0.4, size * 0.07);
  ctx.beginPath(); ctx.moveTo(0, -size * 0.85); ctx.lineTo(0, size * 0.85); ctx.stroke();
  ctx.restore();
}

export function petalShape(ctx: Ctx2D, x: number, y: number, size: number, rot: number, color: string, alpha: number, squash = 1) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, squash);
  ctx.fillStyle = withAlpha(color, alpha);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.bezierCurveTo(size * 0.9, -size * 0.3, size * 0.5, size * 0.85, 0, size);
  ctx.bezierCurveTo(-size * 0.5, size * 0.85, -size * 0.9, -size * 0.3, 0, -size);
  ctx.fill();
  ctx.restore();
}

export function featherShape(ctx: Ctx2D, x: number, y: number, size: number, rot: number, color: string, alpha: number) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = withAlpha(color, alpha * 0.85);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.bezierCurveTo(size * 0.5, -size * 0.2, size * 0.34, size * 0.7, 0, size);
  ctx.bezierCurveTo(-size * 0.34, size * 0.7, -size * 0.5, -size * 0.2, 0, -size);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#ffffff', alpha * 0.35);
  ctx.lineWidth = Math.max(0.4, size * 0.06);
  ctx.beginPath(); ctx.moveTo(0, -size * 0.9); ctx.lineTo(0, size * 0.95); ctx.stroke();
  ctx.restore();
}

export function snowflake(ctx: Ctx2D, x: number, y: number, r: number, color: string, alpha: number, rot = 0) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.strokeStyle = withAlpha(color, alpha);
  ctx.lineWidth = Math.max(0.5, r * 0.22);
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(-Math.cos(a) * r, -Math.sin(a) * r);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();
}

export function butterflyShape(
  ctx: Ctx2D, x: number, y: number, size: number, heading: number, flap: number,
  color: string, accent: string, alpha: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  const open = 0.28 + 0.72 * Math.abs(Math.sin(flap));
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side * open, 1);
    ctx.fillStyle = withAlpha(color, alpha);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(size * 0.9, -size * 1.05, size * 1.35, -size * 0.25, size * 0.35, size * 0.12);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = withAlpha(accent, alpha * 0.92);
    ctx.beginPath();
    ctx.moveTo(0, size * 0.05);
    ctx.bezierCurveTo(size * 0.72, size * 0.28, size * 0.62, size * 0.95, size * 0.16, size * 0.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = withAlpha('#2a2118', alpha);
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.11, size * 0.5, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Rune-like glyph built from strokes on a 3x5 lattice - decorative, not a script. */
export function runeGlyph(ctx: Ctx2D, x: number, y: number, size: number, rot: number, variant: number, color: string, alpha: number, lw = 2) {
  const patterns: number[][][] = [
    [[0, -1, 0, 1], [0, -1, 0.7, -0.4], [0, -0.2, 0.7, 0.3]],
    [[-0.6, -1, -0.6, 1], [0.6, -1, 0.6, 1], [-0.6, -0.3, 0.6, 0.3]],
    [[0, -1, 0, 1], [-0.6, -0.6, 0.6, 0.6], [-0.6, 0.6, 0.6, -0.6]],
    [[-0.6, 1, 0, -1], [0, -1, 0.6, 1], [-0.35, 0.2, 0.35, 0.2]],
    [[0, -1, 0, 1], [-0.6, -1, 0, -0.35], [0.6, -1, 0, -0.35]],
    [[-0.6, -1, 0.6, -1], [0, -1, 0, 1], [-0.5, 1, 0.5, 1]],
    [[-0.6, -0.8, 0.6, -0.8], [-0.6, 0.8, 0.6, 0.8], [-0.6, -0.8, 0.6, 0.8]],
    [[0, -1, -0.6, 0], [-0.6, 0, 0, 1], [0, 1, 0.6, 0], [0.6, 0, 0, -1]],
  ];
  const p = patterns[Math.abs(Math.round(variant)) % patterns.length];
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.strokeStyle = withAlpha(color, alpha);
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1] of p) {
    ctx.beginPath();
    ctx.moveTo(x0 * size, y0 * size);
    ctx.lineTo(x1 * size, y1 * size);
    ctx.stroke();
  }
  ctx.restore();
}

export function withAlpha(color: string, alpha: number): string {
  const a = clamp(alpha, 0, 1);
  if (color.startsWith('#')) {
    const h = color.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  if (color.startsWith('rgba')) return color.replace(/[\d.]+\)$/, `${a})`);
  if (color.startsWith('rgb')) return color.replace('rgb', 'rgba').replace(')', `,${a})`);
  return color;
}

/**
 * Lifetime envelope: fade in, hold, fade out, all inside one wrapped cycle.
 * Because the envelope is zero at both ends, a particle can be teleported back
 * to its start position without any visible pop.
 */
export function envelope(p: number, fadeIn = 0.18, fadeOut = 0.28): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < fadeIn) return p / fadeIn;
  if (p > 1 - fadeOut) return (1 - p) / fadeOut;
  return 1;
}

/** Wrapped particle phase: each particle gets its own offset in the cycle. */
export const life = (u: number, offset: number, cycles = 1) => frac(u * cycles + offset);
