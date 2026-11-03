/** Tiny DOM helpers + the inline icon set (no icon dependency, no network). */

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export const qs = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T | null;

export const qsa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget | null, type: K | string,
  fn: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions,
) {
  target?.addEventListener(type as string, fn as EventListener, opts);
  return () => target?.removeEventListener(type as string, fn as EventListener, opts);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PATHS: Record<string, string> = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.4 10.4 0 0 1 12 19C5 19 1 12 1 12a19 19 0 0 1 5.1-5.9m3.3-1.6A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  video: '<path d="M23 7l-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  film: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 12h20M2 7.5h5M2 16.5h5M17 7.5h5M17 16.5h5"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  wand: '<path d="M15 4V2M15 10V8M11.5 6h-2M20.5 6h-2M17.8 3.2l1.4-1.4M17.8 8.8l1.4 1.4M12.2 3.2l-1.4-1.4"/><path d="M3 21L14 10"/>',
  layers: '<path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  wind: '<path d="M9.6 4.6A2 2 0 1 1 11 8H2M12.6 19.4A2 2 0 1 0 14 16H2M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  history: '<path d="M3 3v6h6"/><path d="M3.5 13a9 9 0 1 0 2.6-6.4L3 9"/><path d="M12 7v5l4 2"/>',
  flip: '<path d="M12 3v18M8 7L4 12l4 5M16 7l4 5-4 5"/>',
  bring: '<path d="M12 3l8 5-8 5-8-5z"/><path d="M4 15l8 5 8-5"/>',
  send: '<path d="M12 21l8-5-8-5-8 5z"/><path d="M4 9l8-5 8 5"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  cloud: '<path d="M18 10h-1.3A6 6 0 1 0 6 15h12a4 4 0 0 0 0-8z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
};

export function icon(name: keyof typeof PATHS | string, size = 15, strokeWidth = 1.7): string {
  const d = PATHS[name] ?? PATHS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/* ------------------------------------------------------------- controls */

export interface RangeOpts {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; hint?: string; format?: (v: number) => string;
  onInput: (v: number) => void; onCommit?: () => void;
}

/** A labelled slider that reports live input and a final commit for history. */
export function rangeField(o: RangeOpts): HTMLElement {
  const fmt = o.format ?? ((v: number) => `${Math.round(v * 100) / 100}${o.unit ?? ''}`);
  const node = el<HTMLDivElement>(`
    <div class="field">
      <div class="field-label"><span>${escapeHtml(o.label)}</span><span class="field-value">${fmt(o.value)}</span></div>
      <input type="range" min="${o.min}" max="${o.max}" step="${o.step}" value="${o.value}">
      ${o.hint ? `<div class="field-hint">${escapeHtml(o.hint)}</div>` : ''}
    </div>`);
  const input = qs<HTMLInputElement>('input', node)!;
  const out = qs<HTMLElement>('.field-value', node)!;
  let committed = false;
  on(input, 'pointerdown', () => { committed = false; o.onCommit?.(); });
  on(input, 'input', () => {
    const v = parseFloat(input.value);
    out.textContent = fmt(v);
    if (!committed) { committed = true; }
    o.onInput(v);
  });
  on(input, 'keydown', () => { if (!committed) { committed = true; o.onCommit?.(); } });
  return node;
}

export function selectField(label: string, value: string, options: { value: string; label: string }[],
  onChange: (v: string) => void, hint?: string): HTMLElement {
  const node = el<HTMLDivElement>(`
    <div class="field">
      <div class="field-label"><span>${escapeHtml(label)}</span></div>
      <select>${options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>
      ${hint ? `<div class="field-hint">${escapeHtml(hint)}</div>` : ''}
    </div>`);
  on(qs<HTMLSelectElement>('select', node)!, 'change', (e) => onChange((e.target as HTMLSelectElement).value));
  return node;
}

export function colorField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const node = el<HTMLDivElement>(`
    <div class="field">
      <div class="field-label"><span>${escapeHtml(label)}</span></div>
      <input type="color" value="${value}">
    </div>`);
  on(qs<HTMLInputElement>('input', node)!, 'input', (e) => onChange((e.target as HTMLInputElement).value));
  return node;
}

export function toggleField(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const node = el<HTMLDivElement>(`
    <div class="field">
      <label class="toggle-row"><span>${escapeHtml(label)}</span><input type="checkbox"${value ? ' checked' : ''}></label>
      ${hint ? `<div class="field-hint">${escapeHtml(hint)}</div>` : ''}
    </div>`);
  on(qs<HTMLInputElement>('input', node)!, 'change', (e) => onChange((e.target as HTMLInputElement).checked));
  return node;
}

export function numberField(label: string, value: number, onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; suffix?: string } = {}): HTMLElement {
  const node = el<HTMLDivElement>(`
    <div class="field">
      <div class="field-label"><span>${escapeHtml(label)}${opts.suffix ? ` <span class="field-value">${opts.suffix}</span>` : ''}</span></div>
      <input type="number" value="${value}" ${opts.min != null ? `min="${opts.min}"` : ''} ${opts.max != null ? `max="${opts.max}"` : ''} step="${opts.step ?? 1}">
    </div>`);
  on(qs<HTMLInputElement>('input', node)!, 'change', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) onChange(v);
  });
  return node;
}
