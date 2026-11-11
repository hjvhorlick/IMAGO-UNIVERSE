/**
 * RAIL / Sound - an import slot, not a library.
 *
 * The application ships no music. This section is empty until the user brings
 * a file in, and the scene stays silent unless they do. Rights to any imported
 * track are the user's responsibility.
 *
 * Synthesised ambience is offered here too, because this is where anyone
 * looking for sound will come. It is a separate engine (audio/ambience.ts):
 * imported tracks and generated beds play side by side and never interfere.
 */
import type { Store } from '../core/store';
import type { PreviewRenderer } from '../render/previewRenderer';
import { AUDIO_ACCEPT, importAudio, removeAudio } from '../audio/audioStore';
import { BEDS } from '../audio/ambience';
import { AudioPlayer } from '../audio/audioPlayer';
import { escapeHtml, icon, on, qs } from './dom';

export class SoundPanel {
  active = false;
  private player: AudioPlayer;

  constructor(
    private root: HTMLElement,
    private store: Store,
    preview: PreviewRenderer,
    private onAmbience?: () => void,
  ) {
    this.player = new AudioPlayer(store, preview);
    store.on('scene', () => { if (this.active) this.render(); });
  }

  render() {
    const audio = this.store.scene.audio;
    if (!audio) {
      this.root.innerHTML = `<div class="rail-pad">
        <div class="sound-empty">
          ${icon('loop', 22)}
          <strong>No sound</strong>
          <p>Imago ships no music. Import your own track and it travels inside the
          .sceneproject file, so the project stays portable.</p>
          <button class="btn primary" data-import>${icon('upload', 13)} Import sound</button>
          <p class="field-hint">mp3, wav, ogg, m4a, aac or flac. You need the rights to
          anything you import. You can add, replace or remove sound at any time.</p>
        </div>
        ${this.ambienceBlock()}
      </div>`;
      on(qs('[data-import]', this.root), 'click', () => this.pick());
      this.wireAmbience();
      return;
    }

    this.root.innerHTML = `<div class="rail-pad">
      <div class="sound-card">
        <span class="sound-icon">${icon('loop', 15)}</span>
        <div class="sound-meta">
          <div class="sound-name" title="${escapeHtml(audio.name)}">${escapeHtml(audio.name)}</div>
          <div class="sound-sub">${audio.duration ? `${audio.duration.toFixed(1)}s` : 'length unknown'} · ${(audio.bytes / 1e6).toFixed(1)} MB</div>
        </div>
        <button class="btn icon small" data-replace title="Replace">${icon('upload', 12)}</button>
        <button class="btn icon small" data-remove title="Remove sound">${icon('trash', 12)}</button>
      </div>
      <div class="field">
        <div class="field-label">Volume <span class="field-val">${Math.round(audio.volume * 100)}%</span></div>
        <input type="range" min="0" max="100" value="${Math.round(audio.volume * 100)}" data-volume>
      </div>
      <label class="check"><input type="checkbox" data-loop ${audio.loop ? 'checked' : ''}> Repeat for the whole video</label>
      <div class="field">
        <div class="field-label">Crossfade at the loop join <span class="field-val">${audio.crossfade.toFixed(1)}s</span></div>
        <input type="range" min="0" max="60" value="${Math.round(audio.crossfade * 10)}" data-fade>
        <div class="field-hint">Music has an intro and an outro, so a plain repeat has an
        audible join. A crossfade softens it - it does not make the track seamless.</div>
      </div>
      ${this.player.blocked ? `<div class="note warn">Your browser blocked audio until you interact with the page. Press play again.</div>` : ''}
      <div class="note">Sound plays in the preview and is saved inside the project file.
      Exported video is still silent.</div>
      ${this.ambienceBlock()}
    </div>`;

    const vol = qs<HTMLInputElement>('[data-volume]', this.root);
    on(vol, 'input', () => {
      this.store.mutate((s) => { if (s.audio) s.audio.volume = Number(vol!.value) / 100; }, 'Sound volume');
    });
    const fade = qs<HTMLInputElement>('[data-fade]', this.root);
    on(fade, 'input', () => {
      this.store.mutate((s) => { if (s.audio) s.audio.crossfade = Number(fade!.value) / 10; }, 'Sound crossfade');
    });
    on(qs<HTMLInputElement>('[data-loop]', this.root), 'change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      this.store.mutate((s) => { if (s.audio) s.audio.loop = checked; }, 'Sound loop');
    });
    on(qs('[data-replace]', this.root), 'click', () => this.pick());
    on(qs('[data-remove]', this.root), 'click', () => {
      const id = this.store.scene.audio?.id;
      this.store.mutate((s) => { s.audio = null; }, 'Remove sound');
      if (id) void removeAudio(id);
      this.store.status('Sound removed. The scene is silent again.', 'info');
    });
    this.wireAmbience();
  }

  /**
   * A live summary of the synthesised mix, plus the way in. Rendered only when
   * the app supplied a handler, so the button is never decorative.
   */
  private ambienceBlock(): string {
    if (!this.onAmbience) return '';
    const amb = this.store.scene.ambience;
    const playing = amb ? BEDS.filter((b) => (amb.beds[b.id] ?? 0) > 0.004) : [];
    const med = this.store.scene.meditation;
    const parts: string[] = [];
    parts.push(playing.length
      ? `${playing.map((b) => b.label.toLowerCase()).join(', ')} at ${Math.round(amb!.master * 100)}%`
      : 'no beds playing yet');
    if (med?.guide) parts.push('breathing guide on');
    if (med && med.sessionMin > 0) parts.push(`${med.sessionMin}-minute session`);
    return `<div class="note">
      <strong>Synthesised ambience</strong>
      <p>Water, wind, rain, birdsong and crickets, generated live in the browser -
      no audio files, and it starts with present mode (F9).</p>
      <div class="field-hint">${escapeHtml(parts.join(' · '))}</div>
      <button class="btn small" data-ambience style="margin-top:8px">${icon('sparkles', 12)}
      Ambience &amp; breathing…</button>
    </div>`;
  }

  private wireAmbience() {
    const btn = qs<HTMLElement>('[data-ambience]', this.root);
    if (btn && this.onAmbience) on(btn, 'click', () => this.onAmbience!());
  }

  private pick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = AUDIO_ACCEPT;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const audio = await importAudio(file);
        this.store.mutate((s) => { s.audio = audio; }, 'Import sound');
        this.render();
        this.store.status(`Imported "${audio.name}". It will be embedded in the project file.`, 'success');
      } catch (err) {
        this.store.status((err as Error).message, 'error');
      }
    };
    input.click();
  }

  restart() { this.player.reset(); }
  dispose() { this.player.dispose(); }
}
