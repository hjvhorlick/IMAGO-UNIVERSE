/**
 * Breathing guide overlay for present mode.
 *
 * A quiet ring that expands on the inhale, rests on the hold and settles on
 * the exhale, with the phase name beneath it. The mathematics lives in
 * `breathState` (audio/ambience.ts) so it is unit-tested; this class only
 * paints it at frame rate.
 */
import { BREATH_PATTERNS, breathState } from '../audio/ambience';
import type { BreathPattern } from '../core/types';

export class BreathGuide {
  readonly el: HTMLElement;
  private ring: HTMLElement;
  private label: HTMLElement;
  private raf = 0;
  private t0 = 0;
  private current: BreathPattern = 'calm';
  private host: HTMLElement | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'breath-guide';
    this.el.setAttribute('aria-hidden', 'true');
    this.ring = document.createElement('div');
    this.ring.className = 'breath-ring';
    this.label = document.createElement('div');
    this.label.className = 'breath-label';
    this.el.append(this.ring, this.label);
  }

  attach(host: HTMLElement) {
    if (this.host === host) return;
    this.host = host;
    host.appendChild(this.el);
  }

  get running(): boolean { return this.raf !== 0; }
  get pattern(): BreathPattern { return this.current; }

  start(pattern: BreathPattern) {
    this.current = pattern in BREATH_PATTERNS ? pattern : 'calm';
    this.t0 = performance.now();
    this.el.classList.add('on');
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.el.classList.remove('on');
  }

  private tick = () => {
    const t = (performance.now() - this.t0) / 1000;
    const s = breathState(this.current, t);
    this.ring.style.transform = `scale(${s.scale.toFixed(3)})`;
    if (this.label.textContent !== s.label) {
      this.label.textContent = s.label;
      this.label.classList.remove('swap');
      void this.label.offsetWidth;
      this.label.classList.add('swap');
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
