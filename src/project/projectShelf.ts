/**
 * Local project shelf (IndexedDB) + file save/open helpers.
 *
 * The shelf is a convenience so a session survives a browser restart. The
 * `.sceneproject` file on disk remains the authoritative, portable copy.
 */
import type { AssetLibrary } from '../assets/library';
import type { Scene } from '../core/types';
import { downloadBlob } from '../core/util';
import { idbDel, idbGet, idbSet, idbKeys, idbAvailable } from './idb';
import { packageProject, projectFilename, readProject } from './projectFormat';
import type { LoadedProject } from './projectFormat';
import { loadSceneSound } from '../audio/audioStore';

export interface ShelfEntry {
  id: string;
  name: string;
  updatedAt: string;
  styleId: string;
  objectCount: number;
  preview?: string;      // data URL
  data: ArrayBuffer;
}

export interface ShelfSummary extends Omit<ShelfEntry, 'data'> {}

const key = (id: string) => `project:${id}`;

export class ProjectShelf {
  available = false;

  constructor(private library: AssetLibrary) {}

  async init() { this.available = await idbAvailable(); }

  async save(scene: Scene, preview?: Blob): Promise<void> {
    if (!this.available) return;
    const data = await packageSceneFile(scene, this.library, preview);
    const entry: ShelfEntry = {
      id: scene.id,
      name: scene.name,
      updatedAt: new Date().toISOString(),
      styleId: scene.styleId,
      objectCount: scene.nodes.length,
      preview: preview ? await blobToDataUrl(preview) : undefined,
      data: await data.arrayBuffer(),
    };
    await idbSet('projects', key(scene.id), entry);
  }

  async list(): Promise<ShelfSummary[]> {
    if (!this.available) return [];
    const keys = await idbKeys('projects');
    const out: ShelfSummary[] = [];
    for (const k of keys) {
      const e = await idbGet<ShelfEntry>('projects', String(k));
      if (e) out.push({ id: e.id, name: e.name, updatedAt: e.updatedAt, styleId: e.styleId, objectCount: e.objectCount, preview: e.preview });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async open(id: string): Promise<LoadedProject | null> {
    const e = await idbGet<ShelfEntry>('projects', key(id));
    if (!e) return null;
    return readProject(e.data, this.library);
  }

  async remove(id: string) { await idbDel('projects', key(id)); }
}

/** Package a scene together with its imported sound, if it has one. */
export async function packageSceneFile(scene: Scene, library: AssetLibrary, preview?: Blob): Promise<Blob> {
  return packageProject(scene, library, preview, await loadSceneSound(scene.audio));
}

export async function saveProjectToFile(scene: Scene, library: AssetLibrary, preview?: Blob) {
  const blob = await packageSceneFile(scene, library, preview);
  downloadBlob(blob, projectFilename(scene));
  return blob;
}

export async function openProjectFromFile(file: File, library: AssetLibrary): Promise<LoadedProject> {
  return readProject(await file.arrayBuffer(), library);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
