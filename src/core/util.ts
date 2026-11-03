/** Small maths / random / colour helpers shared by every module. */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const rad = (deg: number) => (deg * Math.PI) / 180;
export const deg = (r: number) => (r * 180) / Math.PI;
export const round = (v: number, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

let idCounter = 0;
export function uid(prefix = 'n'): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/** Deterministic PRNG (mulberry32). Same seed => same scene, every time. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Exactly-periodic organic noise.
 *
 * Built from integer harmonics of the cycle, so `periodic(u)` === `periodic(u+1)`
 * for any u. This is the foundation of the seamless-loop guarantee: no matter how
 * turbulent the motion looks, it lands back on its starting value at the boundary.
 */
export function periodic(u: number, seed: number, harmonics = 4, roughness = 0.55): number {
  const r = rng(seed);
  let sum = 0, norm = 0, amp = 1;
  for (let k = 1; k <= harmonics; k++) {
    const phase = r() * TAU;
    sum += Math.sin(TAU * k * u + phase) * amp;
    norm += amp;
    amp *= roughness;
  }
  return sum / (norm || 1);
}

/** Two-dimensional periodic noise, useful for canopies and water surfaces. */
export function periodic2(u: number, x: number, y: number, seed: number, harmonics = 3): number {
  const r = rng(seed);
  let sum = 0, norm = 0, amp = 1;
  for (let k = 1; k <= harmonics; k++) {
    const fx = Math.round(1 + r() * 2) * k;
    const fy = Math.round(r() * 2) * k;
    const phase = r() * TAU;
    sum += Math.sin(TAU * (k * u) + fx * x * 2.1 + fy * y * 1.7 + phase) * amp;
    norm += amp; amp *= 0.6;
  }
  return sum / (norm || 1);
}

/** Wrap a value into 0..1 - used for particle lifetimes so re-entry is seamless. */
export const frac = (v: number) => v - Math.floor(v);

/* --------------------------------------------------------------- colour */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(lerp(v, B[i], t)));
  return `#${c.map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

/* ------------------------------------------------------------- geometry */

export interface Rect { x: number; y: number; w: number; h: number }

export function rotatePoint(px: number, py: number, cx: number, cy: number, angle: number) {
  const s = Math.sin(angle), c = Math.cos(angle);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }
export function lcm(a: number, b: number): number { return Math.abs(a * b) / (gcd(a, b) || 1); }

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function deepClone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}
