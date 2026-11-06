/**
 * Asset library + style manager.
 *
 * The runtime library is driven entirely by `public/library/manifest.json`, so
 * new artwork can be added by the offline preparation pipeline without touching
 * application code. Imported artwork is registered at runtime and persisted in
 * IndexedDB, and is embedded into saved projects for portability.
 */
import type { AssetManifest, AssetMeta, LayerId, StyleMeta } from '../core/types';
import { uid } from '../core/util';
import { idbGet, idbSet, idbDel, idbKeys } from '../project/idb';

const FAV_KEY = 'imago.favourites.v1';
const IMPORT_STORE = 'importedAssets';

export class AssetLibrary {
  manifest: AssetManifest = { schema: 'imago.asset-library/1', styles: [], assets: [] };
  favourites = new Set<string>();
  baseUrl: string;
  /** Assets restored from a project file or imported by the user. */
  private blobUrls = new Map<string, string>();
  private blobs = new Map<string, Blob>();

  constructor(baseUrl = 'library/') {
    this.baseUrl = baseUrl;
    try {
      this.favourites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
    } catch { /* favourites are optional */ }
  }

  async load(): Promise<void> {
    const res = await fetch(`${this.baseUrl}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Asset manifest could not be loaded (${res.status})`);
    this.manifest = (await res.json()) as AssetManifest;
    await this.restoreImports();
  }

  get styles(): StyleMeta[] { return this.manifest.styles; }
  get assets(): AssetMeta[] { return this.manifest.assets; }

  style(id: string): StyleMeta | undefined { return this.styles.find((s) => s.id === id); }
  get(id: string | undefined): AssetMeta | undefined {
    return id ? this.assets.find((a) => a.id === id) : undefined;
  }

  /**
   * Style gate for artwork. Atmospheric effects bypass the asset library
   * and remain universal; room art retains its foreground source metadata.
   */
  forStyle(styleId: string, layer?: LayerId): AssetMeta[] {
    return this.assets.filter((a) => {
      if (a.style !== styleId && a.style !== 'universal') return false;
      // Companions (waterfall splash and mist) are loaded by their waterfall, never placed directly.
      if (a.rig?.type === 'companion') return false;
      if (layer && layer !== 'atmosphere' && a.layer !== layer) return false;
      return true;
    });
  }

  search(styleId: string, layer: LayerId, opts: {
    query?: string; category?: string; theme?: string; favouritesOnly?: boolean;
  } = {}): AssetMeta[] {
    const q = (opts.query || '').trim().toLowerCase();
    return this.forStyle(styleId, layer).filter((a) => {
      if (opts.category && opts.category !== 'all' && a.category !== opts.category) return false;
      if (opts.theme && opts.theme !== 'all' && !a.themes.includes(opts.theme)) return false;
      if (opts.favouritesOnly && !this.favourites.has(a.id)) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.category.includes(q) ||
        a.tags.some((t) => t.includes(q)) ||
        a.themes.some((t) => t.includes(q))
      );
    });
  }

  categories(styleId: string, layer: LayerId): string[] {
    return Array.from(new Set(this.forStyle(styleId, layer).map((a) => a.category))).sort();
  }

  themes(styleId: string, layer: LayerId): string[] {
    return Array.from(new Set(this.forStyle(styleId, layer).flatMap((a) => a.themes))).sort();
  }

  toggleFavourite(id: string) {
    if (this.favourites.has(id)) this.favourites.delete(id); else this.favourites.add(id);
    localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(this.favourites)));
  }

  /* ------------------------------------------------------------------ urls */

  url(meta: AssetMeta, thumb = false): string {
    const local = this.blobUrls.get(meta.id);
    if (local) return local;
    return this.baseUrl + (thumb ? meta.thumb : meta.file);
  }

  hasBlob(id: string) { return this.blobs.has(id); }
  blob(id: string) { return this.blobs.get(id); }

  registerBlob(id: string, blob: Blob) {
    const old = this.blobUrls.get(id);
    if (old) URL.revokeObjectURL(old);
    this.blobs.set(id, blob);
    this.blobUrls.set(id, URL.createObjectURL(blob));
  }

  /** Register metadata coming from a project package (does not overwrite built-ins). */
  registerMeta(meta: AssetMeta) {
    const i = this.assets.findIndex((a) => a.id === meta.id);
    if (i >= 0) this.assets[i] = meta; else this.assets.push(meta);
    if (meta.style !== 'universal' && !this.styles.some((s) => s.id === meta.style)) {
      this.styles.push({
        id: meta.style, name: meta.style, subtitle: 'Imported collection',
        description: 'Artwork imported with this project.', swatches: meta.palette,
        lighting: meta.lighting, reference: {
          background: '', tree: '', structure: '', plant: '', ground: '',
        }, complete: false,
      });
    }
  }

  /* --------------------------------------------------------------- imports */

  async importFile(file: File, opts: {
    name: string; layer: Exclude<LayerId, 'atmosphere'>; style: string; category: string;
  }): Promise<AssetMeta> {
    const bitmap = await createImageBitmap(file);
    const id = `imported.${uid('a')}`;
    const meta: AssetMeta = {
      id, name: opts.name || file.name.replace(/\.[^.]+$/, ''),
      style: opts.style, layer: opts.layer, category: opts.category || 'imported',
      themes: ['custom'], tags: ['imported'], origin: 'imported',
      file: `imported/${id}`, thumb: `imported/${id}`, format: file.type || 'image/png',
      width: bitmap.width, height: bitmap.height, alpha: true,
      depth: opts.layer === 'background' ? 0 : opts.layer === 'middle' ? 0.5 : 0.85,
      groundContact: 1, perspective: 'eye-level', lighting: 'unknown',
      palette: ['#888888'], defaultScale: opts.layer === 'background' ? 1 : 0.4,
      placement: { grounded: opts.layer !== 'background', minDepth: 0.1, maxDepth: 0.95 },
      animations: opts.layer === 'background'
        ? ['cloud-drift', 'parallax'] : ['grass-wind', 'stem-bend', 'float', 'spin', 'pulse'],
      rig: { type: opts.layer === 'background' ? 'background' : 'bend', anchor: [0.5, 1], stiffness: 0.2 },
      variants: [], notes: 'Imported by the user. Original file is never modified.',
      bytes: file.size,
    };
    bitmap.close?.();
    this.registerBlob(id, file);
    this.registerMeta(meta);
    await idbSet(IMPORT_STORE, id, { meta, blob: file });
    return meta;
  }

  async removeImported(id: string) {
    this.manifest.assets = this.manifest.assets.filter((a) => a.id !== id);
    const url = this.blobUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.blobUrls.delete(id);
    this.blobs.delete(id);
    await idbDel(IMPORT_STORE, id);
  }

  private async restoreImports() {
    try {
      const keys = await idbKeys(IMPORT_STORE);
      for (const key of keys) {
        const rec = await idbGet<{ meta: AssetMeta; blob: Blob }>(IMPORT_STORE, String(key));
        if (!rec) continue;
        this.registerBlob(rec.meta.id, rec.blob);
        this.registerMeta(rec.meta);
      }
    } catch (err) {
      console.warn('[library] could not restore imported assets', err);
    }
  }
}
