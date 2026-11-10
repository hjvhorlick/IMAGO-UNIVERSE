/**
 * Worlds and world categories.
 *
 * A WORLD is a kind of place - a lake, a fairy court, an observatory garden.
 * Each world can appear in one or more LOOKS (the artistic styles: enchanted,
 * moonlit, autumn). The look only changes the palette and light; the place
 * stays the same.
 *
 * A world's background is the only thing a new world starts with. Everything
 * else is added by the designer, and may repeat.
 */
import type { AssetLibrary } from '../assets/library';
import type { AssetMeta, Scene } from '../core/types';
import { createAssetNode, createScene } from './sceneModel';

export interface WorldCategory {
  id: string;
  name: string;
  /** Shown under the category heading when it has no worlds yet. */
  note?: string;
  /** World ids (the background file name, e.g. "enchanted-lake"). */
  worlds: string[];
}

/**
 * The categories a designer chooses from. Every background in the library must
 * be listed in exactly one category; the test suite enforces this.
 */
export const WORLD_CATEGORIES: WorldCategory[] = [
  { id: 'woodland', name: 'Woodland & lakes',
    worlds: ['enchanted-lake', 'forest-hollow', 'fairy-court', 'autumn-river', 'harvest-hollow'] },
  { id: 'highlands', name: 'Highlands & mountains',
    worlds: ['crystal-highlands', 'chinese-mist-mountains', 'norse-worldtree', 'frostfall-valley'] },
  { id: 'water', name: 'Water & shores',
    worlds: ['mythic-waterside', 'lotus-sanctuary', 'frozen-lake'] },
  { id: 'gardens', name: 'Gardens & skies',
    worlds: ['japanese-moon-garden', 'celestial-observatory'] },
  { id: 'night', name: 'Night',
    worlds: ['moonlit-glade', 'night-valley'] },
  { id: 'realistic', name: 'Realistic',
    worlds: ['clearwater-lake', 'forest-stream',
      'zen-pond', 'misty-dawn-lake', 'bamboo-stream', 'zen-garden', 'wildflower-meadow',
      'lavender-fields', 'creek-meadow', 'granite-tarn', 'rocky-coast-cove', 'still-forest-pool'],
    note: 'Photographic worlds. More can be added here as they are painted.' },
];

export interface World {
  id: string;
  name: string;
  categoryId: string;
  /** Style ids this world is available in, in library order. */
  looks: string[];
}

/** The world id of a background asset: its file name without the style prefix. */
export function worldIdOf(meta: AssetMeta): string {
  return meta.id.split('.').pop() ?? meta.id;
}

/** The background asset for a world in a given look, if that look exists. */
export function backgroundFor(library: AssetLibrary, worldId: string, styleId: string): AssetMeta | undefined {
  return library.get(`${styleId}.background.${worldId}`);
}

/** Every world in the library, grouped by category. Worlds with no category go to "other". */
export function listWorlds(library: AssetLibrary): World[] {
  const backgrounds = library.assets.filter((a) => a.layer === 'background');
  const styleOrder = library.styles.map((s) => s.id);
  const byId = new Map<string, AssetMeta[]>();
  for (const bg of backgrounds) {
    const id = worldIdOf(bg);
    byId.set(id, [...(byId.get(id) ?? []), bg]);
  }
  const categoryOf = (worldId: string) =>
    WORLD_CATEGORIES.find((c) => c.worlds.includes(worldId))?.id ?? 'other';

  const worlds: World[] = [];
  for (const [id, metas] of byId) {
    const sorted = [...metas].sort((a, b) =>
      (styleOrder.indexOf(a.style) === -1 ? 99 : styleOrder.indexOf(a.style))
      - (styleOrder.indexOf(b.style) === -1 ? 99 : styleOrder.indexOf(b.style)));
    worlds.push({
      id,
      name: sorted[0].name,
      categoryId: categoryOf(id),
      looks: sorted.map((m) => m.style),
    });
  }
  // Category order first, then the order the categories are listed in.
  const rank = (cid: string) => {
    const i = WORLD_CATEGORIES.findIndex((c) => c.id === cid);
    return i === -1 ? WORLD_CATEGORIES.length : i;
  };
  return worlds.sort((a, b) => rank(a.categoryId) - rank(b.categoryId) || a.name.localeCompare(b.name));
}

/**
 * A new scene holding ONLY the chosen background. Nothing else is placed, so
 * the designer starts from the place itself and adds what they want.
 */
export function createWorldScene(library: AssetLibrary, opts: {
  worldId: string; styleId: string; aspect?: string; name?: string;
}): Scene {
  const meta = backgroundFor(library, opts.worldId, opts.styleId);
  if (!meta) throw new Error(`"${opts.worldId}" is not available in the "${opts.styleId}" look.`);
  const scene = createScene(opts.styleId, opts.name ?? meta.name, opts.aspect ?? '16:9');
  const bg = createAssetNode(meta, scene);
  bg.locked = true;
  scene.nodes = [bg];
  scene.worldId = opts.worldId;
  return scene;
}
