/** Persistent side-panel bodies, selected from the compact header dropdown. */
import { el, on } from './dom';

export interface RailSection {
  id: string;
  title: string;
  titleFn?: () => string;
  icon?: string;
  badge?: () => string | number | null;
  hidden?: () => boolean;
  onToggle?: (open: boolean) => void;
}

export class Rail {
  private sections: RailSection[] = [];
  private bodies = new Map<string, HTMLElement>();
  private openId: string | null = null;
  private offSelect: (() => void) | null = null;

  constructor(private root: HTMLElement, private picker: HTMLSelectElement) {
    this.root.classList.add('rail');
  }

  add(section: RailSection): HTMLElement {
    this.sections.push(section);
    const body = el<HTMLDivElement>('<div class="rail-body"></div>');
    body.dataset.body = section.id;
    this.bodies.set(section.id, body);
    return body;
  }

  build() {
    this.root.innerHTML = '';
    this.picker.innerHTML = '';
    for (const section of this.sections) {
      const option = document.createElement('option');
      option.value = section.id;
      option.textContent = section.title;
      this.picker.appendChild(option);
      const wrap = el<HTMLDivElement>('<section class="rail-section"></section>');
      wrap.dataset.section = section.id;
      wrap.appendChild(this.bodies.get(section.id)!);
      this.root.appendChild(wrap);
    }
    this.offSelect = on(this.picker, 'change', () => this.setOpen(this.picker.value));
    this.sync();
  }

  isOpen(id: string) { return this.openId === id; }
  get open() { return this.openId; }

  setOpen(id: string | null) {
    if (id && !this.sections.some((s) => s.id === id && !s.hidden?.())) return;
    if (this.openId === id) { this.sync(); return; }
    const prev = this.openId;
    this.openId = id;
    if (prev) this.sections.find((s) => s.id === prev)?.onToggle?.(false);
    if (id) this.sections.find((s) => s.id === id)?.onToggle?.(true);
    this.sync();
  }

  sync() {
    const current = this.sections.find((s) => s.id === this.openId);
    if (current?.hidden?.()) {
      current.onToggle?.(false);
      this.openId = null;
    }
    for (const section of this.sections) {
      const wrap = this.root.querySelector<HTMLElement>(`[data-section="${section.id}"]`);
      const option = Array.from(this.picker.options).find((o) => o.value === section.id);
      const hidden = section.hidden?.() ?? false;
      if (option) { option.hidden = hidden; option.disabled = hidden; option.textContent = section.title; }
      if (wrap) {
        wrap.classList.toggle('open', this.openId === section.id && !hidden);
        wrap.style.display = this.openId === section.id && !hidden ? 'flex' : 'none';
      }
    }
    this.picker.value = this.openId ?? '';
  }

  refresh() { this.sync(); }
  collapseAll() { this.setOpen(null); }
  get sectionIds() { return this.sections.map((s) => s.id); }
  focusSection(id: string) { this.setOpen(id); }
  dispose() { this.offSelect?.(); }
}
