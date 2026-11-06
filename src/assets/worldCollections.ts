import type { AssetMeta } from '../core/types';

/** Browse groupings, not new artwork or claims of cultural authenticity.
 * Backgrounds use their story tag; objects can also share suitable materials
 * and settings. Interiors remain usable with every world. */
export const WORLD_COLLECTIONS = [
  { id: 'nature', label: 'Nature & landscapes', shared: ['forest', 'meadow', 'water', 'garden', 'kingdom'] },
  { id: 'fairy', label: 'Fairy woodland', shared: ['fairy', 'forest'] },
  { id: 'norse', label: 'Norse inspired', shared: ['norse', 'forest', 'water'] },
  { id: 'chinese', label: 'Chinese inspired', shared: ['chinese', 'garden', 'mountains'] },
  { id: 'japanese', label: 'Japanese inspired', shared: ['japanese', 'garden', 'water'] },
  { id: 'observatory', label: 'Celestial observatory', shared: ['observatory', 'celestial', 'garden'] },
  { id: 'waterside', label: 'Mythic waterside', shared: ['waterside', 'water', 'forest'] },
  { id: 'lotus-sanctuary', label: 'Lotus sanctuary', shared: ['lotus-sanctuary', 'meditation', 'garden', 'water'] },
] as const;

export function collectionId(theme: string): string {
  return WORLD_COLLECTIONS.some((group) => group.id === theme) ? theme : 'all';
}

export function worldForBackground(asset: AssetMeta): string {
  if (asset.layer !== 'background' || asset.origin === 'imported') return 'all';
  return WORLD_COLLECTIONS.find((entry) => entry.id !== 'nature' && asset.themes.includes(entry.id))?.id ?? 'nature';
}

export function inWorldCollection(asset: AssetMeta, world: string): boolean {
  const group = WORLD_COLLECTIONS.find((entry) => entry.id === world);
  if (!group) return true;
  // Room overlays and loose furniture can frame any outdoor scene.
  if (asset.category === 'interiors') return true;
  if (asset.layer === 'background') {
    if (world === 'nature') return !WORLD_COLLECTIONS.some((entry) => entry.id !== 'nature' && asset.themes.includes(entry.id));
    return asset.themes.includes(world);
  }
  return asset.themes.some((theme) => (group.shared as readonly string[]).includes(theme));
}
