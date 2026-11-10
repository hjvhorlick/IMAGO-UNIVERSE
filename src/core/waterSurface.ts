import { frac, TAU } from './util';

/** A finer mesh resolves small ripples in both the live preview and export. */
export function waterMeshResolution(quality: 'preview' | 'export'): { cols: number; rows: number } {
  return quality === 'export' ? { cols: 52, rows: 36 } : { cols: 36, rows: 24 };
}

/** Crest dimensions in local canvas coordinates. Longer crests retain the
 * same height; only the reflective edge is made finer. */
export function waterCrestSpan(width: number, length: number, variation: number): number {
  return width * (0.018 + 0.042 * variation) * length * 2;
}

export function waterCrestStrokeWidths(height: number, scale: number): { edge: number; glint: number } {
  const pixelScale = Math.max(scale, 0.1);
  return { edge: Math.max(0.38 / pixelScale, height * 0.18),
    glint: Math.max(0.25 / pixelScale, height * 0.08) };
}

/** A shared little surface wave. Lake crests sway sideways with a small bob;
 * river crests do the same while travelling through the chosen direction.
 * The river fades at its wrap boundary so its motion loops without a jump. */
export function waterCrestPosition(
  seedX: number, seedY: number, phase: number, u: number, rate: number,
  mode: 'lake-waves' | 'river', direction: unknown,
): { x: number; y: number; life: number } {
  const t = u * rate;
  const sideways = 0.025 * Math.sin(TAU * (t + phase));
  const bob = 0.004 * Math.sin(TAU * (2 * t + phase));
  if (mode === 'lake-waves') return { x: seedX + sideways, y: seedY + bob, life: 1 };
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const travel = frac((vertical ? seedY : seedX) + sign * t);
  return { x: (vertical ? seedX : travel) + sideways,
    y: (vertical ? travel : seedY) + bob,
    life: Math.min(1, travel * 12, (1 - travel) * 12) };
}

/** Keep the reflection much steadier than the surface crests. Both axes use
 * the area's height so a wide lake cannot amplify sideways image movement. */
export function waterReflectionDisplacement(
  wave: { x: number; y: number }, height: number, strength: number, edge: number, length: number,
): { dx: number; dy: number } {
  const amount = height * strength * edge * Math.min(1, length);
  return { dx: amount * wave.x * 0.08, dy: amount * wave.y * 0.28 };
}

/** The same rippling surface for lake and river. Lake water sways sideways;
 * river wave patterns travel downstream. Displacements stay local, so the
 * photograph underneath heaves instead of its entire reflection sliding. */
export function waterSurfaceWarp(
  x: number, y: number, u: number, rate: number, length: number,
  mode: 'lake-waves' | 'river', direction: unknown,
): { x: number; y: number } {
  const time = u * rate;
  const vertical = mode === 'river' && (direction === 'up' || direction === 'down');
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const along = vertical ? y : x, across = vertical ? x : y;
  // Lake waves move back and forth rather than continuously rising. The river
  // uses the identical wave field, translated in phase in its flow direction.
  const travel = mode === 'river' ? sign * time : 0.2 * Math.sin(TAU * time);
  const a = TAU * ((along * 3.0 + 0.55 * Math.sin(TAU * across)) / length - travel);
  const b = TAU * ((along * 4.6 - across * 1.7) / length - travel * 2);
  const c = TAU * ((along * 2.2 + across * 2.1) / length - travel * 3);
  const detail = TAU * ((along * 7.2 - across * 2.4) / length - travel * 4);
  const heave = 0.035 * Math.sin(a) + 0.014 * Math.sin(b) + 0.007 * Math.sin(c) + 0.003 * Math.sin(detail);
  const sway = 0.035 * Math.sin(a + 0.7) + 0.014 * Math.sin(b - 0.8) + 0.003 * Math.sin(detail);
  return vertical ? { x: sway, y: heave * 0.5 } : { x: heave, y: sway * 0.5 };
}
