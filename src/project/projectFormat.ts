/**
 * EDITABLE PROJECT FORMAT - `.sceneproject`
 * =========================================
 * A ZIP container that holds the *whole* environment, never a flattened image:
 *
 *   project.json          the complete scene graph (layers, transforms, crops,
 *                         animation settings, loop lengths, lighting, export
 *                         settings, metadata)
 *   assets/manifest.json  metadata for every asset the scene references
 *   assets/files/<id>     the actual artwork bytes
 *   audio/<id>.<ext>      the imported sound track, if the scene has one
 *   preview.jpg           a small thumbnail for the project shelf
 *
 * Because the artwork travels inside the file, a project does not depend on
 * blob URLs, on IndexedDB, on the original download folder or on a server.
 * Copy the file to another machine and it opens identically.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { clamp } from '../core/util';
import type { AssetLibrary } from '../assets/library';
import type { AssetMeta, Scene, SceneAudio, SceneNode } from '../core/types';
import {
  DEFAULT_ADJUST, DEFAULT_CROP, DEFAULT_EXPORT, DEFAULT_LIGHTING, DEFAULT_SHADOW,
} from '../core/types';
import { uid } from '../core/util';
import { withSingleBackground } from '../core/sceneRules';

export const PROJECT_FORMAT = 'imago.sceneproject';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.sceneproject';

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  generator: string;
  savedAt: string;
  scene: Scene;
  /** Archive path of the embedded sound track. Absent when the scene is silent. */
  sound?: { file: string };
}

export interface LoadedProject {
  scene: Scene;
  missingAssets: string[];
  warnings: string[];
  /**
   * The sound track that travelled inside the file, or null. The caller decides
   * where it goes (the browser's audio store) so this module stays free of IndexedDB.
   */
  sound: Blob | null;
}

const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/flac': 'flac',
};
function audioExt(mime: string): string { return AUDIO_EXT[mime] ?? 'audio'; }

function safeName(id: string) { return id.replace(/[^a-zA-Z0-9._-]/g, '_'); }

async function assetBytes(library: AssetLibrary, meta: AssetMeta): Promise<Uint8Array> {
  const local = library.blob(meta.id);
  if (local) return new Uint8Array(await local.arrayBuffer());
  const res = await fetch(library.url(meta));
  if (!res.ok) throw new Error(`Could not read artwork "${meta.name}" (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Package a scene. `sound` is the bytes of `scene.audio`, supplied by the caller
 * (usually loaded from the browser's audio store). If the scene has audio but no
 * bytes are supplied, the reference is kept and the file opens with a warning.
 */
export async function packageProject(
  scene: Scene, library: AssetLibrary, preview?: Blob, sound?: Blob | null,
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const referenced = new Set<string>();
  for (const n of scene.nodes) if (n.kind === 'asset' && n.assetId) referenced.add(n.assetId);

  const metas: AssetMeta[] = [];
  for (const id of referenced) {
    const meta = library.get(id);
    if (!meta) continue;
    const bytes = await assetBytes(library, meta);
    const ext = meta.format.includes('png') ? 'png' : meta.format.includes('jpeg') ? 'jpg' : 'webp';
    files[`assets/files/${safeName(id)}.${ext}`] = bytes;
    metas.push({ ...meta, file: `assets/files/${safeName(id)}.${ext}`, thumb: `assets/files/${safeName(id)}.${ext}` });
  }

  let soundEntry: ProjectFile['sound'];
  if (scene.audio && sound) {
    const file = `audio/${safeName(scene.audio.id)}.${audioExt(scene.audio.mime)}`;
    files[file] = new Uint8Array(await sound.arrayBuffer());
    soundEntry = { file };
  }

  const doc: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    generator: 'Imago Universe 0.1',
    savedAt: new Date().toISOString(),
    scene,
    ...(soundEntry ? { sound: soundEntry } : {}),
  };
  files['project.json'] = strToU8(JSON.stringify(doc, null, 1));
  files['assets/manifest.json'] = strToU8(JSON.stringify({ schema: 'imago.asset-library/1', assets: metas }, null, 1));
  files['README.txt'] = strToU8(
    'Imago Universe editable project.\n\n'
    + 'Open this file with Imago Universe to continue editing. The artwork inside\n'
    + 'assets/files is the original, unmodified source art; all cropping, colour and\n'
    + 'animation settings live in project.json and are applied non-destructively.\n'
    + (soundEntry ? 'The sound track in audio/ is the file you imported; it plays in the preview.\n' : ''),
  );
  if (preview) files['preview.jpg'] = new Uint8Array(await preview.arrayBuffer());

  // Artwork is already compressed (WebP/PNG/JPEG); storing avoids a slow,
  // pointless second compression pass over megabytes of image data.
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

export async function readProject(buffer: ArrayBuffer, library: AssetLibrary): Promise<LoadedProject> {
  const warnings: string[] = [];
  const missing: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error('This file is not a readable .sceneproject archive.');
  }
  const docRaw = entries['project.json'];
  if (!docRaw) throw new Error('The archive does not contain project.json - it is not an Imago project.');
  let doc: ProjectFile;
  try {
    doc = JSON.parse(strFromU8(docRaw)) as ProjectFile;
  } catch {
    throw new Error('project.json is corrupt and could not be parsed.');
  }
  if (doc.format !== PROJECT_FORMAT) throw new Error(`Unrecognised project format "${doc.format}".`);
  if (doc.version > PROJECT_VERSION) {
    warnings.push(`This project was saved by a newer version (format ${doc.version}). Some settings may be ignored.`);
  }

  // Restore embedded artwork before the scene tries to render.
  const manifestRaw = entries['assets/manifest.json'];
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(strFromU8(manifestRaw)) as { assets: AssetMeta[] };
      for (const meta of manifest.assets) {
        const bytes = entries[meta.file];
        if (!bytes) { missing.push(meta.name); continue; }
        // Always prefer the bytes that travelled inside the project. That way
        // the scene restores exactly as saved even if the local library has
        // since been updated, trimmed or is missing entirely.
        library.registerBlob(meta.id, new Blob([bytes as BlobPart], { type: meta.format }));
        library.registerMeta(meta);
      }
    } catch (err) {
      warnings.push('Embedded asset manifest could not be read; falling back to the local library.');
      console.warn(err);
    }
  }

  const scene = migrate(doc.scene, warnings);
  // Older files may hold more than one background; a scene only ever has one.
  const single = withSingleBackground(scene.nodes);
  if (single.removed) {
    scene.nodes = single.nodes;
    warnings.push(`The project had ${single.removed} extra background(s); kept the first.`);
  }
  for (const n of scene.nodes) {
    if (n.kind === 'asset' && n.assetId && !library.get(n.assetId)) missing.push(n.assetId);
  }

  let sound: Blob | null = null;
  if (doc.sound?.file && scene.audio) {
    const bytes = entries[doc.sound.file];
    if (bytes) sound = new Blob([bytes as BlobPart], { type: scene.audio.mime });
    else warnings.push(`The sound "${scene.audio.name}" is missing from this file.`);
  }
  return { scene, missingAssets: Array.from(new Set(missing)), warnings, sound };
}

/** Keep the sound settings a user chose. A missing or malformed block means silence. */
function migrateAudio(raw: unknown): SceneAudio | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<SceneAudio>;
  if (typeof a.id !== 'string' || !a.id) return null;
  return {
    id: a.id,
    name: typeof a.name === 'string' && a.name ? a.name : 'Sound',
    duration: num(a.duration, 0),
    volume: Math.min(1, Math.max(0, num(a.volume, 0.8))),
    loop: a.loop !== false,
    crossfade: Math.max(0, num(a.crossfade, 1.5)),
    offset: Math.max(0, num(a.offset, 0)),
    mime: typeof a.mime === 'string' && a.mime ? a.mime : 'audio/mpeg',
    bytes: num(a.bytes, 0),
  };
}

const BED_IDS = ['water', 'wind', 'rain', 'birds', 'crickets'];
function migrateAmbience(input: Scene['ambience']): Scene['ambience'] {
  if (!input || typeof input !== 'object') return null;
  const beds = {} as Record<string, number>;
  for (const id of BED_IDS) beds[id] = clamp(Number((input.beds as Record<string, unknown> | undefined)?.[id] ?? 0), 0, 1);
  return { master: clamp(Number(input.master ?? 0.7), 0, 1), beds: beds as never };
}
function migrateMeditation(input: Scene['meditation']): Scene['meditation'] {
  if (!input || typeof input !== 'object') return null;
  const pattern = input.pattern === 'box' || input.pattern === 'coherent' ? input.pattern : 'calm';
  return { pattern, guide: input.guide === true, sessionMin: clamp(Number(input.sessionMin ?? 0), 0, 180) };
}

/** Fill in anything a older/partial file may be missing, so loading never throws. */
function migrate(input: Scene, warnings: string[]): Scene {
  if (!input || typeof input !== 'object') throw new Error('The project has no scene data.');
  const scene: Scene = {
    id: input.id || uid('scene'),
    name: input.name || 'Restored world',
    styleId: input.styleId || 'enchanted',
    theme: input.theme || 'enchanted',
    canvas: {
      width: input.canvas?.width || 1920,
      height: input.canvas?.height || 1080,
      aspect: input.canvas?.aspect || '16:9',
      backdrop: input.canvas?.backdrop || '#0b0f14',
      clipToCanvas: input.canvas?.clipToCanvas ?? true,
    },
    nodes: [],
    lighting: { ...DEFAULT_LIGHTING, ...(input.lighting || {}) },
    audio: migrateAudio(input.audio),
    ambience: migrateAmbience(input.ambience),
    meditation: migrateMeditation(input.meditation),
    worldId: typeof input.worldId === 'string' ? input.worldId : null,
    exportSettings: { ...DEFAULT_EXPORT, ...(input.exportSettings || {}) },
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  for (const raw of nodes) {
    if (!raw || !raw.id) { warnings.push('Skipped one malformed object.'); continue; }
    const node: SceneNode = {
      id: raw.id,
      kind: raw.kind === 'effect' ? 'effect' : 'asset',
      layer: raw.layer || 'middle',
      name: raw.name || 'Object',
      assetId: raw.assetId,
      x: num(raw.x, 0), y: num(raw.y, 0),
      width: num(raw.width, 100), height: num(raw.height, 100),
      rotation: num(raw.rotation, 0),
      flipX: !!raw.flipX,
      opacity: num(raw.opacity, 1),
      visible: raw.visible !== false,
      locked: !!raw.locked,
      order: num(raw.order, 0),
      depth: num(raw.depth, 0.5),
      crop: { ...DEFAULT_CROP, ...(raw.crop || {}) },
      adjust: { ...DEFAULT_ADJUST, ...(raw.adjust || {}) },
      shadow: { ...DEFAULT_SHADOW, ...(raw.shadow || {}) },
      blend: raw.blend || 'source-over',
      animation: raw.animation ?? null,
      effect: raw.effect,
    };
    scene.nodes.push(node);
  }
  return scene;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function projectFilename(scene: Scene): string {
  const base = (scene.name || 'world').trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-').toLowerCase();
  return `${base || 'world'}${PROJECT_EXTENSION}`;
}
