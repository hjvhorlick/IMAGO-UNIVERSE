/**
 * SCENE COMPOSITION
 * =================
 * Places assets so the environment reads as a physical place rather than a
 * pile of pictures:
 *
 *  - every grounded object's base sits on the ground line for its depth
 *  - depth drives scale, so distant things are smaller
 *  - paint order follows depth, so near things occlude far things
 *  - foreground vegetation deliberately overhangs the canvas edges
 *  - locked objects are never touched, which is what makes controlled
 *    regeneration safe
 *
 * Only assets from the active style are ever considered, so an automatic
 * composition can never introduce a style clash.
 */
import type { AssetLibrary } from '../assets/library';
import type { AssetMeta, Scene, SceneNode } from '../core/types';
import { clamp, lerp, rng } from '../core/util';
import { createAssetNode, groundLine, nextOrder } from './sceneModel';

export interface ComposeOptions {
  seed: number;
  density: 'sparse' | 'balanced' | 'lush';
  structures: boolean;
  water: boolean;
  foreground: number;        // 0..1
  jitterPosition: number;    // 0..1
  jitterSize: number;        // 0..1
  jitterRotation: number;    // 0..1
  replaceUnlocked: boolean;
  setBackground: boolean;
  suggestLighting: boolean;
}

export const DEFAULT_COMPOSE: ComposeOptions = {
  seed: 1234, density: 'balanced', structures: true, water: true,
  foreground: 0.6, jitterPosition: 0.5, jitterSize: 0.4, jitterRotation: 0.25,
  replaceUnlocked: true, setBackground: true, suggestLighting: true,
};

export interface ComposeResult {
  added: number;
  kept: number;
  removed: number;
  backgroundId?: string;
}

const DENSITY_COUNT = { sparse: 0.6, balanced: 1, lush: 1.6 } as const;

export function autoCompose(scene: Scene, library: AssetLibrary, opts: ComposeOptions): ComposeResult {
  const r = rng(opts.seed);
  const style = scene.styleId;
  const pool = library.forStyle(style);
  if (!pool.length) return { added: 0, kept: 0, removed: 0 };

  const result: ComposeResult = { added: 0, kept: 0, removed: 0 };
  const locked = scene.nodes.filter((n) => n.locked);
  result.kept = locked.length;

  if (opts.replaceUnlocked) {
    const before = scene.nodes.length;
    scene.nodes = scene.nodes.filter((n) => n.locked || n.kind === 'effect');
    result.removed = before - scene.nodes.length;
  }

  const cw = scene.canvas.width, ch = scene.canvas.height;
  const mult = DENSITY_COUNT[opts.density];

  /* ------------------------------------------------------------ layer 1 */
  let background = scene.nodes.find((n) => n.layer === 'background');
  if (!background && opts.setBackground) {
    const bgs = pool.filter((a) => a.layer === 'background');
    if (bgs.length) {
      const meta = bgs[Math.floor(r() * bgs.length)];
      background = createAssetNode(meta, scene);
      background.locked = true;
      scene.nodes.push(background);
      result.added++;
      result.backgroundId = meta.id;
    }
  }
  if (background) result.backgroundId = background.assetId;
  const bgMeta = library.get(background?.assetId);
  const hasWater = !!bgMeta && (bgMeta.themes.includes('water') || bgMeta.tags.includes('lake'));

  const occupied: { x: number; depth: number; w: number }[] = [];
  const claim = (x: number, depth: number, w: number) => occupied.push({ x, depth, w });
  const isFree = (x: number, depth: number, w: number) =>
    !occupied.some((o) => Math.abs(o.depth - depth) < 0.12 && Math.abs(o.x - x) < (o.w + w) * 0.42);

  const place = (
    meta: AssetMeta, xNorm: number, depth: number, scaleJitter = 1, baseScale = 1,
  ): SceneNode | null => {
    const jitterX = (r() - 0.5) * 0.08 * opts.jitterPosition;
    const scale = baseScale * (1 + (r() - 0.5) * 0.5 * opts.jitterSize * scaleJitter);
    const node = createAssetNode(meta, scene, {
      x: clamp(xNorm + jitterX, -0.2, 1.2) * cw,
      depth, scale,
    });
    node.y = groundLine(scene, depth) - node.height * meta.groundContact + node.height * 0.5;
    node.rotation = (r() - 0.5) * 8 * opts.jitterRotation;
    node.flipX = r() > 0.5;
    node.order = nextOrder(scene, meta.layer);
    // Atmospheric depth: distant objects pick up a little haze.
    node.adjust.haze = clamp(lerp(0.16, 0, depth), 0, 1);
    scene.nodes.push(node);
    claim(node.x, depth, node.width);
    result.added++;
    return node;
  };

  const storyTheme = bgMeta?.themes.find((theme) => ['fairy', 'norse', 'chinese', 'japanese'].includes(theme));
  const pick = (list: AssetMeta[]): AssetMeta | undefined => {
    if (!list.length) return undefined;
    // Cultural/fantasy set pieces are picked to match their backdrop instead of
    // being mixed randomly into an unrelated story-world composition.
    const themed = storyTheme ? list.filter((asset) => asset.themes.includes(storyTheme)) : [];
    const candidates = themed.length ? themed : list;
    return candidates[Math.floor(r() * candidates.length)];
  };

  /* ------------------------------------------------------------ layer 2 */
  const mid = pool.filter((a) => a.layer === 'middle');
  const trees = mid.filter((a) => a.category === 'trees');
  const structures = mid.filter((a) => a.category === 'structures' || a.category === 'landmarks');
  const rocks = mid.filter((a) => a.category === 'rocks');
  const water = mid.filter((a) => a.category === 'water');

  // Treat a waterfall as a scene-scale focal point, not a small prop tucked to
  // one side. Its broad water curtain stays centered and enlarged; supporting
  // scenery is pushed to the margins and foreground is kept out of its pool.
  const placedWater = opts.water && hasWater
    ? (water.find((a) => a.rig?.type === 'fall') ?? pick(water))
    : undefined;
  const waterfallHero = placedWater?.rig?.type === 'fall';
  const heroSide = waterfallHero
    ? (r() > 0.5 ? 0.08 : 0.92)
    : (r() > 0.5 ? 0.22 : 0.78);
  const hero = pick(trees);
  if (hero && !locked.some((n) => n.layer === 'middle' && library.get(n.assetId)?.category === 'trees')) {
    place(hero, heroSide, 0.42, 0.6);
  }
  if (waterfallHero) {
    const wNode = place(placedWater!, 0.5, 0.46, 0.2, 1.32);
    if (wNode) wNode.rotation = 0;
  } else if (placedWater) {
    const wNode = place(placedWater, heroSide > 0.5 ? 0.27 : 0.73, 0.46, 0.3);
    if (wNode) wNode.rotation = 0;
  }
  // A bridge or pavilion across the impact line defeats the entire waterfall
  // focal point. Omit structures in automatic waterfall showcases.
  if (opts.structures && !waterfallHero) {
    const s = pick(structures);
    if (s && !locked.some((n) => library.get(n.assetId)?.category === 'structures')) {
      const sx = placedWater ? (heroSide > 0.5 ? 0.62 : 0.38) : (heroSide > 0.5 ? 0.34 : 0.66);
      place(s, sx, 0.52);
    }
  }
  const extraTrees = waterfallHero ? 0 : Math.round(1 * mult);
  for (let i = 0; i < extraTrees; i++) {
    const t = pick(trees);
    if (!t) break;
    const x = 0.1 + r() * 0.8;
    const depth = 0.2 + r() * 0.2;
    if (isFree(x * cw, depth, cw * 0.2)) place(t, x, depth, 1);
  }
  const rockCount = waterfallHero ? 0 : Math.round((1 + r() * 2) * mult);
  for (let i = 0; i < rockCount; i++) {
    const rk = pick(rocks);
    if (!rk) break;
    const x = 0.08 + r() * 0.84;
    const depth = 0.5 + r() * 0.25;
    if (isFree(x * cw, depth, cw * 0.12)) place(rk, x, depth, 1);
  }

  /* ------------------------------------------------------------ layer 3 */
  const fg = pool.filter((a) => a.layer === 'foreground');
  const grasses = fg.filter((a) => a.category === 'grass');
  const flowers = fg.filter((a) => a.category === 'flowers');
  const plants = fg.filter((a) => a.category === 'plants');
  const ground = fg.filter((a) => a.category === 'ground');

  const fgCount = Math.round((6 + opts.foreground * 12) * mult);
  for (let i = 0; i < fgCount; i++) {
    const roll = r();
    const meta = roll < 0.5 ? pick(grasses)
      : roll < 0.68 ? pick(flowers)
        : roll < 0.88 ? pick(plants) : pick(ground);
    if (!meta) continue;
    // Bias towards the edges so the middle of the scene stays readable, and
    // let a good share of them run off the canvas entirely.
    const edgeBias = r();
    let x: number;
    if (waterfallHero) {
      x = edgeBias < 0.5 ? -0.12 + r() * 0.22 : 0.90 + r() * 0.22;
    } else if (edgeBias < 0.34) x = -0.08 + r() * 0.3;
    else if (edgeBias < 0.68) x = 0.78 + r() * 0.3;
    else x = 0.15 + r() * 0.7;
    const depth = 0.78 + r() * 0.22;
    const node = place(meta, x, depth, 1.2);
    if (node) {
      node.order = nextOrder(scene, 'foreground');
      // Nearer plants overlap the bases of middle-ground objects.
      node.adjust.haze = 0;
    }
  }
  // A continuous ground line of ivy / stones right at the bottom edge.
  const groundMeta = pick(ground);
  if (groundMeta && !waterfallHero) {
    for (let i = 0; i < Math.round(2 * mult); i++) {
      place(groundMeta, 0.1 + i * 0.45 + r() * 0.1, 0.99, 0.8);
    }
  }

  // Give story-world backdrops one unmistakable matching foreground accent,
  // then paint it last so it frames rather than disappears under generic foliage.
  if (storyTheme) {
    const storyAccent = pick(fg.filter((asset) => asset.themes.includes(storyTheme)));
    if (storyAccent) {
      const x = storyTheme === 'norse' || storyTheme === 'chinese' ? 0.16 : 0.84;
      place(storyAccent, x, 0.9, 0.25, 1.05);
    }
  }

  /* -------------------------------------------------------------- light */
  if (opts.suggestLighting && bgMeta) {
    const night = bgMeta.themes.includes('night');
    scene.lighting.lightColor = night ? '#9fc4ff' : '#ffd9a0';
    scene.lighting.lightAngle = night ? 45 : 315;
    scene.lighting.warmth = night ? -0.18 : 0.12;
    scene.lighting.ambient = night ? 0.16 : 0.1;
    scene.lighting.haze = night ? 0.1 : 0.06;
    scene.lighting.rays = night ? 0.12 : 0.2;
    scene.lighting.vignette = 0.2;
  }

  void ch;
  return result;
}

/** Re-roll only the unlocked parts of an existing composition. */
export function regenerate(scene: Scene, library: AssetLibrary, opts: ComposeOptions): ComposeResult {
  return autoCompose(scene, library, { ...opts, seed: Math.floor(Math.random() * 1e9), replaceUnlocked: true });
}

/** Nudge every grounded object back onto its ground line after edits. */
export function reground(scene: Scene, library: AssetLibrary, only?: string[]) {
  for (const n of scene.nodes) {
    if (n.kind !== 'asset' || n.layer === 'background' || n.locked) continue;
    if (only && !only.includes(n.id)) continue;
    const meta = library.get(n.assetId);
    if (!meta) continue;
    n.y = groundLine(scene, n.depth) - n.height * meta.groundContact + n.height * 0.5;
  }
}

/** Sort paint order by depth so occlusion matches the intended perspective. */
export function sortByDepth(scene: Scene) {
  for (const layer of ['middle', 'foreground'] as const) {
    const peers = scene.nodes.filter((n) => n.layer === layer).sort((a, b) => a.depth - b.depth);
    peers.forEach((n, i) => { n.order = i; });
  }
}
