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
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

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

  describe('imported sound', () => {
    const SOUND_BYTES = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5, 6, 7]);
    const sound = () => new Blob([SOUND_BYTES as BlobPart], { type: 'audio/mpeg' });
    const withSound = () => {
      const scene = createScene('enchanted', 'Scored');
      scene.audio = {
        id: 'audio_test_1', name: 'Dawn theme', duration: 42, volume: 0.35, loop: true,
        crossfade: 2.5, offset: 1.25, mime: 'audio/mpeg', bytes: SOUND_BYTES.length,
      };
      return scene;
    };

    it('travels inside the file and comes back byte-identical with its settings', async () => {
      const lib = loadedLibrary();
      const scene = withSound();
      const blob = await packageProject(scene, lib, undefined, sound());
      const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
      const soundPath = Object.keys(entries).find((k) => k.startsWith('audio/'));
      expect(soundPath).toBe('audio/audio_test_1.mp3');
      expect(Array.from(entries[soundPath!])).toEqual(Array.from(SOUND_BYTES));

      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.audio).toEqual(scene.audio);
      expect(loaded.sound).not.toBeNull();
      expect(Array.from(new Uint8Array(await loaded.sound!.arrayBuffer())))
        .toEqual(Array.from(SOUND_BYTES));
      expect(loaded.sound!.type).toBe('audio/mpeg');
    });

    it('a silent scene carries no audio entry and opens silent', async () => {
      const lib = loadedLibrary();
      const scene = createScene('enchanted', 'Quiet');
      const blob = await packageProject(scene, lib, undefined, sound());
      const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
      expect(Object.keys(entries).some((k) => k.startsWith('audio/'))).toBe(false);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.audio ?? null).toBeNull();
      expect(loaded.sound).toBeNull();
    });

    it('keeps the sound reference when the bytes were not supplied, without crashing', async () => {
      const lib = loadedLibrary();
      const blob = await packageProject(withSound(), lib);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.audio?.id).toBe('audio_test_1');
      expect(loaded.sound).toBeNull();
    });

    it('a project written before sound was embedded still opens', async () => {
      // Older files have an `audio` block but no sound entry in the archive.
      const lib = loadedLibrary();
      const blob = await packageProject(withSound(), lib, undefined, null);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.missingAssets).toEqual([]);
      expect(loaded.sound).toBeNull();
    });

    it('sanitises a malformed sound block instead of trusting it', async () => {
      const lib = loadedLibrary();
      const scene = createScene('enchanted', 'Bad audio');
      scene.audio = { id: 'audio_x', volume: 9, crossfade: -4, offset: -1, loop: false } as never;
      const blob = await packageProject(scene, lib);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.audio).toMatchObject({
        id: 'audio_x', volume: 1, crossfade: 0, offset: 0, loop: false, mime: 'audio/mpeg',
      });
    });

    it('a sound block with no usable id is dropped rather than half-restored', async () => {
      const lib = loadedLibrary();
      const scene = createScene('enchanted', 'Junk');
      scene.audio = { name: 'no id' } as never;
      const blob = await packageProject(scene, lib);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.audio ?? null).toBeNull();
    });
  });

  describe('synthesised ambience and meditation settings', () => {
    const calmScene = () => {
      const scene = createScene('enchanted', 'Still water');
      scene.ambience = { master: 0.62, beds: { water: 0.4, wind: 0.15, rain: 0, birds: 0.55, crickets: 0.25 } };
      scene.meditation = { pattern: 'box', guide: true, sessionMin: 10 };
      return scene;
    };

    it('travels inside the project file and comes back exactly', async () => {
      const lib = loadedLibrary();
      const scene = calmScene();
      const blob = await packageProject(scene, lib);
      const doc = JSON.parse(strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['project.json']));
      expect(doc.scene.ambience, 'stored as data, not as audio bytes').toEqual(scene.ambience);
      expect(Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())))
        .some((k) => k.startsWith('audio/')), 'synthesis needs no audio entry').toBe(false);

      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.ambience).toEqual(scene.ambience);
      expect(loaded.scene.meditation).toEqual(scene.meditation);
    });

    it('a world without ambience opens without it', async () => {
      const lib = loadedLibrary();
      const blob = await packageProject(createScene('enchanted', 'Silent'), lib);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.ambience ?? null).toBeNull();
      expect(loaded.scene.meditation ?? null).toBeNull();
    });

    it('sanitises an out-of-range mix and an unknown breathing pattern', async () => {
      const lib = loadedLibrary();
      const scene = createScene('enchanted', 'Loud');
      scene.ambience = { master: 4, beds: { water: -2, wind: 9, sparkles: 0.5 } } as never;
      scene.meditation = { pattern: 'wim-hof', guide: 'yes', sessionMin: 999 } as never;
      const blob = await packageProject(scene, lib);
      const loaded = await readProject(await blob.arrayBuffer(), testLibrary());
      expect(loaded.scene.ambience).toEqual({
        master: 1, beds: { water: 0, wind: 1, rain: 0, birds: 0, crickets: 0 },
      });
      expect(loaded.scene.meditation).toEqual({ pattern: 'calm', guide: false, sessionMin: 180 });
    });

    it('a project saved before ambience existed still opens', async () => {
      const lib = loadedLibrary();
      const scene = createScene('enchanted', 'Old file');
      scene.ambience = { master: 0.5, beds: { water: 0.5, wind: 0, rain: 0, birds: 0, crickets: 0 } };
      // Rebuild the archive as an older build would have written it: no such keys.
      const files = unzipSync(new Uint8Array(await (await packageProject(scene, lib)).arrayBuffer()));
      const doc = JSON.parse(strFromU8(files['project.json']));
      delete doc.scene.ambience;
      delete doc.scene.meditation;
      files['project.json'] = strToU8(JSON.stringify(doc));
      const legacy = zipSync(files);

      const loaded = await readProject(legacy.buffer as ArrayBuffer, testLibrary());
      expect(loaded.missingAssets).toEqual([]);
      expect(loaded.scene.ambience ?? null, 'nothing is invented for an old file').toBeNull();
      expect(loaded.scene.meditation ?? null).toBeNull();
      expect(loaded.scene.name).toBe('Old file');
    });
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
