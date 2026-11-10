/**
 * Scene model: factories and structural helpers.
 *
 * Everything here is pure - it produces or rearranges plain data. Rendering,
 * animation and the UI all read from the structures created here.
 */
import {
  DEFAULT_ADJUST, DEFAULT_CROP, DEFAULT_EXPORT, DEFAULT_LIGHTING, DEFAULT_SHADOW,
  LAYER_ORDER, makeAnimation,
} from '../core/types';
import type {
  AnimationType, AssetMeta, CanvasSettings, LayerId, Scene, SceneNode,
} from '../core/types';
import { clamp, deepClone, lerp, uid } from '../core/util';

export const CANVAS_PRESETS: Record<string, { w: number; h: number; label: string }> = {
  '16:9': { w: 1920, h: 1080, label: '16:9 landscape' },
  '9:16': { w: 1080, h: 1920, label: '9:16 vertical' },
  '1:1': { w: 1440, h: 1440, label: '1:1 square' },
  '4:3': { w: 1600, h: 1200, label: '4:3 classic' },
  '21:9': { w: 2560, h: 1080, label: '21:9 cinematic' },
};

export function makeCanvas(aspect = '16:9', w?: number, h?: number): CanvasSettings {
  const p = CANVAS_PRESETS[aspect] ?? CANVAS_PRESETS['16:9'];
  return {
    width: w ?? p.w, height: h ?? p.h, aspect,
    backdrop: '#0b0f14', clipToCanvas: true,
  };
}

export function createScene(styleId: string, name = 'Untitled world', aspect = '16:9'): Scene {
  const now = new Date().toISOString();
  return {
    id: uid('scene'), name, styleId, theme: 'enchanted',
    canvas: makeCanvas(aspect), nodes: [],
    lighting: { ...DEFAULT_LIGHTING },
    exportSettings: { ...DEFAULT_EXPORT },
    createdAt: now, updatedAt: now,
  };
}

/** Ground line for a given depth: distant objects sit higher in the frame. */
export function groundLine(scene: Scene, depth: number): number {
  return scene.canvas.height * lerp(0.58, 1.04, clamp(depth, 0, 1));
}

export function createAssetNode(
  meta: AssetMeta, scene: Scene, opts: { x?: number; y?: number; depth?: number; scale?: number } = {},
): SceneNode {
  const cw = scene.canvas.width, ch = scene.canvas.height;
  const depth = opts.depth ?? meta.depth;
  let width: number, height: number, x: number, y: number;

  if (meta.layer === 'background') {
    const cover = Math.max(cw / meta.width, ch / meta.height);
    width = meta.width * cover;
    height = meta.height * cover;
    x = cw / 2; y = ch / 2;
  } else if (meta.rig?.type === 'flying-flock') {
    const depthScale = lerp(0.62, 1.25, clamp(depth, 0, 1));
    height = ch * meta.defaultScale * depthScale * (opts.scale ?? 1);
    // The box is the flock's flight path, not just a stationary cluster.
    // Extend it slightly beyond both sides so birds enter and leave off-screen.
    width = cw * 1.18 * (opts.scale ?? 1);
    x = opts.x ?? cw * 0.5; y = opts.y ?? ch * 0.19;
  } else if (meta.rig?.type === 'window-overlay') {
    // A room is a full-frame view, not a ground-level prop. Cover the canvas
    // so the outdoor world appears only through its transparent window.
    const cover = Math.max(cw / meta.width, ch / meta.height) * (opts.scale ?? 1);
    width = meta.width * cover;
    height = meta.height * cover;
    x = opts.x ?? cw / 2; y = opts.y ?? ch / 2;
  } else {
    // Depth scaling: near objects are larger, distant ones smaller.
    const depthScale = lerp(0.62, 1.25, clamp(depth, 0, 1));
    height = ch * meta.defaultScale * depthScale * (opts.scale ?? 1);
    width = height * (meta.width / meta.height);
    x = opts.x ?? cw * 0.5;
    y = opts.y ?? groundLine(scene, depth) - height * meta.groundContact + height * 0.5;
  }

  const anim = defaultAnimationFor(meta);
  return {
    id: uid('obj'), kind: 'asset', layer: meta.layer, name: meta.name, assetId: meta.id,
    x, y, width, height, rotation: 0, flipX: false,
    opacity: 1, visible: true, locked: meta.layer === 'background',
    order: nextOrder(scene, meta.layer), depth,
    crop: { ...DEFAULT_CROP }, adjust: { ...DEFAULT_ADJUST },
    shadow: { ...DEFAULT_SHADOW, enabled: false },
    blend: 'source-over',
    animation: anim,
  };
}

function defaultAnimationFor(meta: AssetMeta): SceneNode['animation'] {
  const first = meta.animations[0] as AnimationType | undefined;
  if (!first) return null;
  const a = makeAnimation(first, Math.floor(Math.random() * 1e6));
  // Waterfalls start flowing; other artwork starts still unless its rig
  // explicitly opts in to autoplay (for example a gentle water surface).
  if (first === 'waterfall-flow') {
    a.enabled = true;
    a.amplitude = 0.85;
    a.turbulence = 0.7;
  } else {
    a.enabled = meta.rig?.autoplay === true;
    if (a.enabled && meta.rig?.type === 'flying-flock') { a.amplitude = 0.9; a.loop = 24; }
    if (a.enabled && (first === 'hearth-fire' || first === 'coffee-steam')) a.amplitude = 0.8;
    if (a.enabled && (first === 'water-flow' || first === 'water-shimmer')) a.amplitude = 0.22;
  }
  return a;
}

export function nextOrder(scene: Scene, layer: LayerId): number {
  const peers = scene.nodes.filter((n) => n.layer === layer);
  return peers.length ? Math.max(...peers.map((n) => n.order)) + 1 : 0;
}

export function layerNodes(scene: Scene, layer: LayerId): SceneNode[] {
  return scene.nodes.filter((n) => n.layer === layer).sort((a, b) => a.order - b.order);
}

/** Paint order across the whole scene: strictly layer 1 -> 4, then node order. */
export function paintOrder(scene: Scene): SceneNode[] {
  return [...scene.nodes].sort((a, b) => {
    const la = LAYER_ORDER.indexOf(a.layer), lb = LAYER_ORDER.indexOf(b.layer);
    return la !== lb ? la - lb : a.order - b.order;
  });
}

export function reorderNode(scene: Scene, node: SceneNode, direction: 'up' | 'down' | 'front' | 'back') {
  const peers = layerNodes(scene, node.layer);
  const i = peers.findIndex((n) => n.id === node.id);
  if (i < 0) return;
  let target = i;
  if (direction === 'up') target = Math.min(peers.length - 1, i + 1);
  if (direction === 'down') target = Math.max(0, i - 1);
  if (direction === 'front') target = peers.length - 1;
  if (direction === 'back') target = 0;
  peers.splice(i, 1);
  peers.splice(target, 0, node);
  peers.forEach((n, idx) => { n.order = idx; });
}

export function moveNodeToLayer(scene: Scene, node: SceneNode, layer: LayerId) {
  node.layer = layer;
  node.order = nextOrder(scene, layer);
}

export function normalizeOrders(scene: Scene) {
  for (const layer of LAYER_ORDER) layerNodes(scene, layer).forEach((n, i) => { n.order = i; });
}

export function cloneNode(node: SceneNode, scene: Scene): SceneNode {
  const copy = deepClone(node);
  copy.id = uid(node.kind);
  copy.order = nextOrder(scene, node.layer);
  copy.locked = false;
  return copy;
}

/**
 * Resize the canvas. Object scale is defined relative to canvas *height*
 * (see `defaultScale`), so sizes follow the height ratio while positions follow
 * each axis. That keeps a tree the same apparent size when you switch from
 * landscape to portrait instead of shrinking it to a stamp. Backgrounds are
 * re-fitted to cover the new frame.
 */
export function resizeCanvas(scene: Scene, width: number, height: number, aspect: string) {
  const sx = width / scene.canvas.width;
  const sy = height / scene.canvas.height;
  for (const n of scene.nodes) {
    if (n.kind === 'effect') {
      // Effects that covered the whole canvas keep covering it.
      const coveredX = Math.abs(n.width - scene.canvas.width) < 2;
      const coveredY = Math.abs(n.height - scene.canvas.height) < 2;
      n.x *= sx; n.y *= sy;
      n.width = coveredX ? width : n.width * sy;
      n.height = coveredY ? height : n.height * sy;
      continue;
    }
    n.x *= sx; n.y *= sy;
    n.width *= sy; n.height *= sy;
  }
  scene.canvas.width = width;
  scene.canvas.height = height;
  scene.canvas.aspect = aspect;
}

/** Re-fit a background node so it covers the canvas without distortion. */
export function fitBackground(node: SceneNode, scene: Scene, assetWidth: number, assetHeight: number) {
  const cover = Math.max(scene.canvas.width / assetWidth, scene.canvas.height / assetHeight);
  node.width = assetWidth * cover;
  node.height = assetHeight * cover;
  node.x = scene.canvas.width / 2;
  node.y = scene.canvas.height / 2;
}

export function nodeBounds(n: SceneNode) {
  return { x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height };
}
