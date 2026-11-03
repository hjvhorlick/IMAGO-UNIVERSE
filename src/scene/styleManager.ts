/**
 * STYLE MANAGER
 * =============
 * Owns the rule that makes the first three layers look like one artwork:
 * an asset may only appear in a scene whose style matches its own.
 *
 * Layer 4 is deliberately outside this system - atmospheric effects are
 * universal and are never swapped, filtered or removed by a style change.
 */
import type { AssetLibrary } from '../assets/library';
import type { AssetMeta, Scene, SceneNode, StyleMeta } from '../core/types';
import { hashString } from '../core/util';

export interface StyleSwitchReport {
  swapped: number;
  removed: string[];
  keptEffects: number;
  style: StyleMeta | undefined;
}

/** The five-piece reference collection that must exist before a style expands. */
export function referenceCollection(library: AssetLibrary, style: StyleMeta): AssetMeta[] {
  const ids = [style.reference.background, style.reference.tree, style.reference.structure,
    style.reference.plant, style.reference.ground];
  return ids.map((id) => library.get(id)).filter(Boolean) as AssetMeta[];
}

export function styleStats(library: AssetLibrary, styleId: string) {
  const assets = library.forStyle(styleId);
  return {
    total: assets.length,
    background: assets.filter((a) => a.layer === 'background').length,
    middle: assets.filter((a) => a.layer === 'middle').length,
    foreground: assets.filter((a) => a.layer === 'foreground').length,
    categories: new Set(assets.map((a) => a.category)).size,
  };
}

/**
 * Move a scene to another style. Objects are matched by category so a tree
 * stays a tree; anything with no counterpart is removed rather than left as a
 * style clash. All transforms, animation settings and effects survive.
 */
export function switchStyle(scene: Scene, library: AssetLibrary, newStyleId: string): StyleSwitchReport {
  const report: StyleSwitchReport = {
    swapped: 0, removed: [], keptEffects: 0, style: library.style(newStyleId),
  };
  if (scene.styleId === newStyleId) {
    report.keptEffects = scene.nodes.filter((n) => n.kind === 'effect').length;
    return report;
  }
  const target = library.forStyle(newStyleId);
  const keep: SceneNode[] = [];

  for (const node of scene.nodes) {
    if (node.kind === 'effect') { keep.push(node); report.keptEffects++; continue; }
    const current = library.get(node.assetId);
    if (!current) { report.removed.push(node.name); continue; }
    if (current.style === newStyleId) { keep.push(node); continue; }

    let candidates = target.filter((a) => a.layer === current.layer && a.category === current.category);
    if (!candidates.length) candidates = target.filter((a) => a.layer === current.layer);
    if (!candidates.length) { report.removed.push(node.name); continue; }

    const next = candidates[hashString(node.id) % candidates.length];
    const ratio = next.width / next.height;
    node.assetId = next.id;
    node.name = next.name;
    node.height = Math.max(8, node.height);
    node.width = node.height * ratio;
    if (next.layer === 'background') {
      const cover = Math.max(scene.canvas.width / next.width, scene.canvas.height / next.height);
      node.width = next.width * cover;
      node.height = next.height * cover;
      node.x = scene.canvas.width / 2;
      node.y = scene.canvas.height / 2;
    }
    report.swapped++;
    keep.push(node);
  }

  scene.nodes = keep;
  scene.styleId = newStyleId;
  return report;
}

/** Audit: any asset in layers 1-3 whose style does not match the scene. */
export function findStyleClashes(scene: Scene, library: AssetLibrary): SceneNode[] {
  return scene.nodes.filter((n) => {
    if (n.kind !== 'asset') return false;
    const meta = library.get(n.assetId);
    return !!meta && meta.style !== scene.styleId && meta.style !== 'universal';
  });
}
