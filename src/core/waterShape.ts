/** Editable eight-point mask in normalised coordinates of a water effect. */
import { clamp } from './util';

export interface WaterPoint { x: number; y: number }

export const DEFAULT_WATER_SHAPE: ReadonlyArray<WaterPoint> = [
  { x: 0.22, y: 0.05 }, { x: 0.78, y: 0.05 },
  { x: 0.95, y: 0.25 }, { x: 0.95, y: 0.75 },
  { x: 0.78, y: 0.95 }, { x: 0.22, y: 0.95 },
  { x: 0.05, y: 0.75 }, { x: 0.05, y: 0.25 },
];

/** Invalid or older projects get a safe default, rather than a broken mask. */
export function readWaterShape(value: unknown): WaterPoint[] {
  if (typeof value === 'string') {
    try {
      const points: unknown = JSON.parse(value);
      if (Array.isArray(points) && points.length === 8 && points.every((p) =>
        p && typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1
        && typeof p.y === 'number' && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1)) {
        return points.map((p) => ({ x: p.x, y: p.y }));
      }
    } catch { /* use default */ }
  }
  return DEFAULT_WATER_SHAPE.map((p) => ({ ...p }));
}

export function traceWaterShape(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: WaterPoint[], width: number, height: number,
) {
  ctx.beginPath();
  ctx.moveTo(points[0].x * width, points[0].y * height);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * width, points[i].y * height);
  ctx.closePath();
}

/** Fade a wave highlight inside the polygon, not across a shoreline. */
export function waterShapeFeather(x: number, y: number, width: number, height: number, points: WaterPoint[]): number {
  let inside = false, distance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    const ax = a.x * width, ay = a.y * height, bx = b.x * width, by = b.y * height;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax, dy = by - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / Math.max(1e-12, dx * dx + dy * dy), 0, 1);
    distance = Math.min(distance, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return inside ? clamp(distance / Math.max(1, Math.min(width, height) * 0.1), 0, 1) : 0;
}
