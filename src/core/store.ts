/**
 * Application state container.
 *
 * Owns the scene graph, the current selection and an undo/redo history of
 * immutable scene snapshots. UI modules subscribe to events rather than to each
 * other, which keeps the interface, the compositor and the animation engine
 * decoupled.
 */
import type { Scene, SceneNode } from './types';
import { deepClone, uid } from './util';

export type AppEvent =
  | 'scene'        // scene graph changed
  | 'selection'    // selected nodes changed
  | 'library'      // asset library / style changed
  | 'playback'     // play / pause / seek
  | 'history'      // undo stack changed
  | 'status';      // transient user-facing message

export interface HistoryEntry { label: string; scene: Scene; at: number }

export interface StatusMessage {
  text: string;
  tone: 'info' | 'success' | 'warn' | 'error';
  detail?: string;
}

const MAX_HISTORY = 80;

export class Store {
  scene: Scene;
  selection: string[] = [];
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  dirty = false;
  lastSavedName = '';

  private listeners = new Map<AppEvent, Set<(payload?: unknown) => void>>();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  on(evt: AppEvent, fn: (payload?: unknown) => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }

  emit(evt: AppEvent, payload?: unknown) {
    this.listeners.get(evt)?.forEach((fn) => {
      try { fn(payload); } catch (err) { console.error(`[store] listener for ${evt} failed`, err); }
    });
  }

  status(text: string, tone: StatusMessage['tone'] = 'info', detail?: string) {
    this.emit('status', { text, tone, detail } satisfies StatusMessage);
  }

  /** Capture the current scene onto the undo stack. Call once per user action. */
  pushHistory(label: string) {
    this.past.push({ label, scene: deepClone(this.scene), at: Date.now() });
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future.length = 0;
    this.emit('history');
  }

  /**
   * Mutate the scene. Pass a label to make the change undoable as one step;
   * omit it for continuation frames of an interaction already on the stack.
   */
  mutate(fn: (scene: Scene) => void, label?: string) {
    if (label) this.pushHistory(label);
    fn(this.scene);
    this.scene.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.emit('scene');
  }

  replaceScene(scene: Scene, opts: { resetHistory?: boolean } = {}) {
    this.scene = scene;
    this.selection = [];
    if (opts.resetHistory !== false) { this.past = []; this.future = []; }
    this.dirty = false;
    this.emit('scene');
    this.emit('selection');
    this.emit('history');
  }

  undo(): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    this.future.push({ label: entry.label, scene: deepClone(this.scene), at: Date.now() });
    this.scene = entry.scene;
    this.selection = this.selection.filter((id) => this.scene.nodes.some((n) => n.id === id));
    this.dirty = true;
    this.emit('scene'); this.emit('selection'); this.emit('history');
    return true;
  }

  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    this.past.push({ label: entry.label, scene: deepClone(this.scene), at: Date.now() });
    this.scene = entry.scene;
    this.selection = this.selection.filter((id) => this.scene.nodes.some((n) => n.id === id));
    this.dirty = true;
    this.emit('scene'); this.emit('selection'); this.emit('history');
    return true;
  }

  /**
   * Go to the state that sits before past entry `index` (0 = the very first
   * state). Every step passed on the way stays on the forward stack, so the
   * designer can come back to it. Walks one undo at a time, so each forward
   * entry keeps the exact scene that was there.
   */
  jumpTo(index: number) {
    while (this.past.length > index && this.undo()) { /* step back */ }
  }

  /** Walk forward through steps that were undone. Stops early at the newest step. */
  goForward(count: number) {
    for (let i = 0; i < count; i++) {
      if (!this.redo()) break;
    }
  }

  /* ------------------------------------------------------------ selection */

  get selected(): SceneNode[] {
    return this.scene.nodes.filter((n) => this.selection.includes(n.id));
  }

  get primary(): SceneNode | undefined {
    const sel = this.selected;
    return sel[sel.length - 1];
  }

  node(id: string | undefined): SceneNode | undefined {
    return id ? this.scene.nodes.find((n) => n.id === id) : undefined;
  }

  select(ids: string[] | string | null, additive = false) {
    const list = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
    this.selection = additive ? Array.from(new Set([...this.selection, ...list])) : list;
    this.emit('selection');
  }

  /* -------------------------------------------------------------- helpers */

  nextOrder(layer: string): number {
    const peers = this.scene.nodes.filter((n) => n.layer === layer);
    return peers.length ? Math.max(...peers.map((n) => n.order)) + 1 : 0;
  }

  addNode(node: SceneNode, label = 'Add object') {
    this.mutate((s) => { s.nodes.push(node); }, label);
    this.select(node.id);
  }

  removeSelected() {
    const removable = this.selected.filter((n) => !n.locked);
    if (!removable.length) {
      this.status('Nothing removed - the selection is locked.', 'warn');
      return;
    }
    const ids = new Set(removable.map((n) => n.id));
    this.mutate((s) => { s.nodes = s.nodes.filter((n) => !ids.has(n.id)); }, 'Delete');
    this.select([]);
  }

  duplicateSelected(): SceneNode[] {
    const copies: SceneNode[] = [];
    const sel = this.selected;
    if (!sel.length) return copies;
    this.pushHistory('Duplicate');
    for (const n of sel) {
      const copy = deepClone(n);
      copy.id = uid(n.kind);
      copy.name = `${n.name} copy`;
      copy.x += 40; copy.y += 28;
      copy.order = this.nextOrder(n.layer);
      copy.locked = false;
      this.scene.nodes.push(copy);
      copies.push(copy);
    }
    this.scene.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.emit('scene');
    this.select(copies.map((c) => c.id));
    return copies;
  }
}
