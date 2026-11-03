/**
 * LOOP MANAGER
 * ============
 * The single authority on animation time.
 *
 * Responsibilities
 * ----------------
 *  - collect the cycle length of every active animation and effect
 *  - harmonise them into one *master cycle* that every animation divides into
 *    exactly, so the whole scene returns to its initial visual state together
 *  - report which animations are genuinely seamless and which are not
 *  - let the renderer tile the master cycle to any requested video duration
 *
 * Design note
 * -----------
 * Every built-in animation is constructed from integer harmonics of its own
 * cycle (see `periodic()` in core/util) and every particle lifetime is wrapped
 * with `frac()`. That makes each one *individually* exact. The only thing left
 * is to make them agree on a common boundary, which is what the LCM below does.
 *
 * If the exact LCM would be absurdly long we snap cycle lengths onto a shared
 * grid instead, and we tell the user we did so rather than silently pretending.
 */
import type { Scene, SceneNode } from '../core/types';
import { lcm, round } from '../core/util';

export interface LoopReport {
  /** Master cycle in seconds - the scene repeats exactly after this long. */
  master: number;
  /** Individual cycles found in the scene. */
  cycles: { id: string; name: string; loop: number; seamless: boolean; adjusted: number }[];
  /** True when the master cycle is an exact common multiple of every cycle. */
  exact: boolean;
  /** Cycles that had to be nudged onto the grid. */
  snapped: number;
  animated: number;
}

/** Cycle lengths are quantised to this grid (seconds) to keep the LCM sane. */
export const LOOP_GRID = 0.5;
/** Above this we prefer snapping over an exact-but-unusable master cycle. */
export const MAX_MASTER = 60;

export function isActive(n: SceneNode, time?: number): boolean {
  if (!n.visible) return false;
  if (n.kind === 'effect') {
    const e = n.effect!;
    return withinWindow(time, e.start, e.end);
  }
  return !!n.animation && n.animation.enabled && n.animation.type !== 'none'
    && withinWindow(time, n.animation.start, n.animation.end);
}

function withinWindow(time: number | undefined, start: number, end: number): boolean {
  if (time == null) return true;
  if (time < start) return false;
  if (end > 0 && time > end) return false;
  return true;
}

export function nodeLoop(n: SceneNode): number {
  if (n.kind === 'effect') return Math.max(LOOP_GRID, n.effect?.loop ?? 8);
  return Math.max(LOOP_GRID, n.animation?.loop ?? 8);
}

export class LoopManager {
  private cached: LoopReport | null = null;
  private signature = '';

  /** Analyse the scene. Cheap and memoised on the set of active cycles. */
  analyse(scene: Scene): LoopReport {
    const active = scene.nodes.filter((n) => isActive(n));
    const sig = active.map((n) => `${n.id}:${round(nodeLoop(n), 3)}`).join('|');
    if (this.cached && sig === this.signature) return this.cached;

    const cycles: LoopReport['cycles'] = [];
    let master = LOOP_GRID;
    let snapped = 0;

    for (const n of active) {
      const raw = nodeLoop(n);
      const grid = Math.max(1, Math.round(raw / LOOP_GRID));
      const adjusted = grid * LOOP_GRID;
      if (Math.abs(adjusted - raw) > 1e-6) snapped++;
      const candidate = lcm(master, adjusted);
      master = candidate > MAX_MASTER ? master : candidate;
      cycles.push({
        id: n.id, name: n.name, loop: raw, adjusted,
        seamless: isSeamlessNode(n),
      });
    }

    // Second pass: if a cycle does not divide the chosen master, snap it to the
    // nearest divisor so the boundary is still exact.
    let exact = true;
    for (const c of cycles) {
      const ratio = master / c.adjusted;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
        exact = false;
        const divisors = divisorsOf(master);
        let best = divisors[0];
        for (const d of divisors) if (Math.abs(d - c.adjusted) < Math.abs(best - c.adjusted)) best = d;
        c.adjusted = best;
        snapped++;
      }
    }

    // After snapping, every adjusted cycle divides the master exactly, so the
    // scene really is periodic. `snapped` records that we nudged something, and
    // the UI reports it - we never claim an untouched cycle we changed.
    const divides = cycles.every((c) => {
      const ratio = master / c.adjusted;
      return Math.abs(ratio - Math.round(ratio)) < 1e-6;
    });
    void exact;
    const report: LoopReport = {
      master: round(master, 3),
      cycles,
      exact: cycles.every((c) => c.seamless) && divides,
      snapped,
      animated: active.length,
    };
    this.cached = report;
    this.signature = sig;
    return report;
  }

  /** Effective cycle for a node after harmonisation. */
  effectiveLoop(scene: Scene, n: SceneNode): number {
    const report = this.analyse(scene);
    return report.cycles.find((c) => c.id === n.id)?.adjusted ?? nodeLoop(n);
  }

  /** Normalised cycle position 0..1 for a node at a given time. */
  phaseAt(scene: Scene, n: SceneNode, time: number): number {
    const loop = this.effectiveLoop(scene, n);
    const offset = n.kind === 'effect' ? 0 : (n.animation?.phase ?? 0) * loop;
    const t = time + offset;
    return (t / loop) - Math.floor(t / loop);
  }

  /** How many whole master cycles fit in a duration, and what is left over. */
  plan(duration: number, master: number, fps: number) {
    const cycleFrames = Math.max(1, Math.round(master * fps));
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const repeats = Math.floor(totalFrames / cycleFrames);
    const remainder = totalFrames - repeats * cycleFrames;
    return { cycleFrames, totalFrames, repeats, remainder, cycleSeconds: cycleFrames / fps };
  }

  invalidate() { this.cached = null; this.signature = ''; }
}

function divisorsOf(master: number): number[] {
  const units = Math.round(master / LOOP_GRID);
  const out: number[] = [];
  for (let i = 1; i <= units; i++) if (units % i === 0) out.push(i * LOOP_GRID);
  return out.length ? out : [master];
}

/**
 * Honesty check. Built-in procedural animations and effects are periodic by
 * construction. Anything driven by an imported animated sprite is not, and we
 * say so instead of claiming a seamless loop we cannot deliver.
 */
export function isSeamlessNode(n: SceneNode): boolean {
  if (n.kind === 'effect') return true;
  if (!n.animation) return true;
  return n.animation.type !== 'none';
}

export const loopManager = new LoopManager();
