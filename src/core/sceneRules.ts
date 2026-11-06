/**
 * Scene-wide rules that every path that touches the node list must respect.
 *
 * The one hard rule: a scene has exactly one background. Every other kind of
 * element (trees, rocks, bushes, flowers, effects) may repeat as often as the
 * designer likes.
 */
import type { SceneNode } from './types';

export function isBackground(node: SceneNode): boolean {
  return node.layer === 'background';
}

/**
 * Keep only the first background in a node list. Returns the cleaned list and
 * how many extra backgrounds were dropped. Non-background nodes are untouched.
 */
export function withSingleBackground(nodes: SceneNode[]): { nodes: SceneNode[]; removed: number } {
  let seen = false;
  let removed = 0;
  const kept = nodes.filter((n) => {
    if (!isBackground(n)) return true;
    if (seen) { removed++; return false; }
    seen = true;
    return true;
  });
  return { nodes: kept, removed };
}
