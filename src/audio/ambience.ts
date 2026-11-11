/**
 * SYNTHESISED AMBIENCE - water, wind, rain, birds and crickets.
 *
 * Every soundscape is generated with WebAudio at runtime: filtered noise beds
 * for water, wind and rain, plus scheduled note phrases for birds and insect
 * pulses. No audio assets, no network, no AI - and nothing here is required
 * for the visual product: audio failure must never take the editor down.
 *
 * The scheduling mathematics (phrase shapes, gaps, frequencies, breathing
 * phases) lives in pure exported functions so the test suite can verify the
 * behaviour of the soundscape without a media stack.
 */
import type { AmbienceBedId, AmbienceSettings, BreathPattern } from '../core/types';
import { clamp } from '../core/util';

export const BEDS: { id: AmbienceBedId; label: string; hint: string }[] = [
  { id: 'water', label: 'Water', hint: 'Lake, stream or river murmur' },
  { id: 'wind', label: 'Wind', hint: 'Slow gusts through leaves' },
  { id: 'rain', label: 'Rain', hint: 'Steady rain with droplet ticks' },
  { id: 'birds', label: 'Birds', hint: 'Distant songbird phrases' },
  { id: 'crickets', label: 'Crickets', hint: 'Evening insect pulse' },
];

export const DEFAULT_AMBIENCE: AmbienceSettings = {
  master: 0.7,
  beds: { water: 0, wind: 0, rain: 0, birds: 0, crickets: 0 },
};

/** A gentle starting mix for scenes that have no ambience configured yet. */
export const MEADOW_AMBIENCE: AmbienceSettings = {
  master: 0.7,
  beds: { water: 0.35, wind: 0.25, rain: 0, birds: 0.45, crickets: 0 },
};

/* -------------------------------------------------- deterministic hashing */

export function hash01(seed: number, i: number, k = 0): number {
  let n = (seed * 7919 + i * 104729 + k * 15485863) | 0;
  n = Math.imul(n ^ (n >>> 15), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------ bird phrases */

export interface BirdNote { dt: number; f0: number; f1: number; dur: number; gain: number; }
export interface BirdPhrase { gap: number; notes: BirdNote[]; }
export interface BirdEvent extends BirdPhrase { t: number; }

/** One songbird phrase: 1-4 notes, whistled sweeps between 1.9 and 4.5 kHz. */
export function birdPhrase(seed: number, i: number): BirdPhrase {
  const count = 1 + Math.floor(hash01(seed, i, 2) * 4);
  const notes: BirdNote[] = [];
  let dt = 0;
  for (let j = 0; j < count; j++) {
    const f0 = 1900 + hash01(seed, i * 7 + j, 3) * 2600;
    const sweep = (hash01(seed, i * 7 + j, 4) - 0.42) * 1500;
    notes.push({
      dt,
      f0,
      f1: clamp(f0 + sweep, 1500, 5200),
      dur: 0.07 + hash01(seed, i * 7 + j, 5) * 0.16,
      gain: 0.45 + hash01(seed, i * 7 + j, 6) * 0.55,
    });
    dt += 0.1 + hash01(seed, i * 7 + j, 7) * 0.18;
  }
  return { gap: 1.2 + hash01(seed, i, 8) * 5.5, notes };
}

export function birdEvents(seed: number, from: number, to: number): BirdEvent[] {
  const out: BirdEvent[] = [];
  let t = from + hash01(seed, 0, 1) * 2;
  for (let i = 0; t < to && i < 4000; i++) {
    const p = birdPhrase(seed, i);
    if (t >= from) out.push({ t, ...p });
    t += p.gap;
  }
  return out;
}

/** Rain droplet ticks: short filtered noise blips, 6-18 per second. */
export function dropGap(seed: number, i: number): number {
  return 0.055 + hash01(seed, i, 11) * 0.11;
}
export function dropFreq(seed: number, i: number): number {
  return 1200 + hash01(seed, i, 12) * 2400;
}

/** Cricket chirrups: a pulsed train every 0.9-2.6 s, lasting 0.25-0.5 s. */
export function cricketPhrase(seed: number, i: number): { gap: number; dur: number } {
  return { gap: 0.9 + hash01(seed, i, 13) * 1.7, dur: 0.25 + hash01(seed, i, 14) * 0.25 };
}

/* ------------------------------------------------------------ breathing */

export const BREATH_PATTERNS: Record<BreathPattern, { label: string; phases: [string, number][] }> = {
  calm: { label: 'Calm 4-6', phases: [['Inhale', 4], ['Exhale', 6]] },
  box: { label: 'Box 4-4-4-4', phases: [['Inhale', 4], ['Hold', 4], ['Exhale', 4], ['Hold', 4]] },
  coherent: { label: 'Coherent 5-5', phases: [['Inhale', 5], ['Exhale', 5]] },
};

export function breathCycle(pattern: BreathPattern): number {
  return BREATH_PATTERNS[pattern].phases.reduce((s, p) => s + p[1], 0);
}

export interface BreathState { label: string; index: number; progress: number; scale: number; }

const SMALL = 0.45, FULL = 1;

/** The guide ring's phase and size at cycle time t (seconds). Wraps exactly. */
export function breathState(pattern: BreathPattern, t: number): BreathState {
  const phases = BREATH_PATTERNS[pattern].phases;
  const cycle = breathCycle(pattern);
  let x = ((t % cycle) + cycle) % cycle;
  let i = 0;
  while (x >= phases[i][1]) { x -= phases[i][1]; i = (i + 1) % phases.length; }
  const [label, dur] = phases[i];
  const p = dur > 0 ? x / dur : 0;
  const ease = p * p * (3 - 2 * p);
  let scale: number;
  if (label === 'Inhale') scale = SMALL + (FULL - SMALL) * ease;
  else if (label === 'Exhale') scale = FULL - (FULL - SMALL) * ease;
  else scale = phases[(i - 1 + phases.length) % phases.length][0] === 'Inhale' ? FULL : SMALL;
  return { label, index: i, progress: p, scale };
}

/* ------------------------------------------------------------ the engine */

interface BedNodes { gain: GainNode; sources: AudioScheduledSourceNode[]; }

export class AmbienceEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private beds = new Map<AmbienceBedId, BedNodes>();
  private buffers = new Map<string, AudioBuffer>();
  private timer = 0;
  private counters: Record<string, number> = {};
  private nextAt: Record<string, number> = {};
  private seed = 4711;

  get supported(): boolean {
    return typeof window !== 'undefined'
      && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  }
  get running(): boolean { return !!this.ctx; }

  start(s: AmbienceSettings): boolean {
    if (!this.supported) return false;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try { this.ctx = new Ctor(); } catch { return false; }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
    }
    void this.ctx.resume?.();
    this.update(s);
    return true;
  }

  update(s: AmbienceSettings) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(clamp(s.master, 0, 1), now, 0.4);
    for (const bed of BEDS) {
      const v = clamp(s.beds[bed.id] ?? 0, 0, 1);
      const have = this.beds.get(bed.id);
      if (v > 0.004 && !have) this.beds.set(bed.id, this.build(bed.id));
      const node = this.beds.get(bed.id);
      if (node) {
        node.gain.gain.setTargetAtTime(v, now, 0.6);
        if (v <= 0.004) this.destroy(bed.id);
      }
    }
    if (!this.timer) this.timer = window.setInterval(() => this.schedule(), 250);
  }

  stop() {
    if (this.timer) { window.clearInterval(this.timer); this.timer = 0; }
    const ctx = this.ctx, master = this.master;
    for (const id of [...this.beds.keys()]) this.destroy(id);
    this.nextAt = {};
    this.buffers.clear();
    if (!ctx || !master) return;
    this.ctx = null; this.master = null;
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    // Let the fade be heard, then release the context: a running AudioContext
    // costs CPU even when silent, and nothing else holds a reference to it.
    window.setTimeout(() => { void ctx.close().catch(() => {}); }, 900);
  }

  /** A soft two-partial bell, used to close a meditation session. */
  chime() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const [freq, amp] of [[660, 0.5], [990, 0.22], [1320, 0.08]] as const) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + 2.8);
    }
  }

  /* ------------------------------------------------------------- internals */

  private noise(kind: 'white' | 'pink' | 'brown'): AudioBuffer {
    const cached = this.buffers.get(kind);
    if (cached && this.ctx) return cached;
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.6;
      else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
      else { last = (last + 0.08 * w) / 1.08; d[i] = last * 1.8; }
    }
    this.buffers.set(kind, buf);
    return buf;
  }

  private loopSource(kind: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise(kind);
    src.loop = true;
    return src;
  }

  private build(id: AmbienceBedId): BedNodes {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master!);
    const sources: AudioScheduledSourceNode[] = [];
    const lfo = (freq: number, depth: number, target: AudioParam) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq; g.gain.value = depth;
      o.connect(g); g.connect(target); o.start();
      sources.push(o);
    };
    if (id === 'water') {
      const src = this.loopSource('brown');
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.7;
      const inner = ctx.createGain(); inner.gain.value = 0.9;
      src.connect(lp); lp.connect(inner); inner.connect(gain); src.start(); sources.push(src);
      lfo(0.06, 150, lp.frequency);
      const shim = this.loopSource('pink');
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.1;
      const sg = ctx.createGain(); sg.gain.value = 0.22;
      shim.connect(bp); bp.connect(sg); sg.connect(gain); shim.start(); sources.push(shim);
      lfo(0.043, 0.12, sg.gain);
    } else if (id === 'wind') {
      const src = this.loopSource('pink');
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.55;
      const inner = ctx.createGain(); inner.gain.value = 0.65;
      src.connect(bp); bp.connect(inner); inner.connect(gain); src.start(); sources.push(src);
      lfo(0.05, 240, bp.frequency);
      lfo(0.083, 0.3, inner.gain);
    } else if (id === 'rain') {
      const src = this.loopSource('white');
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
      const inner = ctx.createGain(); inner.gain.value = 0.4;
      src.connect(hp); hp.connect(lp); lp.connect(inner); inner.connect(gain); src.start(); sources.push(src);
    } else if (id === 'birds' || id === 'crickets') {
      // Event beds: the scheduler spawns short sources into this gain.
    }
    return { gain, sources };
  }

  /** Fade a bed out, then stop its sources. Cutting them would click. */
  private destroy(id: AmbienceBedId) {
    const bed = this.beds.get(id);
    if (!bed) return;
    this.beds.delete(id);
    delete this.nextAt[id];              // a rebuilt bed starts a fresh phrase
    const ctx = this.ctx;
    const release = () => {
      for (const s of bed.sources) { try { s.stop(); } catch { /* already stopped */ } }
      bed.gain.disconnect();
    };
    if (!ctx) { release(); return; }
    bed.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
    window.setTimeout(release, 600);
  }

  /** Look-ahead scheduler for the event beds (birds, rain ticks, crickets). */
  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const horizon = now + 0.6;
    /**
     * Never catch up. If a bed was silent for a while, or the tab was
     * throttled so this timer did not run, the planned time can be far in the
     * past - and everything that "should" have happened would fire at once.
     * Resuming from now is both quieter and correct.
     */
    const resume = (id: string, lead: number) => {
      const at = this.nextAt[id];
      if (at === undefined || at < now) this.nextAt[id] = now + lead;
    };
    if (this.beds.has('birds')) {
      resume('birds', hash01(this.seed, this.counters.birds ?? 0, 1) * 2);
      for (let i = this.counters.birds ?? 0; this.nextAt.birds < horizon && i < 100000; i++) {
        const p = birdPhrase(this.seed, i);
        this.playPhrase(this.nextAt.birds, p);
        this.nextAt.birds += p.gap;
        this.counters.birds = i + 1;
      }
    }
    if (this.beds.has('rain')) {
      resume('rain', 0);
      for (let i = this.counters.rain ?? 0; this.nextAt.rain < horizon && i < 1000000; i++) {
        this.playDrop(this.nextAt.rain, dropFreq(this.seed, i));
        this.nextAt.rain += dropGap(this.seed, i);
        this.counters.rain = i + 1;
      }
    }
    if (this.beds.has('crickets')) {
      resume('crickets', 0.4);
      for (let i = this.counters.crickets ?? 0; this.nextAt.crickets < horizon && i < 100000; i++) {
        const p = cricketPhrase(this.seed, i);
        this.playChirrup(this.nextAt.crickets, p.dur);
        this.nextAt.crickets += p.gap;
        this.counters.crickets = i + 1;
      }
    }
  }

  private playPhrase(at: number, p: BirdPhrase) {
    const ctx = this.ctx!;
    const bed = this.beds.get('birds');
    if (!bed) return;
    const pan = Math.random() * 1.2 - 0.6;
    for (const n of p.notes) {
      const t = at + n.dt;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f0, t);
      osc.frequency.linearRampToValueAtTime(n.f1, t + n.dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.32 * n.gain, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
      let out: AudioNode = g;
      if (typeof ctx.createStereoPanner === 'function') {
        const sp = ctx.createStereoPanner(); sp.pan.value = pan;
        g.connect(sp); out = sp;
      }
      osc.connect(g); out.connect(bed.gain);
      osc.start(t); osc.stop(t + n.dur + 0.05);
    }
  }

  private playDrop(at: number, freq: number) {
    const ctx = this.ctx!;
    const bed = this.beds.get('rain');
    if (!bed) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise('white');
    src.playbackRate.value = 0.9 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.16, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    src.connect(bp); bp.connect(g); g.connect(bed.gain);
    src.start(at, Math.random() * 1.5, 0.08);
  }

  private playChirrup(at: number, dur: number) {
    const ctx = this.ctx!;
    const bed = this.beds.get('crickets');
    if (!bed) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = 4200 + Math.random() * 300;
    const pulse = ctx.createOscillator();
    pulse.type = 'square'; pulse.frequency.value = 26;
    const pulseAmt = ctx.createGain(); pulseAmt.gain.value = 0.5;
    const car = ctx.createGain(); car.gain.value = 0.5;
    pulse.connect(pulseAmt); pulseAmt.connect(car.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.1, at + 0.02);
    g.gain.setValueAtTime(0.1, at + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let out: AudioNode = g;
    if (typeof ctx.createStereoPanner === 'function') {
      const sp = ctx.createStereoPanner(); sp.pan.value = Math.random() * 1.4 - 0.7;
      g.connect(sp); out = sp;
    }
    osc.connect(car); car.connect(g); out.connect(bed.gain);
    osc.start(at); osc.stop(at + dur + 0.05);
    pulse.start(at); pulse.stop(at + dur + 0.05);
  }
}
