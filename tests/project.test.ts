/**
 * Acceptance tests for the editable project format: save, reopen, modify,
 * Save As, and asset portability.
 */
import { describe, expect, it } from 'vitest';
import { packageProject, readProject, projectFilename, PROJECT_FORMAT } from '../src/project/projectFormat';
import { createAssetNode, createScene } from '../src/scene/sceneModel';
import { makeEffectNode } from '../src/ui/inspector';
import { autoCompose, DEFAULT_COMPOSE } from '../src/scene/composition';
import { makeAnimation } from '../src/core/types';
import { testLibrary, TINY_WEBP } from './helpers';
import { strFromU8, unzipSync } from 'fflate';

function loadedLibrary() {
  const lib = testLibrary();
  for (const m of lib.assets) lib.registerBlob(m.id, new Blob([TINY_WEBP], { type: 'image/webp' }));
  return lib;
}

async function roundTrip(scene: ReturnType<typeof createScene>, lib = loadedLibrary()) {
  const blob = await packageProject(scene, lib);
  const fresh = testLibrary();          // a different machine with no local blobs
  const loaded = await readProject(await blob.arrayBuffer(), fresh);
  return { loaded, fresh, blob };
}

describe('.sceneproject', () => {
  it('packages a real archive containing the scene and its artwork', async () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Round trip');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 17 });
    const blob = await packageProject(scene, lib);
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries)).toContain('project.json');
    expect(Object.keys(entries)).toContain('assets/manifest.json');
    expect(Object.keys(entries).filter((k) => k.startsWith('assets/files/')).length)
      .toBeGreaterThan(5);
    const doc = JSON.parse(strFromU8(entries['project.json']));
    expect(doc.format).toBe(PROJECT_FORMAT);
    expect(doc.scene.nodes.length).toBe(scene.nodes.length);
  });

  it('restores every object, transform and setting on a machine with no local assets', async () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted', 'Portable world');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 23 });
    const tree = scene.nodes.find((n) => lib.get(n.assetId)?.category === 'trees')!;
    tree.rotation = 12.5;
    tree.crop = { x: 0.1, y: 0.05, w: 0.7, h: 0.8 };
    tree.opacity = 0.62;
    tree.adjust.hue = 33;
    tree.locked = true;
    tree.animation = makeAnimation('canopy-sway', 555);
    tree.animation.enabled = true;
    tree.animation.loop = 9.5;
    const fx = makeEffectNode('fairy-dust', scene, 0);
    fx.effect!.params.density = 123;
    fx.effect!.loop = 14;
    scene.nodes.push(fx);
    scene.lighting.warmth = -0.4;
    scene.exportSettings.duration = 1800;

    const { loaded, fresh } = await roundTrip(scene, lib);
    expect(loaded.missingAssets).toEqual([]);
    expect(loaded.scene.name).toBe('Portable world');
    expect(loaded.scene.nodes.length).toBe(scene.nodes.length);
    const t = loaded.scene.nodes.find((n) => n.id === tree.id)!;
    expect(t.rotation).toBe(12.5);
    expect(t.crop).toEqual({ x: 0.1, y: 0.05, w: 0.7, h: 0.8 });
    expect(t.opacity).toBe(0.62);
    expect(t.adjust.hue).toBe(33);
    expect(t.locked).toBe(true);
    expect(t.animation?.loop).toBe(9.5);
    expect(t.animation?.seed).toBe(555);
    const f = loaded.scene.nodes.find((n) => n.id === fx.id)!;
    expect(f.effect!.params.density).toBe(123);
    expect(f.effect!.loop).toBe(14);
    expect(loaded.scene.lighting.warmth).toBe(-0.4);
    expect(loaded.scene.exportSettings.duration).toBe(1800);
    // artwork really travelled inside the file
    expect(fresh.hasBlob(tree.assetId!)).toBe(true);
  });

  it('never flattens: the reopened scene is still a layer graph', async () => {
    const lib = loadedLibrary();
    const scene = createScene('enchanted');
    autoCompose(scene, lib, { ...DEFAULT_COMPOSE, seed: 5 });
    const { loaded } = await roundTrip(scene, lib);
    const layers = new Set(loaded.scene.nodes.map((n) => n.layer));
    expect(layers.has('background')).toBe(true);
    expect(layers.has('middle')).toBe(true);
    expect(layers.has('foreground')).toBe(true);
    expect(loaded.scene.nodes.every((n) => n.kind === 'asset' ? !!n.assetId : true)).toBe(true);
  });

  it('Save As leaves the original project untouched', async () => {
    const lib = loadedLibrary();
    const original = createScene('enchanted', 'Original');
    autoCompose(original, lib, { ...DEFAULT_COMPOSE, seed: 9 });
    const originalBlob = await packageProject(original, lib);
    const originalBytes = new Uint8Array(await originalBlob.arrayBuffer());

    const copy = structuredClone(original);
    copy.id = 'scene_copy';
    copy.name = 'Variation';
    copy.lighting.exposure = 1.5;
    copy.nodes.push(createAssetNode(lib.get('enchanted.middle.rocks')!, copy));
    await packageProject(copy, lib);

    const reopened = await readProject(originalBytes.buffer as ArrayBuffer, testLibrary());
    expect(reopened.scene.name).toBe('Original');
    expect(reopened.scene.lighting.exposure).toBe(1);
    expect(reopened.scene.nodes.length).toBe(original.nodes.length);
  });

  it('rejects a file that is not an Imago project with a clear reason', async () => {
    const lib = testLibrary();
    await expect(readProject(new TextEncoder().encode('not a zip').buffer as ArrayBuffer, lib))
      .rejects.toThrow(/not a readable \.sceneproject/i);
  });

  it('fills in defaults for a partial older file instead of throwing', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const doc = {
      format: PROJECT_FORMAT, version: 1, generator: 'old', savedAt: '',
      scene: { id: 's', name: 'Legacy', styleId: 'enchanted', nodes: [
        { id: 'n1', kind: 'asset', layer: 'middle', assetId: 'enchanted.middle.oak', x: 10, y: 20 },
      ] },
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(doc)) });
    const loaded = await readProject(zip.buffer as ArrayBuffer, testLibrary());
    expect(loaded.scene.canvas.width).toBe(1920);
    expect(loaded.scene.nodes[0].opacity).toBe(1);
    expect(loaded.scene.nodes[0].crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(loaded.scene.lighting).toBeDefined();
  });

  it('builds a safe filename from the project name', () => {
    const s = createScene('enchanted', 'My ../ World!');
    expect(projectFilename(s)).toBe('my-..-world.sceneproject');
  });
});
