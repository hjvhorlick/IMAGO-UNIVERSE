/**
 * The one hard rule of a world: exactly one background, ever. Every other
 * element may repeat (a designer can have many bushes and rocks).
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/store';
import { createScene, createAssetNode } from '../src/scene/sceneModel';
import { withSingleBackground } from '../src/core/sceneRules';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { packageProject, readProject } from '../src/project/projectFormat';
import { testLibrary, TINY_WEBP } from './helpers';

function loadedLibrary() {
  const lib = testLibrary();
  for (const m of lib.assets) lib.registerBlob(m.id, new Blob([TINY_WEBP], { type: 'image/webp' }));
  return lib;
}

const backgrounds = <T extends { layer: string }>(nodes: T[]): T[] => nodes.filter((n) => n.layer === "background");

describe('one background per world', () => {
  it('adding a second background replaces the first, even when the first was locked', () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Bg');
    const store = new Store(scene);
    const first = createAssetNode(lib.get('enchanted.background.lake')!, scene);
    first.locked = true;
    store.addNode(first, 'Set background');
    const second = createAssetNode(lib.get('enchanted.background.glade')!, scene);
    second.locked = true;
    store.addNode(second, 'Set background');
    expect(backgrounds(store.scene.nodes).map((n) => n.assetId)).toEqual(['enchanted.background.glade']);
  });

  it('duplicating a background does not create a second one', () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Dup');
    const store = new Store(scene);
    const bg = createAssetNode(lib.get('enchanted.background.lake')!, scene);
    store.addNode(bg, 'Set background');
    store.select(bg.id);
    const copies = store.duplicateSelected();
    expect(copies.length).toBe(0);
    expect(backgrounds(store.scene.nodes).length).toBe(1);
    expect(store.scene.nodes.length).toBe(1);
  });

  it('duplicating a background alongside other objects copies only the objects', () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Mixed');
    const store = new Store(scene);
    const bg = createAssetNode(lib.get('enchanted.background.lake')!, scene);
    const tree = createAssetNode(lib.get('enchanted.middle.oak')!, scene);
    store.addNode(bg, 'Set background');
    store.addNode(tree, 'Add tree');
    store.select([bg.id, tree.id]);
    const copies = store.duplicateSelected();
    expect(copies.map((n) => n.layer)).toEqual(['middle']);
    expect(backgrounds(store.scene.nodes).length).toBe(1);
  });

  it('other elements repeat freely: several bushes and rocks are fine', () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Repeats');
    const store = new Store(scene);
    const bush = createAssetNode(lib.get('enchanted.foreground.fern')!, scene);
    store.addNode(bush, 'Add fern');
    for (let i = 0; i < 4; i++) {
      store.select(bush.id);
      store.duplicateSelected();
    }
    store.addNode(createAssetNode(lib.get('enchanted.middle.rocks')!, scene), 'Add rocks');
    expect(store.scene.nodes.filter((n) => n.assetId === 'enchanted.foreground.fern').length).toBe(5);
  });

  it('auto-composition never adds a second background to a world that has one', () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Compose');
    const store = new Store(scene);
    store.addNode(createAssetNode(lib.get('enchanted.background.lake')!, scene), 'Set background');
    autoCompose(store.scene, lib, { ...DEFAULT_COMPOSE, seed: 3, setBackground: true });
    expect(backgrounds(store.scene.nodes).length).toBe(1);
  });

  it('a project that somehow holds two backgrounds opens with one, and says so', async () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Old file');
    scene.nodes.push(createAssetNode(lib.get('enchanted.background.lake')!, scene));
    scene.nodes.push(createAssetNode(lib.get('enchanted.background.glade')!, scene));
    const blob = await packageProject(scene, lib);
    const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
    expect(backgrounds(loaded.scene.nodes).length).toBe(1);
    expect(loaded.warnings.some((w) => /extra background/.test(w))).toBe(true);
  });

  it('withSingleBackground keeps the first background and every other element', () => {
    const nodes = [
      { id: 'a', layer: 'background' }, { id: 'b', layer: 'middle' },
      { id: 'c', layer: 'background' }, { id: 'd', layer: 'middle' },
    ] as never[];
    const out = withSingleBackground(nodes);
    expect(out.removed).toBe(1);
    expect(out.nodes.map((n) => (n as { id: string }).id)).toEqual(['a', 'b', 'd']);
  });
});
