/**
 * Top-bar dropdown menus.
 *
 * The canvas is the product, so chrome that can live behind a click does.
 * Every command that used to be a permanent toolbar button lives in one of
 * these instead, which buys back two full rows of vertical space.
 *
 * Items are produced by a callback rather than stored, so checked/disabled
 * state is always current when the menu opens.
 */
import { el, escapeHtml, icon, on, qsa } from './dom';

export interface MenuItem {
  /** Omit and set `separator` for a divider. */
  label?: string;
  shortcut?: string;
  icon?: string;
  action?: () => void;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** Rendered as a non-interactive caption. */
  heading?: boolean;
}

export interface MenuDef {
  id: string;
  label: string;
  items: () => MenuItem[];
}

export class MenuBar {
  private openId: string | null = null;
  private offOutside: (() => void) | null = null;
  private offKey: (() => void) | null = null;

  constructor(private root: HTMLElement, private menus: MenuDef[]) {
    this.render();
  }

  render() {
    this.root.innerHTML = this.menus.map((m) =>
      `<button class="menu-btn" data-menu="${m.id}" aria-haspopup="true" aria-expanded="false">${escapeHtml(m.label)}</button>`,
    ).join('');
    qsa<HTMLElement>('[data-menu]', this.root).forEach((btn) => {
      on(btn, 'click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.menu!;
        if (this.openId === id) this.close();
        else this.open(id);
      });
      // Once one menu is open, hovering the others switches - standard desktop
      // behaviour, and much faster than click-close-click.
      on(btn, 'pointerenter', () => {
        if (this.openId && this.openId !== btn.dataset.menu) this.open(btn.dataset.menu!);
      });
    });
  }

  open(id: string) {
    const def = this.menus.find((m) => m.id === id);
    const btn = this.root.querySelector<HTMLElement>(`[data-menu="${id}"]`);
    if (!def || !btn) return;
    this.closeDropdown();
    this.openId = id;

    qsa<HTMLElement>('[data-menu]', this.root).forEach((b) => {
      const active = b.dataset.menu === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-expanded', String(active));
    });

    const pop = el<HTMLDivElement>('<div class="menu-pop" role="menu"></div>');
    const items = def.items();
    items.forEach((item, i) => {
      if (item.separator) { pop.appendChild(el('<div class="menu-sep"></div>')); return; }
      if (item.heading) {
        pop.appendChild(el(`<div class="menu-heading">${escapeHtml(item.label ?? '')}</div>`));
        return;
      }
      const row = el<HTMLButtonElement>(`<button class="menu-item" role="menuitem" data-i="${i}"
        ${item.disabled ? 'disabled' : ''}>
        <span class="menu-icon">${item.checked ? icon('check', 13) : item.icon ? icon(item.icon, 13) : ''}</span>
        <span class="menu-label">${escapeHtml(item.label ?? '')}</span>
        ${item.shortcut ? `<span class="menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
      </button>`);
      on(row, 'click', () => { this.close(); item.action?.(); });
      pop.appendChild(row);
    });

    // Position under the button, clamped so a long menu never leaves the window.
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    const width = pop.offsetWidth;
    const left = Math.min(r.left, window.innerWidth - width - 8);
    pop.style.left = `${Math.max(8, Math.round(left))}px`;
    const height = pop.offsetHeight;
    if (r.bottom + 4 + height > window.innerHeight - 8) {
      pop.style.top = `${Math.max(8, window.innerHeight - height - 8)}px`;
    }
    this.pop = pop;

    this.offOutside = on(document, 'pointerdown', (e) => {
      if (!pop.contains(e.target as Node) && !this.root.contains(e.target as Node)) this.close();
    });
    this.offKey = on(window, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.close();
    });
  }

  private pop: HTMLElement | null = null;

  private closeDropdown() {
    this.pop?.remove();
    this.pop = null;
    this.offOutside?.();
    this.offKey?.();
    this.offOutside = null;
    this.offKey = null;
  }

  close() {
    this.closeDropdown();
    this.openId = null;
    qsa<HTMLElement>('[data-menu]', this.root).forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-expanded', 'false');
    });
  }

  dispose() { this.close(); }
}

/** A right-click menu at an arbitrary point. Reuses the same item model. */
export function contextMenu(x: number, y: number, items: MenuItem[]) {
  const pop = el<HTMLDivElement>('<div class="menu-pop" role="menu"></div>');
  let offDoc: (() => void) | null = null;
  let offKey: (() => void) | null = null;
  const close = () => {
    pop.remove();
    offDoc?.(); offKey?.();
    offDoc = null; offKey = null;
  };
  items.forEach((item, i) => {
    if (item.separator) { pop.appendChild(el('<div class="menu-sep"></div>')); return; }
    if (item.heading) {
      pop.appendChild(el(`<div class="menu-heading">${escapeHtml(item.label ?? '')}</div>`));
      return;
    }
    const row = el<HTMLButtonElement>(`<button class="menu-item" role="menuitem" data-i="${i}"
      ${item.disabled ? 'disabled' : ''}>
      <span class="menu-icon">${item.checked ? icon('check', 13) : item.icon ? icon(item.icon, 13) : ''}</span>
      <span class="menu-label">${escapeHtml(item.label ?? '')}</span>
      ${item.shortcut ? `<span class="menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
    </button>`);
    on(row, 'click', () => { close(); item.action?.(); });
    pop.appendChild(row);
  });
  document.body.appendChild(pop);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  // Defer so the opening click does not immediately close it.
  setTimeout(() => {
    offDoc = on(document, 'pointerdown', (e) => { if (!pop.contains(e.target as Node)) close(); });
    offKey = on(window, 'keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close(); });
  }, 0);
  return close;
}
