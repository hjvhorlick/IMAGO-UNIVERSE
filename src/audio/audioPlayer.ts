/**
 * Preview playback for an imported track.
 *
 * Follows the preview transport: play, pause and restart stay in step with the
 * animation. Two elements are used so a loop can genuinely crossfade instead of
 * cutting - music has an intro and an outro, so a plain repeat has an audible
 * join and we should not pretend otherwise.
 *
 * Everything here is guarded: a browser may refuse autoplay before a gesture,
 * and a test environment may have no media stack at all. Audio failure must
 * never take the visual preview down with it.
 */
import type { Store } from '../core/store';
import type { SceneAudio } from '../core/types';
import type { PreviewRenderer } from '../render/previewRenderer';
import { loadAudioBlob } from './audioStore';

export class AudioPlayer {
  private a: HTMLAudioElement | null = null;
  private b: HTMLAudioElement | null = null;
  private url: string | null = null;
  private loadedId: string | null = null;
  private active: HTMLAudioElement | null = null;
  private fading = false;
  private timer = 0;
  /** Set when the browser blocks playback, so the UI can say so honestly. */
  blocked = false;

  constructor(private store: Store, private preview: PreviewRenderer) {
    store.on('playback', () => this.follow());
    store.on('scene', () => { void this.sync(); });
    void this.sync();
    this.timer = window.setInterval(() => this.tick(), 120);
  }

  get present() { return !!this.store.scene.audio; }

  private make(): HTMLAudioElement | null {
    try {
      const el = document.createElement('audio');
      el.preload = 'auto';
      return el;
    } catch { return null; }
  }

  async sync() {
    const audio = this.store.scene.audio;
    if (!audio) { this.teardownTrack(); return; }
    if (audio.id !== this.loadedId) {
      const blob = await loadAudioBlob(audio.id);
      if (!blob) {
        this.store.status(`Sound file "${audio.name}" is not in this browser. Re-import it, or open the .sceneproject that contains it.`, 'warn');
        return;
      }
      this.teardownTrack();
      this.url = URL.createObjectURL(blob);
      this.a = this.make();
      this.b = this.make();
      if (!this.a || !this.b) return;
      this.a.src = this.url;
      this.b.src = this.url;
      this.active = this.a;
      this.loadedId = audio.id;
      try { this.a.currentTime = audio.offset; } catch { /* not seekable yet */ }
    }
    this.apply(audio);
    this.follow();
  }

  private apply(audio: SceneAudio) {
    for (const el of [this.a, this.b]) {
      if (!el) continue;
      // A crossfade needs manual control of the join, so native looping is off
      // whenever one is configured.
      el.loop = audio.loop && audio.crossfade <= 0;
      el.volume = Math.max(0, Math.min(1, audio.volume));
    }
  }

  private teardownTrack() {
    for (const el of [this.a, this.b]) { try { el?.pause(); } catch { /* ignore */ } }
    if (this.url) URL.revokeObjectURL(this.url);
    this.a = null; this.b = null; this.active = null;
    this.url = null; this.loadedId = null; this.fading = false;
  }

  private follow() {
    const audio = this.store.scene.audio;
    if (!audio || !this.active) return;
    if (this.preview.playing) {
      const p = this.active.play?.();
      // Autoplay policy: a rejected promise means we need a user gesture.
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).then(() => { this.blocked = false; })
          .catch(() => { this.blocked = true; });
      }
    } else {
      try { this.active.pause(); } catch { /* ignore */ }
    }
  }

  /** Restart the track from its offset. Called by the preview's restart. */
  reset() {
    const audio = this.store.scene.audio;
    if (!audio || !this.a) return;
    this.fading = false;
    this.active = this.a;
    for (const el of [this.a, this.b]) {
      try { el!.pause(); el!.currentTime = audio.offset; } catch { /* ignore */ }
    }
    this.apply(audio);
    this.follow();
  }

  /** Drive the crossfade at the loop join. */
  private tick() {
    const audio = this.store.scene.audio;
    const cur = this.active;
    if (!audio || !cur || !this.a || !this.b || !this.preview.playing) return;
    const dur = Number.isFinite(cur.duration) && cur.duration > 0 ? cur.duration : audio.duration;
    if (!dur || cur.paused) return;

    if (!audio.loop) {
      if (cur.currentTime >= dur - 0.05) { try { cur.pause(); } catch { /* ignore */ } }
      return;
    }
    const fade = Math.min(audio.crossfade, dur / 3);
    if (fade <= 0) return; // native looping handles it

    const next = cur === this.a ? this.b : this.a;
    const remaining = dur - cur.currentTime;
    if (!this.fading && remaining <= fade) {
      this.fading = true;
      try {
        next.currentTime = audio.offset;
        next.volume = 0;
        void next.play?.();
      } catch { /* ignore */ }
    }
    if (this.fading) {
      const u = Math.max(0, Math.min(1, 1 - remaining / fade));
      try {
        cur.volume = audio.volume * (1 - u);
        next.volume = audio.volume * u;
      } catch { /* ignore */ }
      if (remaining <= 0.06) {
        try { cur.pause(); cur.currentTime = audio.offset; cur.volume = audio.volume; } catch { /* ignore */ }
        this.active = next;
        this.fading = false;
      }
    }
  }

  dispose() {
    window.clearInterval(this.timer);
    this.teardownTrack();
  }
}
