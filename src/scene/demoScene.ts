/**
 * The world Imago opens with. A real composition, not an empty canvas: it
 * demonstrates all four layers, several independent animation techniques and
 * a harmonised multi-effect loop.
 */
import type { AssetLibrary } from '../assets/library';
import type { Scene, SceneNode } from '../core/types';
import { DEFAULT_LOOP, makeAnimation } from '../core/types';
import type { AnimationType } from '../core/types';
import { autoCompose, DEFAULT_COMPOSE, sortByDepth } from './composition';
import { createAssetNode, createScene } from './sceneModel';
import { makeEffectNode } from '../ui/inspector';

export function buildDemoScene(library: AssetLibrary, opts: {
  styleId?: string; aspect?: string; name?: string; withEffects?: boolean; composed?: boolean;
} = {}): Scene {
  const styleId = opts.styleId ?? library.styles[0]?.id ?? 'enchanted';
  const scene = createScene(styleId, opts.name ?? 'Enchanted Lake', opts.aspect ?? '16:9');
  if (opts.composed === false) return scene;

  // Prefer the lake plate so the demo always opens on the same hero view.
  const preferred = library.get(`${styleId}.background.enchanted-lake`)
    ?? library.forStyle(styleId, 'background')[0];
  if (preferred) {
    const bg = createAssetNode(preferred, scene);
    bg.locked = true;
    scene.nodes.push(bg);
  }

  autoCompose(scene, library, {
    ...DEFAULT_COMPOSE, seed: 20261103, density: 'balanced', foreground: 0.62,
    setBackground: false, suggestLighting: true,
  });
  sortByDepth(scene);

  /* Wake up a handful of objects with the technique that suits each material. */
  const wanted: { category: string; type: AnimationType; count: number; amplitude: number }[] = [
    { category: 'trees', type: 'canopy-sway', count: 3, amplitude: 0.55 },
    { category: 'water', type: 'waterfall-flow', count: 1, amplitude: 0.7 },
    { category: 'grass', type: 'grass-wind', count: 6, amplitude: 0.6 },
    { category: 'flowers', type: 'stem-bend', count: 3, amplitude: 0.55 },
    { category: 'plants', type: 'grass-wind', count: 4, amplitude: 0.45 },
  ];
  for (const w of wanted) {
    const nodes = scene.nodes.filter((n) => {
      const meta = library.get(n.assetId);
      return n.kind === 'asset' && meta?.category === w.category;
    }).slice(0, w.count);
    nodes.forEach((n, i) => {
      const a = makeAnimation(w.type, 1000 + i * 137);
      a.enabled = true;
      a.amplitude = w.amplitude;
      a.loop = DEFAULT_LOOP[w.type];
      a.phase = (i * 0.17) % 1;
      a.turbulence = 0.5;
      n.animation = a;
    });
  }
  const bgNode = scene.nodes.find((n) => n.layer === 'background');
  if (bgNode) {
    const a = makeAnimation('water-shimmer', 42);
    a.enabled = true; a.amplitude = 0.5; a.loop = 8;
    bgNode.animation = a;
  }

  if (opts.withEffects !== false) {
    const add = (id: string, tweak?: (n: SceneNode) => void) => {
      const node = makeEffectNode(id, scene, scene.nodes.filter((n) => n.layer === 'atmosphere').length);
      tweak?.(node);
      scene.nodes.push(node);
    };
    add('fairy-dust', (n) => {
      n.effect!.params.density = 120;
      n.effect!.params.color = '#ffe6a8';
      n.effect!.loop = 12;
      n.effect!.seed = 811;
    });
    add('glowing-orbs', (n) => {
      n.effect!.params.density = 6;
      n.effect!.params.color = '#9fe8ff';
      n.effect!.params.color2 = '#d7b3ff';
      n.effect!.loop = 16;
      n.effect!.seed = 271;
    });
    add('sparkles', (n) => {
      n.effect!.params.density = 55;
      n.effect!.params.distribution = 'bottom';
      n.effect!.loop = 6;
      n.effect!.seed = 97;
    });
    add('fireflies', (n) => {
      n.effect!.params.density = 18;
      n.effect!.loop = 12;
      n.effect!.seed = 449;
    });
    add('mist', (n) => {
      n.effect!.params.opacity = 0.1;
      n.effect!.params.band = 0.66;
      n.effect!.loop = 24;
      n.effect!.seed = 613;
    });
    add('falling-leaves', (n) => {
      n.effect!.params.density = 16;
      n.effect!.loop = 12;
      n.effect!.seed = 331;
    });
  }
  return scene;
}
