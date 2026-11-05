/**
 * Undo / redo / history navigation. A designer changes their mind many times,
 * so moving backwards AND forwards through the history must always work and
 * must always show the scene that was actually there at that step.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/store';
import { createScene } from '../src/scene/sceneModel';

function store() {
  return new Store(createScene('enchanted', 'History test'));
}

/** Each step adds one object named after its step number. */
function step(s: Store, n: number) {
  s.mutate((sc) => {
    sc.nodes.push({ id: `n${n}`, name: `step ${n}` } as never);
  }, `Step ${n}`);
}

const names = (s: Store) => s.scene.nodes.map((n) => n.name);

describe('history navigation', () => {
  it('undo and redo move one step at a time', () => {
    const s = store();
    step(s, 1); step(s, 2); step(s, 3);
    expect(names(s)).toEqual(['step 1', 'step 2', 'step 3']);
    s.undo();
    expect(names(s)).toEqual(['step 1', 'step 2']);
    s.redo();
    expect(names(s)).toEqual(['step 1', 'step 2', 'step 3']);
  });

  it('jumping back several steps shows the scene from that step', () => {
    const s = store();
    step(s, 1); step(s, 2); step(s, 3); step(s, 4);
    s.jumpTo(1); // the state before "Step 2"
    expect(names(s)).toEqual(['step 1']);
  });

  it('forward steps survive a jump back and can be walked forward again', () => {
    const s = store();
    step(s, 1); step(s, 2); step(s, 3);
    s.jumpTo(0);
    expect(names(s)).toEqual([]);
    expect(s.future.length).toBe(3);
    s.goForward(2);
    expect(names(s)).toEqual(['step 1', 'step 2']);
    s.goForward(1);
    expect(names(s)).toEqual(['step 1', 'step 2', 'step 3']);
  });

  it('every forward entry holds the scene that was really there at that step', () => {
    const s = store();
    step(s, 1); step(s, 2); step(s, 3);
    s.jumpTo(0);
    // future is ordered farthest-first; the last entry is the nearest step.
    const nearest = s.future[s.future.length - 1].scene.nodes.map((n) => n.name);
    const farthest = s.future[0].scene.nodes.map((n) => n.name);
    expect(nearest).toEqual(['step 1']);
    expect(farthest).toEqual(['step 1', 'step 2', 'step 3']);
  });

  it('a new change after going back discards the forward steps', () => {
    const s = store();
    step(s, 1); step(s, 2);
    s.jumpTo(0);
    step(s, 9);
    expect(s.future.length).toBe(0);
    expect(names(s)).toEqual(['step 9']);
  });
});
