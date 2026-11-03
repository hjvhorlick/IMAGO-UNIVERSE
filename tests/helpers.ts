/** Shared fixtures: a small in-memory library that needs no network or DOM. */
import { AssetLibrary } from '../src/assets/library';
import type { AssetManifest, AssetMeta, LayerId } from '../src/core/types';

export function meta(id: string, layer: Exclude<LayerId, 'atmosphere'>, category: string,
  style = 'enchanted', over: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id, name: id.split('.').pop()!, style, layer, category,
    themes: ['forest'], tags: [category], origin: 'painted',
    file: `${style}/${id}.webp`, thumb: `${style}/${id}.webp`, format: 'image/webp',
    width: 800, height: 600, alpha: layer !== 'background',
    depth: layer === 'background' ? 0 : layer === 'middle' ? 0.5 : 0.85,
    groundContact: 1, perspective: 'eye-level', lighting: 'upper-left',
    palette: ['#2f7d55'], defaultScale: layer === 'background' ? 1 : 0.4,
    placement: { grounded: layer !== 'background', minDepth: 0.1, maxDepth: 0.95 },
    animations: layer === 'background' ? ['water-shimmer'] : ['grass-wind'],
    rig: { type: 'bend', anchor: [0.5, 1] }, variants: [], notes: '', bytes: 1000,
    ...over,
  };
}

export function testLibrary(): AssetLibrary {
  const lib = new AssetLibrary();
  const assets: AssetMeta[] = [
    meta('enchanted.background.lake', 'background', 'nature', 'enchanted', { themes: ['water', 'day'] }),
    meta('enchanted.background.glade', 'background', 'nature'),
    meta('enchanted.middle.oak', 'middle', 'trees', 'enchanted', { width: 700, height: 1000, defaultScale: 0.7 }),
    meta('enchanted.middle.willow', 'middle', 'trees', 'enchanted', { width: 700, height: 1000 }),
    meta('enchanted.middle.pavilion', 'middle', 'structures'),
    meta('enchanted.middle.rocks', 'middle', 'rocks', 'enchanted', { defaultScale: 0.2 }),
    meta('enchanted.middle.falls', 'middle', 'water', 'enchanted', { themes: ['water'] }),
    meta('enchanted.foreground.grass', 'foreground', 'grass'),
    meta('enchanted.foreground.flowers', 'foreground', 'flowers'),
    meta('enchanted.foreground.fern', 'foreground', 'plants'),
    meta('enchanted.foreground.pebbles', 'foreground', 'ground'),
    meta('moonlit.background.glade', 'background', 'night', 'moonlit', { themes: ['night'] }),
    meta('moonlit.middle.oak', 'middle', 'trees', 'moonlit'),
    meta('moonlit.middle.pavilion', 'middle', 'structures', 'moonlit'),
    meta('moonlit.foreground.grass', 'foreground', 'grass', 'moonlit'),
    meta('moonlit.foreground.fern', 'foreground', 'plants', 'moonlit'),
  ];
  const manifest: AssetManifest = {
    schema: 'imago.asset-library/1',
    styles: [
      { id: 'enchanted', name: 'Enchanted', subtitle: 'fantasy', description: '', swatches: ['#2f7d55'],
        lighting: 'upper-left', complete: true,
        reference: { background: 'enchanted.background.lake', tree: 'enchanted.middle.oak',
          structure: 'enchanted.middle.pavilion', plant: 'enchanted.foreground.flowers',
          ground: 'enchanted.foreground.pebbles' } },
      { id: 'moonlit', name: 'Moonlit', subtitle: 'night', description: '', swatches: ['#1d3a63'],
        lighting: 'upper-right', complete: true,
        reference: { background: 'moonlit.background.glade', tree: 'moonlit.middle.oak',
          structure: 'moonlit.middle.pavilion', plant: 'moonlit.foreground.fern',
          ground: 'moonlit.foreground.grass' } },
    ],
    assets,
  };
  lib.manifest = manifest;
  return lib;
}

/** A tiny valid WebP so project packaging has real bytes to embed. */
export const TINY_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
