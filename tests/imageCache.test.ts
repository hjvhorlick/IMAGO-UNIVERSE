/** Image loading must stay gentle: bounded concurrency, shared decodes,
 * failed ids on a cooldown, and honest reporting of what actually arrived. */
import { describe, expect, it, vi } from 'vitest';
import { ImageCache } from '../src/render/imageCache';
import type { AssetMeta } from '../src/core/types';

const meta = (id: string): AssetMeta => ({
  id, name: id, style: 'enchanted', layer: 'middle', category: 'creatures',
  themes: [], tags: [], origin: 'painted', file: `${id}.webp`, thumb: `${id}.webp`,
  format: 'image/webp', width: 8, height: 4, alpha: true, depth: 0.5,
  groundContact: 1, perspective: 'eye-level', lighting: 'unknown',
  palette: ['#888'], defaultScale: 0.4,
  placement: { grounded: true, minDepth: 0.1, maxDepth: 0.9 },
  animations: [], rig: {}, variants: [], notes: '', bytes: 100,
} as AssetMeta);

function harness(ids: string[], opts: { fail?: string[]; delay?: number } = {}) {
  let inflight = 0, peak = 0;
  const calls = new Map<string, number>();
  vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 4, close() {} }));
  vi.stubGlobal('fetch', async (url: string) => {
    const id = url.replace('test://', '');
    calls.set(id, (calls.get(id) ?? 0) + 1);
    inflight++; peak = Math.max(peak, inflight);
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    inflight--;
    const bad = opts.fail?.includes(id);
    return { ok: !bad, status: bad ? 404 : 200, statusText: 'x', blob: async () => new Blob(['x']) } as Response;
  });
  const known = new Map(ids.map((id) => [id, meta(id)]));
  const library = { get: (id: string) => known.get(id), url: (m: AssetMeta) => `test://${m.id}` };
  const cache = new ImageCache(library as never);
  return { cache, calls, peakOf: () => peak };
}

describe('image cache loading', () => {
  it('decodes each asset once and shares it', async () => {
    const { cache, calls } = harness(['a', 'b']);
    expect(await cache.ensure(['a', 'a', 'b'])).toBe(2);
    expect(calls.get('a')).toBe(1);
    expect(cache.peek('a')).not.toBeNull();
    expect(await cache.ensure(['a'])).toBe(0); // already resident
    expect(cache.stats.count).toBe(2);
  });

  it('bounds concurrent decodes so a full world cannot stall the tab', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `img${i}`);
    const { cache, peakOf } = harness(ids, { delay: 15 });
    cache.maxConcurrent = 3;
    await cache.ensure(ids);
    expect(peakOf()).toBeLessThanOrEqual(3);
    expect(cache.stats.count).toBe(12);
  });

  it('puts failed loads on a cooldown instead of retrying every frame', async () => {
    const { cache, calls } = harness(['good', 'bad'], { fail: ['bad'] });
    expect(await cache.ensure(['bad'])).toBe(0);
    expect(calls.get('bad')).toBe(1);
    // Render-loop misses must not hammer the missing file...
    for (let i = 0; i < 50; i++) expect(cache.peek('bad')).toBeNull();
    expect(calls.get('bad')).toBe(1);
    expect(cache.stats.failed).toBe(1);
    // ...but once the cooldown passes it is worth another try.
    cache.retryAfterMs = 25;
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.peek('bad')).toBeNull();
    expect(calls.get('bad')).toBe(2);
    expect(await cache.ensure(['good'])).toBe(1);
  });

  it('reports activity so the interface can show progress', async () => {
    const { cache } = harness(['a', 'b'], { delay: 10 });
    let events = 0;
    cache.onActivity = () => { events++; };
    const p = cache.ensure(['a', 'b']);
    expect(cache.stats.pending).toBeGreaterThan(0);
    await p;
    expect(events).toBeGreaterThan(0);
    expect(cache.stats.pending).toBe(0);
  });
});
