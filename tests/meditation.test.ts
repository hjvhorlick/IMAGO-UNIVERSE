import { describe, expect, it, vi } from 'vitest';
import {
  AmbienceEngine, BEDS, breathCycle, breathState, birdEvents, cricketPhrase, dropGap, hash01,
} from '../src/audio/ambience';
import type { AmbienceSettings, BreathPattern } from '../src/core/types';

const FULL: AmbienceSettings = {
  master: 0.8,
  beds: { water: 0.5, wind: 0.4, rain: 0.3, birds: 0.6, crickets: 0.2 },
};

/** Assert a generated value landed inside its natural band. */
const inRange = (v: number, lo: number, hi: number, what: string) => {
  expect(v, `${what} in ${lo}..${hi}`).toBeGreaterThanOrEqual(lo);
  expect(v, `${what} in ${lo}..${hi}`).toBeLessThanOrEqual(hi);
};

describe('the breathing guide mathematics', () => {
  const patterns: BreathPattern[] = ['calm', 'box', 'coherent'];

  it('offers three patterns whose cycles wrap without a jump', () => {
    for (const p of patterns) {
      const cycle = breathCycle(p);
      expect(cycle).toBeGreaterThanOrEqual(8);
      const a = breathState(p, 0);
      const b = breathState(p, cycle);
      expect(b.label, `${p} wraps to the same phase`).toBe(a.label);
      expect(b.scale).toBeCloseTo(a.scale, 9);
      expect(breathState(p, cycle + 1.23).scale).toBeCloseTo(breathState(p, 1.23).scale, 9);
    }
  });

  it('expands on the inhale, rests on the hold, settles on the exhale', () => {
    expect(breathState('calm', 0).label).toBe('Inhale');
    expect(breathState('calm', 0).scale).toBeCloseTo(0.45, 6);
    expect(breathState('calm', 2).scale).toBeGreaterThan(breathState('calm', 0.2).scale);
    expect(breathState('calm', 4).label).toBe('Exhale');
    expect(breathState('calm', 4).scale).toBeCloseTo(1, 6);
    expect(breathState('calm', 8).scale).toBeLessThan(breathState('calm', 5).scale);
    expect(breathState('box', 5).label).toBe('Hold');
    expect(breathState('box', 5).scale).toBeCloseTo(1, 6);
    expect(breathState('box', 13).label).toBe('Hold');
    expect(breathState('box', 13).scale).toBeCloseTo(0.45, 6);
    for (const p of patterns) {
      for (let k = 0; k < 240; k++) {
        const s = breathState(p, (k / 240) * breathCycle(p));
        expect(s.scale).toBeGreaterThanOrEqual(0.4);
        expect(s.scale).toBeLessThanOrEqual(1.05);
      }
    }
  });
});

describe('the synthesised soundscape schedules', () => {
  it('lists five mixable beds', () => {
    expect(BEDS.map((b) => b.id)).toEqual(['water', 'wind', 'rain', 'birds', 'crickets']);
  });

  it('sings bird phrases at natural gaps and whistle registers', () => {
    const a = birdEvents(7, 0, 60);
    expect(a).toEqual(birdEvents(7, 0, 60));           // deterministic per seed
    expect(a.length).toBeGreaterThan(5);
    expect(a.length).toBeLessThan(60);
    for (const ev of a) {
      expect(ev.gap).toBeGreaterThanOrEqual(1.2);
      expect(ev.gap).toBeLessThanOrEqual(6.7);
      let last = -1;
      for (const n of ev.notes) {
        expect(n.dt).toBeGreaterThanOrEqual(last);
        last = n.dt;
        inRange(n.f0, 1500, 5200, 'bird note start');
        inRange(n.f1, 1500, 5200, 'bird note end');
        expect(n.dur).toBeGreaterThan(0.05);
        expect(n.dur).toBeLessThan(0.3);
      }
    }
    expect(birdEvents(8, 0, 60)).not.toEqual(a);       // other seed, other song
  });

  it('keeps rain ticks and cricket chirrups in their natural bands', () => {
    for (let i = 0; i < 200; i++) {
      inRange(dropGap(3, i), 0.055, 0.165, 'rain tick gap');
      const c = cricketPhrase(3, i);
      inRange(c.gap, 0.9, 2.6, 'cricket gap');
      inRange(c.dur, 0.25, 0.5, 'cricket chirrup');
      const h = hash01(3, i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});


/* ------------------------------------------------------- a mock WebAudio */

/**
 * A stand-in audio context. The real graph cannot be exercised without a
 * browser, but the lifecycle can: which nodes are built, that the look-ahead
 * scheduler keeps firing, and - the part that matters - that stopping really
 * stops every running source and releases the context.
 */
function makeAudioWorld() {
  interface Rec { kind: string; started: number; stopped: number; selfEnding: boolean; }
  const sources: Rec[] = [];
  const intervals: { fn: () => void; cleared: boolean }[] = [];
  const timeouts: { fn: () => void; cleared: boolean }[] = [];

  const param = (value = 0) => {
    const p = {
      value,
      ramps: 0,
      setValueAtTime(v: number) { p.value = v; return p; },
      linearRampToValueAtTime(v: number) { p.value = v; p.ramps++; return p; },
      exponentialRampToValueAtTime(v: number) { p.value = v; p.ramps++; return p; },
      setTargetAtTime(v: number) { p.value = v; p.ramps++; return p; },
    };
    return p;
  };
  const node = (extra: Record<string, unknown> = {}) =>
    ({ connect() {}, disconnect() {}, ...extra });

  class MockContext {
    currentTime = 0;
    sampleRate = 8000;                 // small, so the noise buffers build fast
    state: string = 'running';
    closed = false;
    destination = node();
    resume = () => Promise.resolve();
    close = () => { this.closed = true; this.state = 'closed'; return Promise.resolve(); };
    createGain = () => node({ gain: param(1) });
    createBiquadFilter = () => node({ type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) });
    createStereoPanner = () => node({ pan: param(0) });
    createBuffer = (_ch: number, len: number) => ({ length: len, getChannelData: () => new Float32Array(len) });
    createOscillator = () => {
      const rec: Rec = { kind: 'osc', started: 0, stopped: 0, selfEnding: false };
      sources.push(rec);
      return node({
        type: 'sine', frequency: param(440), detune: param(0),
        start: () => { rec.started++; }, stop: () => { rec.stopped++; },
      });
    };
    createBufferSource = () => {
      const rec: Rec = { kind: 'buffer', started: 0, stopped: 0, selfEnding: false };
      sources.push(rec);
      return node({
        buffer: null, loop: false, playbackRate: param(1),
        start: (_at?: number, _off?: number, dur?: number) => {
          rec.started++;
          rec.selfEnding = typeof dur === 'number';   // a timed blip ends itself
        },
        stop: () => { rec.stopped++; },
      });
    };
    constructor() { contexts.push(this); }
  }
  const contexts: MockContext[] = [];

  const win = {
    AudioContext: MockContext,
    setInterval: (fn: () => void) => { intervals.push({ fn, cleared: false }); return intervals.length; },
    clearInterval: (id: number) => { const t = intervals[id - 1]; if (t) t.cleared = true; },
    setTimeout: (fn: () => void) => { timeouts.push({ fn, cleared: false }); return timeouts.length; },
    clearTimeout: (id: number) => { const t = timeouts[id - 1]; if (t) t.cleared = true; },
  };

  return {
    window: win,
    contexts,
    sources,
    /** Run the look-ahead scheduler, moving every context's clock on. */
    tick(dt = 0.25) {
      for (const c of contexts) if (!c.closed) c.currentTime += dt;
      for (const i of intervals.filter((x) => !x.cleared)) i.fn();
    },
    /** Run every pending fade/release/close timeout. */
    flush() {
      for (const t of timeouts.filter((x) => !x.cleared)) { t.cleared = true; t.fn(); }
    },
    count(kind: string) { return sources.filter((s) => s.kind === kind && s.started > 0).length; },
    /** Sources that were started, never end by themselves, and were never stopped. */
    leaked() { return sources.filter((s) => s.started > 0 && !s.selfEnding && s.stopped === 0).length; },
    liveIntervals() { return intervals.filter((i) => !i.cleared).length; },
  };
}


describe('the ambience engine without a media stack', () => {
  it('degrades to silence instead of failing', () => {
    const engine = new AmbienceEngine();
    expect(engine.supported, 'node has no WebAudio').toBe(false);
    expect(engine.start(FULL)).toBe(false);
    expect(engine.running).toBe(false);
    expect(() => engine.update(FULL)).not.toThrow();
    expect(() => engine.chime()).not.toThrow();
    expect(() => engine.stop()).not.toThrow();
  });
});

describe('the ambience engine against a mock audio context', () => {
  it('builds the beds, keeps scheduling, and leaves nothing running', () => {
    const world = makeAudioWorld();
    vi.stubGlobal('window', world.window);
    try {
      const engine = new AmbienceEngine();
      expect(engine.supported, 'WebAudio exists in this world').toBe(true);
      expect(engine.start(FULL)).toBe(true);
      expect(engine.running).toBe(true);
      expect(world.contexts.length).toBe(1);
      expect(world.liveIntervals(), 'the look-ahead scheduler is armed').toBe(1);
      const built = world.count('osc') + world.count('buffer');
      expect(built, 'noise beds and their LFOs are running').toBeGreaterThan(4);

      for (let i = 0; i < 16; i++) world.tick();          // four seconds of scheduling
      expect(world.count('osc'), 'bird phrases and cricket chirrups').toBeGreaterThan(built);
      expect(world.count('buffer'), 'rain droplets on top of the noise beds').toBeGreaterThan(6);

      const oscBefore = world.count('osc');
      engine.chime();                                      // the session bell
      const bell = world.sources.filter((x) => x.kind === 'osc').slice(oscBefore);
      expect(bell.length, 'a three-partial bell').toBe(3);
      expect(bell.every((x) => x.stopped > 0), 'each partial stops itself').toBe(true);

      engine.stop();
      expect(engine.running).toBe(false);
      expect(world.liveIntervals(), 'the scheduler is disarmed').toBe(0);
      world.flush();                                       // fades finish, context closes
      expect(world.leaked(), 'every running source was stopped').toBe(0);
      expect(world.contexts[0].closed, 'the context is released').toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never fires a burst of catch-up events after a quiet stretch', () => {
    const world = makeAudioWorld();
    vi.stubGlobal('window', world.window);
    try {
      const engine = new AmbienceEngine();
      engine.start({ master: 0.8, beds: { water: 0, wind: 0, rain: 0.5, birds: 0.5, crickets: 0.5 } });
      world.tick();
      const before = world.sources.length;
      world.contexts[0].currentTime += 120;                // a throttled tab, two minutes on
      world.tick();
      const burst = world.sources.length - before;
      // A few events for the horizon ahead, not two minutes' worth at once.
      expect(burst, 'no catch-up storm').toBeLessThan(30);
      expect(burst, 'but the beds do carry on').toBeGreaterThan(0);
      engine.stop();
      world.flush();
      expect(world.leaked()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rebuilds a bed that comes back up, and closes only the context it owns', () => {
    const world = makeAudioWorld();
    vi.stubGlobal('window', world.window);
    try {
      const engine = new AmbienceEngine();
      const quiet: AmbienceSettings = { master: 0.8, beds: { water: 0, wind: 0, rain: 0, birds: 0, crickets: 0 } };
      engine.start(quiet);
      expect(world.count('buffer'), 'no bed, no noise source').toBe(0);

      engine.update({ ...quiet, beds: { ...quiet.beds, birds: 0.5 } });
      for (let i = 0; i < 8; i++) world.tick();
      const withBirds = world.count('osc');
      expect(withBirds, 'the bird bed schedules phrases').toBeGreaterThan(0);

      engine.update(quiet);                                // turn the bed back down
      world.flush();
      expect(world.leaked(), 'the bed released its nodes').toBe(0);

      engine.update({ ...quiet, beds: { ...quiet.beds, birds: 0.4 } });
      for (let i = 0; i < 16; i++) world.tick();
      expect(world.count('osc'), 'and it can be rebuilt').toBeGreaterThan(withBirds);

      engine.stop();
      expect(engine.start(FULL), 'a restart works').toBe(true);
      expect(world.contexts.length, 'a fresh context').toBe(2);
      world.flush();
      expect(world.contexts[0].closed, 'the old context is closed').toBe(true);
      expect(world.contexts[1].closed, 'the new one keeps playing').toBe(false);
      expect(engine.running).toBe(true);
      engine.stop();
      world.flush();
      expect(world.leaked()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
