/**
 * Lightweight vector ornaments for the universal Layer 4 effect system.
 * All motion is a pure periodic function of the effect phase; no DOM, images,
 * external fonts or WebGL are required by preview, stills or video export.
 * Symbols are artistic interpretations, not authoritative religious diagrams.
 */
import { clamp, frac, TAU } from '../core/util';
import { bool, glowDot, num, pr, sparkleStar, str, withAlpha } from './effectPrimitives';
import type { Ctx2D, EffectDrawContext } from './effectPrimitives';
import type { EffectDef, ParamDef } from './effects';

export const SPIRITUAL_SUBCATEGORIES = [
  'Sacred Geometry', 'Meditation Symbols', 'Mandalas', 'Chakra & Energy',
  'Celestial Symbols', 'Ancient Mystical Symbols', 'Glowing Geometric Patterns', 'Inspirational Elements',
] as const;
type Subcategory = typeof SPIRITUAL_SUBCATEGORIES[number];
type Motif = 'flower' | 'metatron' | 'yantra' | 'lotus' | 'om' | 'mandala' | 'mandala-star'
  | 'chakra' | 'sun' | 'moon' | 'star' | 'planet' | 'zodiac' | 'alchemy' | 'mystic' | 'rings' | 'lattice' | 'heart' | 'infinity';
interface Design { id: string; name: string; subcategory: Subcategory; motif: Motif; color?: string; petals?: number; }

const DESIGNS: Design[] = [
  { id: 'flower-of-life', name: 'Flower of Life', subcategory: 'Sacred Geometry', motif: 'flower' },
  { id: 'metatrons-cube', name: "Metatron's Cube", subcategory: 'Sacred Geometry', motif: 'metatron' },
  { id: 'sri-yantra', name: 'Sri Yantra Inspired', subcategory: 'Sacred Geometry', motif: 'yantra' },
  { id: 'lotus', name: 'Floating Lotus', subcategory: 'Meditation Symbols', motif: 'lotus' },
  { id: 'om', name: 'Om Inspired Seal', subcategory: 'Meditation Symbols', motif: 'om' },
  { id: 'mandala-rosette', name: 'Lotus Rosette Mandala', subcategory: 'Mandalas', motif: 'mandala' },
  { id: 'mandala-star', name: 'Starlight Mandala', subcategory: 'Mandalas', motif: 'mandala-star' },
  { id: 'chakra-root', name: 'Root Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#f26768', petals: 4 },
  { id: 'chakra-sacral', name: 'Sacral Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#ffa45e', petals: 6 },
  { id: 'chakra-solar', name: 'Solar Plexus Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#ffdf6d', petals: 10 },
  { id: 'chakra-heart', name: 'Heart Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#8ae5a3', petals: 12 },
  { id: 'chakra-throat', name: 'Throat Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#86d8ff', petals: 16 },
  { id: 'chakra-brow', name: 'Brow Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#a8a7ff', petals: 2 },
  { id: 'chakra-crown', name: 'Crown Chakra Inspired', subcategory: 'Chakra & Energy', motif: 'chakra', color: '#d6a5ff', petals: 20 },
  { id: 'celestial-sun', name: 'Radiant Sun', subcategory: 'Celestial Symbols', motif: 'sun' },
  { id: 'celestial-moon', name: 'Crescent Moon & Stars', subcategory: 'Celestial Symbols', motif: 'moon' },
  { id: 'celestial-star', name: 'Radiant Celestial Star', subcategory: 'Celestial Symbols', motif: 'star' },
  { id: 'celestial-planet', name: 'Orbiting Planet', subcategory: 'Celestial Symbols', motif: 'planet' },
  { id: 'zodiac-wheel', name: 'Zodiac Inspired Wheel', subcategory: 'Celestial Symbols', motif: 'zodiac' },
  { id: 'alchemical-elements', name: 'Alchemical Elements', subcategory: 'Ancient Mystical Symbols', motif: 'alchemy' },
  { id: 'mystic-compass', name: 'Mystic Compass', subcategory: 'Ancient Mystical Symbols', motif: 'mystic' },
  { id: 'energy-rings', name: 'Energy Rings', subcategory: 'Glowing Geometric Patterns', motif: 'rings' },
  { id: 'geometric-lattice', name: 'Geometric Lattice', subcategory: 'Glowing Geometric Patterns', motif: 'lattice' },
  { id: 'radiant-heart', name: 'Radiant Heart', subcategory: 'Inspirational Elements', motif: 'heart' },
  { id: 'infinity-light', name: 'Infinity Light', subcategory: 'Inspirational Elements', motif: 'infinity' },
];

const range = (key: string, label: string, min: number, max: number, step: number, value: number, hint?: string): ParamDef =>
  ({ key, label, type: 'range', min, max, step, default: value, hint });
const material: ParamDef = { key: 'material', label: 'Appearance', type: 'select', default: 'gold', options: [
  { value: 'gold', label: 'Glowing gold' }, { value: 'metal', label: 'Metallic gold' },
  { value: 'silver', label: 'Silver / chrome' }, { value: 'white', label: 'Luminous white' },
  { value: 'blue', label: 'Blue energy' }, { value: 'violet', label: 'Violet energy' },
  { value: 'glass', label: 'Translucent glass' }, { value: 'holographic', label: 'Holographic' },
  { value: 'custom', label: 'Custom colour' },
] };

function params(color?: string): ParamDef[] {
  return [
    { ...material, default: color ? 'custom' : 'gold' },
    { key: 'color', label: 'Custom colour', type: 'color', default: color ?? '#ffd97c' },
    range('glow', 'Glow intensity', 0, 2, 0.05, 0.7),
    range('stroke', 'Line detail', 0.6, 2.5, 0.1, 1),
    { key: 'direction', label: 'Rotation direction', type: 'select', default: 'clockwise', options: [
      { value: 'clockwise', label: 'Clockwise' }, { value: 'counterclockwise', label: 'Counterclockwise' },
      { value: 'still', label: 'No rotation' },
    ] },
    range('phase', 'Starting phase', 0, 1, 0.01, 0, 'Offsets the closed movement and spin path.'),
    range('float', 'Vertical movement', 0, 0.3, 0.01, 0.06),
    range('sway', 'Side movement', 0, 0.3, 0.01, 0.04),
    range('tiltX', 'Horizontal axis tilt', 0, 0.8, 0.01, 0.12, 'A 2D perspective-like tilt, not a 3D model.'),
    range('tiltY', 'Vertical axis tilt', 0, 0.8, 0.01, 0.1),
    range('depth', 'Forward / backward', 0, 0.4, 0.01, 0.08, 'Simulated through gentle scale changes.'),
    range('pulse', 'Glow pulse', 0, 1, 0.01, 0.25),
    range('fade', 'Fade in / out', 0, 1, 0.01, 0.15, 'A periodic opacity breath within the cycle.'),
    range('windowFade', 'Start / stop fade', 0, 5, 0.1, 1, 'Seconds of soft fade when start or stop timing is set.'),
    { key: 'particles', label: 'Floating particles', type: 'toggle', default: true },
    { key: 'trails', label: 'Light trails', type: 'toggle', default: false },
  ];
}

const palettes: Record<string, [string, string, string]> = {
  gold: ['#ffe6a4', '#ffd064', '#fff5cd'], metal: ['#fff3b5', '#a76a1e', '#fff7c9'],
  silver: ['#ffffff', '#899bad', '#ffffff'], white: ['#ffffff', '#ccecff', '#ffffff'],
  blue: ['#d8f8ff', '#54bfff', '#a1f1ff'], violet: ['#f1d5ff', '#a868ff', '#d4b0ff'],
  glass: ['#d7f8ff', '#73a8c4', '#ffffff'], holographic: ['#7af6ef', '#c182ff', '#ffd4f6'],
};

function circle(ctx: Ctx2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
}
function poly(ctx: Ctx2D, points: [number, number][], close = true) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  if (close) ctx.closePath(); ctx.stroke();
}
function polygon(ctx: Ctx2D, n: number, r: number, rotation = -Math.PI / 2) {
  poly(ctx, Array.from({ length: n }, (_, i) => [Math.cos(rotation + TAU * i / n) * r, Math.sin(rotation + TAU * i / n) * r]));
}
function petals(ctx: Ctx2D, n: number, inner: number, outer: number) {
  for (let i = 0; i < n; i++) {
    ctx.save(); ctx.rotate(TAU * i / n);
    ctx.beginPath(); ctx.moveTo(0, -inner);
    ctx.bezierCurveTo(0.18, -(inner + outer) * 0.54, 0.13, -outer * 0.87, 0, -outer);
    ctx.bezierCurveTo(-0.13, -outer * 0.87, -0.18, -(inner + outer) * 0.54, 0, -inner);
    ctx.stroke(); ctx.restore();
  }
}
function rays(ctx: Ctx2D, n: number, a: number, b: number) {
  for (let i = 0; i < n; i++) {
    const ang = TAU * i / n;
    poly(ctx, [[Math.cos(ang) * a, Math.sin(ang) * a], [Math.cos(ang) * b, Math.sin(ang) * b]], false);
  }
}
function motif(ctx: Ctx2D, design: Design) {
  switch (design.motif) {
    case 'flower':
      circle(ctx, 0, 0, 0.84);
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        const px = (x + (Math.abs(y) % 2) * 0.5) * 0.29, py = y * 0.251;
        if (Math.hypot(px, py) <= 0.53) circle(ctx, px, py, 0.29);
      }
      circle(ctx, 0, 0, 0.78); break;
    case 'metatron': {
      const pts: [number, number][] = [[0, 0]];
      for (const r of [0.37, 0.73]) for (let i = 0; i < 6; i++) pts.push([Math.cos(TAU * i / 6) * r, Math.sin(TAU * i / 6) * r]);
      pts.forEach(([x, y]) => circle(ctx, x, y, 0.11));
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) poly(ctx, [pts[i], pts[j]], false);
      circle(ctx, 0, 0, 0.88); break;
    }
    case 'yantra':
      circle(ctx, 0, 0, 0.84); circle(ctx, 0, 0, 0.76); petals(ctx, 16, 0.60, 0.74);
      for (let i = 0; i < 9; i++) {
        const up = i % 2 === 0, r = 0.54 - i * 0.027;
        polygon(ctx, 3, r, up ? -Math.PI / 2 : Math.PI / 2);
      }
      circle(ctx, 0, 0, 0.023); break;
    case 'lotus':
      ctx.beginPath(); ctx.moveTo(0, 0.52);
      ctx.bezierCurveTo(-0.39, 0.12, -0.20, -0.40, 0, -0.69);
      ctx.bezierCurveTo(0.20, -0.40, 0.39, 0.12, 0, 0.52);
      ctx.moveTo(0, 0.52); ctx.bezierCurveTo(-0.68, 0.43, -0.70, -0.10, -0.52, -0.35);
      ctx.bezierCurveTo(-0.23, -0.18, -0.10, 0.15, 0, 0.52);
      ctx.moveTo(0, 0.52); ctx.bezierCurveTo(0.68, 0.43, 0.70, -0.10, 0.52, -0.35);
      ctx.bezierCurveTo(0.23, -0.18, 0.10, 0.15, 0, 0.52);
      ctx.moveTo(-0.72, 0.10); ctx.quadraticCurveTo(-0.58, 0.61, 0, 0.58);
      ctx.quadraticCurveTo(0.58, 0.61, 0.72, 0.10); ctx.stroke();
      circle(ctx, 0, 0, 0.86); rays(ctx, 24, 0.88, 0.92); break;
    case 'om':
      circle(ctx, 0, 0, 0.79); petals(ctx, 12, 0.68, 0.88);
      // A hand-drawn, font-independent Om-inspired form.
      ctx.beginPath(); ctx.moveTo(-0.50, -0.28); ctx.bezierCurveTo(-0.06, -0.55, 0.24, -0.24, 0.02, -0.02);
      ctx.bezierCurveTo(0.42, 0.03, 0.31, 0.54, -0.23, 0.47); ctx.bezierCurveTo(-0.44, 0.45, -0.53, 0.32, -0.48, 0.20);
      ctx.moveTo(-0.16, -0.01); ctx.bezierCurveTo(0.16, 0.02, 0.29, -0.04, 0.39, -0.24);
      ctx.moveTo(0.16, -0.52); ctx.quadraticCurveTo(0.32, -0.39, 0.48, -0.53); ctx.stroke();
      circle(ctx, 0.33, -0.64, 0.025); break;
    case 'mandala':
    case 'mandala-star':
      circle(ctx, 0, 0, 0.9); circle(ctx, 0, 0, 0.80); circle(ctx, 0, 0, 0.43); circle(ctx, 0, 0, 0.14);
      petals(ctx, design.motif === 'mandala' ? 16 : 12, 0.32, 0.78);
      petals(ctx, design.motif === 'mandala' ? 12 : 8, 0.14, 0.43);
      rays(ctx, 32, 0.81, 0.88);
      if (design.motif === 'mandala-star') { polygon(ctx, 8, 0.65); polygon(ctx, 8, 0.65, Math.PI / 8); }
      break;
    case 'chakra':
      circle(ctx, 0, 0, 0.79); circle(ctx, 0, 0, 0.42);
      petals(ctx, design.petals ?? 8, 0.42, 0.79);
      polygon(ctx, design.petals === 4 ? 4 : design.petals === 12 ? 6 : 3, 0.31);
      circle(ctx, 0, 0, 0.06); break;
    case 'sun':
      circle(ctx, 0, 0, 0.42); circle(ctx, 0, 0, 0.34); rays(ctx, 24, 0.50, 0.78); rays(ctx, 12, 0.80, 0.91);
      circle(ctx, 0, 0, 0.06); break;
    case 'moon':
      ctx.beginPath(); ctx.moveTo(0.28, -0.64);
      ctx.bezierCurveTo(-0.70, -0.82, -0.82, 0.58, 0.28, 0.64);
      ctx.bezierCurveTo(-0.12, 0.39, -0.12, -0.39, 0.28, -0.64); ctx.stroke();
      circle(ctx, 0.49, -0.27, 0.07); rays(ctx, 8, 0.78, 0.87); break;
    case 'star': {
      const points: [number, number][] = [];
      for (let i = 0; i < 16; i++) {
        const angle = -Math.PI / 2 + TAU * i / 16, radius = i % 2 === 0 ? 0.7 : 0.2;
        points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
      poly(ctx, points); circle(ctx, 0, 0, 0.83); circle(ctx, 0, 0, 0.11); rays(ctx, 16, 0.86, 0.92); break;
    }
    case 'planet':
      circle(ctx, 0, 0, 0.37);
      for (const tilt of [-0.4, 0.45]) { ctx.beginPath(); ctx.ellipse(0, 0, 0.88, 0.31, tilt, 0, TAU); ctx.stroke(); }
      circle(ctx, 0.67, -0.33, 0.06); circle(ctx, -0.61, 0.25, 0.04); break;
    case 'zodiac':
      circle(ctx, 0, 0, 0.88); circle(ctx, 0, 0, 0.62); circle(ctx, 0, 0, 0.30);
      rays(ctx, 12, 0.64, 0.86); polygon(ctx, 12, 0.54); polygon(ctx, 6, 0.34);
      for (let i = 0; i < 12; i++) {
        const a = (i + 0.5) * TAU / 12, x = Math.cos(a) * 0.75, y = Math.sin(a) * 0.75;
        circle(ctx, x, y, 0.025 + (i % 3) * 0.008);
      }
      circle(ctx, 0, 0, 0.08); break;
    case 'alchemy':
      circle(ctx, 0, 0, 0.87); polygon(ctx, 3, 0.73); polygon(ctx, 3, 0.73, Math.PI / 2);
      circle(ctx, 0, 0, 0.38); poly(ctx, [[-0.34, 0], [0.34, 0]], false); rays(ctx, 12, 0.78, 0.85); break;
    case 'mystic':
      circle(ctx, 0, 0, 0.86); circle(ctx, 0, 0, 0.68); polygon(ctx, 4, 0.62); polygon(ctx, 4, 0.62, 0);
      rays(ctx, 16, 0.70, 0.83); circle(ctx, 0, 0, 0.15); break;
    case 'rings':
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(0, 0, 0.85, 0.38, i * Math.PI / 4, 0, TAU); ctx.stroke(); }
      circle(ctx, 0, 0, 0.17); circle(ctx, 0, 0, 0.76); break;
    case 'lattice':
      circle(ctx, 0, 0, 0.87); polygon(ctx, 6, 0.76); polygon(ctx, 6, 0.76, 0);
      for (let i = 0; i < 6; i++) { ctx.save(); ctx.rotate(i * TAU / 6); polygon(ctx, 4, 0.52, 0); ctx.restore(); }
      circle(ctx, 0, 0, 0.26); break;
    case 'heart':
      ctx.beginPath(); ctx.moveTo(0, 0.56); ctx.bezierCurveTo(-0.91, 0.05, -0.62, -0.64, 0, -0.27);
      ctx.bezierCurveTo(0.62, -0.64, 0.91, 0.05, 0, 0.56); ctx.stroke(); circle(ctx, 0, 0, 0.83); rays(ctx, 20, 0.85, 0.92); break;
    case 'infinity':
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-0.75, -0.70, -0.85, 0.60, -0.40, 0.42);
      ctx.bezierCurveTo(-0.15, 0.34, 0.15, -0.34, 0.40, -0.42); ctx.bezierCurveTo(0.85, -0.60, 0.75, 0.70, 0, 0); ctx.stroke();
      circle(ctx, 0, 0, 0.82); rays(ctx, 24, 0.84, 0.91); break;
  }
}

function drawDesign(ctx: Ctx2D, d: EffectDrawContext, design: Design) {
  const u = frac(d.u + num(d.params, 'phase', 0)), angle = TAU * u;
  const kind = str(d.params, 'material', design.color ? 'custom' : 'gold');
  const custom = str(d.params, 'color', design.color ?? '#ffd97c');
  const [bright, dark, highlight] = kind === 'custom' ? [custom, custom, '#ffffff'] : palettes[kind] ?? palettes.gold;
  const glow = clamp(num(d.params, 'glow', 0.7), 0, 2);
  const fade = clamp(num(d.params, 'fade', 0.15), 0, 1);
  const pulse = clamp(num(d.params, 'pulse', 0.25), 0, 1);
  const breathing = 0.5 + 0.5 * Math.cos(angle);
  const alpha = (1 - fade * (1 - breathing)) * (kind === 'glass' ? 0.56 : 0.95);
  const x = d.w * (0.5 + num(d.params, 'sway', 0.04) * Math.sin(angle));
  const y = d.h * (0.5 + num(d.params, 'float', 0.06) * Math.sin(angle + Math.PI / 2));
  const r = Math.min(d.w, d.h) * 0.28 * (1 + num(d.params, 'depth', 0.08) * Math.sin(angle));
  if (glow > 0.01) glowDot(ctx, x, y, r * 1.6, bright, 0.08 * glow * alpha * (1 - pulse * (1 - breathing)));
  ctx.save(); ctx.translate(x, y);
  const dir = str(d.params, 'direction', 'clockwise');
  ctx.rotate(dir === 'still' ? 0 : (dir === 'counterclockwise' ? -angle : angle));
  ctx.scale(r * (1 - clamp(num(d.params, 'tiltY', 0.1), 0, 0.8) * (1 - Math.cos(angle)) / 2),
    r * (1 - clamp(num(d.params, 'tiltX', 0.12), 0, 0.8) * (1 - Math.cos(angle + Math.PI / 2)) / 2));
  ctx.globalAlpha *= alpha;
  const gradient = ctx.createLinearGradient(-0.8, -0.8, 0.8, 0.8);
  gradient.addColorStop(0, bright); gradient.addColorStop(0.45, dark); gradient.addColorStop(0.7, highlight); gradient.addColorStop(1, bright);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 0.012 * clamp(num(d.params, 'stroke', 1), 0.6, 2.5);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (glow > 0.01) { ctx.shadowColor = withAlpha(bright, Math.min(1, glow * 0.7)); ctx.shadowBlur = Math.min(12, 5 * glow * d.scale); }
  motif(ctx, design);
  ctx.restore();
  if (bool(d.params, 'particles', true)) {
    const trails = bool(d.params, 'trails', false);
    for (let i = 0; i < 12; i++) {
      const a = TAU * (u + pr(d.seed, i, 1));
      const distance = r * (1.15 + pr(d.seed, i, 2) * 0.3);
      const px = x + Math.cos(a) * distance, py = y + Math.sin(a) * distance;
      const brightness = alpha * (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(angle * 2 + i)));
      sparkleStar(ctx, px, py, Math.max(0.8, r * 0.025), highlight, brightness);
      if (trails) {
        ctx.strokeStyle = withAlpha(bright, brightness * 0.4); ctx.lineWidth = Math.max(0.4, r * 0.006);
        ctx.beginPath(); ctx.arc(x, y, distance, a - 0.11, a); ctx.stroke();
      }
    }
  }
}

export const SPIRITUAL_EFFECTS: EffectDef[] = DESIGNS.map((design) => ({
  id: `spiritual-${design.id}`, name: design.name, family: 'spiritual', subcategory: design.subcategory,
  description: `${design.subcategory}: a floating, editable vector ornament. Artistic interpretation.`,
  defaultLoop: 24, blend: 'source-over', params: params(design.color),
  draw: (ctx, d) => drawDesign(ctx, d, design),
}));
