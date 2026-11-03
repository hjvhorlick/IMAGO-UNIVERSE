/**
 * The right-hand rail: an exclusive accordion.
 *
 * Only the section you are actually working in is open. Everything else
 * collapses to a 30px header, so the asset grid gets the full height of the
 * rail instead of sharing it with three panels you are not looking at.
 *
 * Section bodies are persistent DOM nodes. Panels keep their own subtree and
 * their store subscriptions; the rail only decides which one is visible and
 * tells it whether it is allowed to re-render.
 */
import { el, escapeHtml, icon, on, qsa } from './dom';

export interface RailSection {
  id: string;
  title: string;
  /** Overrides `title` at sync time, for headings that track state. */
  titleFn?: () => string;
  icon?: string;
  /** Small count/state shown on the collapsed header. */
  badge?: () => string | number | null;
  /** Hide the section entirely (e.g. Themes outside layer 4). */
  hidden?: () => boolean;
  /** Called whenever this section opens or closes. */
  onToggle?: (open: boolean) => void;
}

export class Rail {
  private sections: RailSection[] = [];
  private bodies = new Map<string, HTMLElement>();
  private openId: string | null = null;
  private headers = new Map<string, HTMLElement>();

  constructor(private root: HTMLElement) {
    this.root.classList.add('rail');
  }

  /** Register a section and get back the element its panel should render into. */
  add(section: RailSection): HTMLElement {
    this.sections.push(section);
    const body = el<HTMLDivElement>('<div class="rail-body"></div>');
    body.dataset.body = section.id;
    this.bodies.set(section.id, body);
    return body;
  }

  /** Build the header/body skeleton. Call once after all sections are added. */
  build() {
    this.root.innerHTML = '';
    this.headers.clear();
    for (const s of this.sections) {
      const wrap = el<HTMLDivElement>(`<section class="rail-section" data-section="${s.id}">
        <button class="rail-head" data-head="${s.id}" aria-expanded="false">
          <span class="rail-caret">${icon('right', 11)}</span>
          ${s.icon ? `<span class="rail-head-icon">${icon(s.icon, 12)}</span>` : ''}
          <span class="rail-title">${escapeHtml(s.title)}</span>
          <span class="rail-badge" data-badge="${s.id}"></span>
        </button>
      </section>`);
      const head = wrap.querySelector<HTMLElement>('.rail-head')!;
      this.headers.set(s.id, head);
      on(head, 'click', () => this.toggle(s.id));
      wrap.appendChild(this.bodies.get(s.id)!);
      this.root.appendChild(wrap);
    }
    this.sync();
  }

  isOpen(id: string) { return this.openId === id; }
  get open() { return this.openId; }

  /** Open one section, closing whichever was open. */
  setOpen(id: string | null) {
    if (this.openId === id) { this.sync(); return; }
    const prev = this.openId;
    this.openId = id;
    if (prev) this.sections.find((s) => s.id === prev)?.onToggle?.(false);
    if (id) this.sections.find((s) => s.id === id)?.onToggle?.(true);
    this.sync();
    if (id) {
      // Bring the newly opened header to the top of the rail so its content
      // gets the maximum available height.
      const head = this.headers.get(id);
      // Not available in every environment (jsdom has no layout engine).
      if (typeof head?.scrollIntoView === 'function') head.scrollIntoView({ block: 'nearest' });
    }
  }

  toggle(id: string) { this.setOpen(this.openId === id ? null : id); }

  /** Update headers, visibility and badges without touching panel subtrees. */
  sync() {
    for (const s of this.sections) {
      const wrap = this.root.querySelector<HTMLElement>(`[data-section="${s.id}"]`);
      if (!wrap) continue;
      const hidden = s.hidden?.() ?? false;
      wrap.style.display = hidden ? 'none' : '';
      const open = this.openId === s.id && !hidden;
      wrap.classList.toggle('open', open);
      const head = this.headers.get(s.id);
      head?.setAttribute('aria-expanded', String(open));
      const titleEl = head?.querySelector<HTMLElement>('.rail-title');
      if (titleEl) titleEl.textContent = s.titleFn ? s.titleFn() : s.title;
      const badge = wrap.querySelector<HTMLElement>('[data-badge]');
      if (badge) {
        const v = s.badge?.();
        badge.textContent = v == null ? '' : String(v);
      }
    }
    // If the open section became hidden, fall back to nothing open rather than
    // leaving an invisible panel marked active.
    const cur = this.sections.find((s) => s.id === this.openId);
    if (cur?.hidden?.()) {
      const id = this.openId;
      this.openId = null;
      if (id) this.sections.find((s) => s.id === id)?.onToggle?.(false);
    }
  }

  /** Re-render the open section's badge/visibility after a store change. */
  refresh() { this.sync(); }

  collapseAll() { this.setOpen(null); }

  get sectionIds() { return this.sections.map((s) => s.id); }

  /** Used by the collapse-rail button and by tests. */
  focusSection(id: string) {
    if (this.sections.some((s) => s.id === id)) this.setOpen(id);
  }

  dispose() { qsa('[data-head]', this.root).forEach((h) => h.replaceWith(h.cloneNode(true))); }
}
