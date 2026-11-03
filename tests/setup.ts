/**
 * Test environment shims. The domain modules are deliberately browser-light:
 * only these few globals need standing in for a real browser.
 */
import { createCanvas } from '@napi-rs/canvas';

const g = globalThis as unknown as Record<string, unknown>;

if (!g.localStorage) {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

const urlApi = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (s: string) => void };
if (typeof urlApi.createObjectURL !== 'function') {
  let n = 0;
  urlApi.createObjectURL = () => `blob:test/${++n}`;
  urlApi.revokeObjectURL = () => {};
}

if (!g.OffscreenCanvas) {
  g.OffscreenCanvas = function (w: number, h: number) { return createCanvas(w, h); };
}
if (!g.document) {
  g.document = { createElement: (tag: string) => (tag === 'canvas' ? createCanvas(1, 1) : {}) };
}
