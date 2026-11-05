/**
 * IMAGO UNIVERSE - core domain types.
 *
 * The scene graph is deliberately plain JSON: every value here survives a
 * round-trip through the `.sceneproject` format. Nothing in the scene graph
 * holds a live browser object (no HTMLImageElement, no blob URL), which is what
 * makes projects portable between machines and sessions.
 */

export type LayerId = 'background' | 'middle' | 'foreground' | 'atmosphere';

export const LAYER_ORDER: LayerId[] = ['background', 'middle', 'foreground', 'atmosphere'];

export const LAYER_LABEL: Record<LayerId, string> = {
  background: 'Background',
  middle: 'Middle-ground',
  foreground: 'Foreground',
  atmosphere: 'Atmosphere & Imagination',
};

export const LAYER_HINT: Record<LayerId, string> = {
  background: 'The furthest plate: sky, distance and terrain.',
  middle: 'The physical world: trees, structures, rocks and water.',
  foreground: 'Close detail. May extend beyond the canvas edges.',
  atmosphere: 'Universal effects - available in every artistic style.',
};

export type NodeKind = 'asset' | 'effect';

/** Non-destructive source rectangle, normalised 0..1 against the original art. */
export interface CropRect { x: number; y: number; w: number; h: number }

export interface Adjustments {
  brightness: number;   // 1 = unchanged
  contrast: number;
  saturation: number;
  hue: number;          // degrees
  warmth: number;       // -1 cool .. +1 warm
  haze: number;         // 0..1 atmospheric wash toward the scene light colour
}

export interface ShadowSettings {
  enabled: boolean;
  opacity: number;
  blur: number;
  distance: number;
  angle: number;        // degrees, direction the shadow is cast
  squash: number;       // vertical flattening for contact shadows
}

export type AnimationType =
  | 'none'
  | 'canopy-sway'
  | 'grass-wind'
  | 'stem-bend'
  | 'water-flow'
  | 'waterfall-flow'
  | 'ripple'
  | 'flag-wave'
  | 'float'
  | 'spin'
  | 'pulse'
  | 'lantern-glow'
  | 'hearth-fire'
  | 'coffee-steam'
  | 'cloud-drift'
  | 'water-shimmer'
  | 'parallax';

export interface AnimationSettings {
  type: AnimationType;
  enabled: boolean;
  amplitude: number;    // 0..1 normalised strength
  speed: number;        // multiplier on the natural rate
  loop: number;         // seconds for one exact cycle
  phase: number;        // 0..1 offset into the cycle
  direction: number;    // degrees for directional motion
  turbulence: number;   // 0..1 organic variation
  seed: number;
  start: number;        // seconds; effect is idle before this
  end: number;          // seconds; 0 = never stop
}

export interface EffectInstance {
  effectId: string;
  params: Record<string, number | string | boolean>;
  loop: number;
  seed: number;
  start: number;
  end: number;
}

export interface SceneNode {
  id: string;
  kind: NodeKind;
  layer: LayerId;
  name: string;
  assetId?: string;
  x: number;            // canvas pixels, object centre
  y: number;
  width: number;
  height: number;
  rotation: number;     // degrees
  flipX: boolean;
  opacity: number;
  visible: boolean;
  locked: boolean;
  order: number;        // paint order inside the layer, ascending
  depth: number;        // 0 far .. 1 near, used by composition + haze
  crop: CropRect;
  adjust: Adjustments;
  shadow: ShadowSettings;
  blend: string;        // canvas composite operation
  animation: AnimationSettings | null;
  effect?: EffectInstance;
}

export interface Lighting {
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
  ambient: number;
  lightAngle: number;
  lightColor: string;
  rays: number;
  haze: number;
  vignette: number;
}

export interface CanvasSettings {
  width: number;
  height: number;
  aspect: string;
  backdrop: string;
  clipToCanvas: boolean;
}

export interface ExportSettings {
  format: 'mp4' | 'webm';
  resolution: number;    // vertical pixels
  fps: number;
  duration: number;      // seconds
  bitrate: number;       // bits per second
  quality: 'draft' | 'standard' | 'high' | 'master';
  stillFormat: 'png' | 'jpeg' | 'webp';
  stillQuality: number;
}

/**
 * A user-imported sound track. The application ships no audio of its own - this
 * only ever describes a file the user brought in, which is embedded in the
 * .sceneproject so the project stays portable.
 */
export interface SceneAudio {
  /** Blob key in the library's imported-audio store. */
  id: string;
  name: string;
  /** Seconds, reported by the decoder; 0 if unknown. */
  duration: number;
  /** 0..1 */
  volume: number;
  /** Repeat for the whole video rather than stopping at the end. */
  loop: boolean;
  /** Seconds to crossfade across the loop join. 0 = plain repeat (audible join). */
  crossfade: number;
  /** Start this far into the track. */
  offset: number;
  mime: string;
  bytes: number;
}

export interface Scene {
  id: string;
  name: string;
  styleId: string;
  theme: string;
  canvas: CanvasSettings;
  nodes: SceneNode[];
  lighting: Lighting;
  /** Optional imported music. Absent = silent, which is the default. */
  audio?: SceneAudio | null;
  /** The world this scene was started from (its background's place). Informational. */
  worldId?: string | null;
  exportSettings: ExportSettings;
  createdAt: string;
  updatedAt: string;
}

/* ---------------------------------------------------------------- assets */

export interface AssetRig {
  type?: string;
  anchor?: [number, number];
  canopyStart?: number;
  stiffness?: number;
  gusts?: number;
  region?: [number, number, number, number];
  /** Optional steam origin and size for a cup painted into a room overlay. */
  steamRegion?: [number, number, number, number];
  speed?: number;
  /** Enable the asset's first listed animation when it is placed. */
  autoplay?: boolean;
}

export interface AssetMeta {
  id: string;
  name: string;
  style: string;
  layer: Exclude<LayerId, 'atmosphere'>;
  category: string;
  themes: string[];
  tags: string[];
  origin: 'painted' | 'derived' | 'composed' | 'graded' | 'imported' | string;
  file: string;
  thumb: string;
  format: string;
  width: number;
  height: number;
  alpha: boolean;
  depth: number;
  groundContact: number;
  perspective: string;
  lighting: string;
  palette: string[];
  defaultScale: number;
  placement: { grounded: boolean; minDepth: number; maxDepth: number };
  animations: string[];
  rig: AssetRig;
  variants: string[];
  notes: string;
  bytes: number;
}

export interface StyleRef {
  background: string;
  tree: string;
  structure: string;
  plant: string;
  ground: string;
}

export interface StyleMeta {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  swatches: string[];
  lighting: string;
  reference: StyleRef;
  complete: boolean;
}

export interface AssetManifest {
  schema: string;
  styles: StyleMeta[];
  assets: AssetMeta[];
}

/* -------------------------------------------------------------- defaults */

export const DEFAULT_ADJUST: Adjustments = {
  brightness: 1, contrast: 1, saturation: 1, hue: 0, warmth: 0, haze: 0,
};

export const DEFAULT_SHADOW: ShadowSettings = {
  enabled: false, opacity: 0.35, blur: 18, distance: 22, angle: 145, squash: 0.28,
};

export const DEFAULT_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

export const DEFAULT_LIGHTING: Lighting = {
  exposure: 1, contrast: 1, saturation: 1, warmth: 0, ambient: 0,
  lightAngle: 315, lightColor: '#ffd9a0', rays: 0, haze: 0, vignette: 0.18,
};

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'mp4', resolution: 1080, fps: 30, duration: 60,
  bitrate: 8_000_000, quality: 'standard', stillFormat: 'png', stillQuality: 0.92,
};

export function makeAnimation(type: AnimationType, seed = 1): AnimationSettings {
  const loop = DEFAULT_LOOP[type] ?? 8;
  return {
    type, enabled: true, amplitude: 0.5, speed: 1, loop, phase: 0,
    direction: 90, turbulence: 0.45, seed, start: 0, end: 0,
  };
}

/** Natural cycle lengths - the Loop Manager harmonises these into one master cycle. */
export const DEFAULT_LOOP: Record<AnimationType, number> = {
  none: 8,
  'canopy-sway': 8,
  'grass-wind': 6,
  'stem-bend': 6,
  'water-flow': 8,
  'waterfall-flow': 4,
  ripple: 6,
  'flag-wave': 4,
  float: 10,
  spin: 12,
  pulse: 6,
  'lantern-glow': 5,
  'hearth-fire': 4,
  'coffee-steam': 8,
  'cloud-drift': 24,
  'water-shimmer': 8,
  parallax: 12,
};

export const ANIMATION_LABEL: Record<AnimationType, string> = {
  none: 'None',
  'canopy-sway': 'Branch & foliage sway',
  'grass-wind': 'Grass in wind',
  'stem-bend': 'Stem bending',
  'water-flow': 'Flowing water',
  'waterfall-flow': 'Waterfall flow',
  ripple: 'Surface ripple',
  'flag-wave': 'Cloth wave',
  float: 'Floating drift',
  spin: 'Rotation',
  pulse: 'Pulse / breathe',
  'lantern-glow': 'Lantern glow',
  'hearth-fire': 'Flickering hearth fire',
  'coffee-steam': 'Rising coffee steam',
  'cloud-drift': 'Cloud drift',
  'water-shimmer': 'Water shimmer',
  parallax: 'Parallax breathing',
};
