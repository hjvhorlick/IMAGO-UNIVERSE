/**
 * Worlds are the background types. Looks are the styles within a world.
 * Every background in the library must belong to exactly one world category,
 * and a new world starts with its background only.
 */
import { describe, expect, it } from 'vitest';
import { WORLD_CATEGORIES, backgroundFor, createWorldScene, listWorlds, worldIdOf } from '../src/scene/worlds';
import fs from 'node:fs';
import path from 'node:path';
import { AssetLibrary } from '../src/assets/library';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The real shipped library, so the category rules are checked against what the app ships. */
function testLibrary() {
  const lib = new AssetLibrary();
  lib.manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/library/manifest.json'), 'utf8'));
  return lib;
}

describe('world categories', () => {
  const lib = testLibrary();
  const bgs = lib.assets.filter((a) => a.layer === 'background');

  it('lists every background in the library under exactly one world', () => {
    const worlds = listWorlds(lib);
    const ids = worlds.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(worlds.flatMap((w) => w.looks).length).toBe(bgs.length);
  });

  it('places every world in one category, and no category lists a world twice', () => {
    const listed = WORLD_CATEGORIES.flatMap((c) => c.worlds);
    expect(new Set(listed).size).toBe(listed.length);
    for (const w of listWorlds(lib)) {
      expect(w.categoryId, `${w.id} has no category`).not.toBe('other');
    }
  });

  it('keeps the reserved realistic category empty until it is built', () => {
    const realistic = WORLD_CATEGORIES.find((c) => c.id === 'realistic');
    expect(realistic).toBeTruthy();
    expect(realistic!.worlds).toEqual([]);
  });

  it('treats the three styles as looks of the same world, not as separate worlds', () => {
    const multi = listWorlds(lib).filter((w) => w.looks.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const w of listWorlds(lib)) {
      expect(['enchanted', 'moonlit', 'autumn']).not.toContain(w.id);
    }
  });
});

describe('creating a world', () => {
  const lib = testLibrary();

  it('starts with exactly one node: the chosen background, locked', () => {
    const w = listWorlds(lib).find((x) => x.id === 'enchanted-lake')!;
    const scene = createWorldScene(lib, { worldId: w.id, styleId: w.looks[0], name: 'Lake' });
    expect(scene.nodes.length).toBe(1);
    expect(scene.nodes[0].layer).toBe('background');
    expect(scene.nodes[0].locked).toBe(true);
    expect(scene.worldId).toBe('enchanted-lake');
  });

  it('switches look within the same world without changing the world', () => {
    const w = listWorlds(lib).find((x) => x.looks.length > 1)!;
    const other = w.looks[1];
    const scene = createWorldScene(lib, { worldId: w.id, styleId: other });
    expect(scene.styleId).toBe(other);
    expect(scene.worldId).toBe(w.id);
    expect(scene.nodes[0].assetId).toBe(`${other}.background.${w.id}`);
  });

  it('refuses a look that the world does not have', () => {
    expect(() => createWorldScene(lib, { worldId: 'no-such-world', styleId: 'enchanted' })).toThrow();
    expect(backgroundFor(lib, 'no-such-world', 'enchanted')).toBeUndefined();
  });

  it('derives the world id from the background file name', () => {
    for (const bg of lib.assets.filter((a) => a.layer === 'background')) {
      expect(bg.id).toBe(`${bg.style}.background.${worldIdOf(bg)}`);
    }
  });
});
