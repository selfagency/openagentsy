import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { TasksView } from '../readers.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { tasksTree } from './tasks.render.js';

/**
 * The tasks block.
 *
 * The view is the task store's own answer: what is in progress, what is
 * ready, and how many tasks are held up. The store owns the file format and
 * the meaning of a blocked task.
 */

const VIEW: TasksView = {
  inProgress: [{ id: 'oa-4f2k', title: 'fix the ranges' }],
  ready: [
    { id: 'oa-9x1p', title: 'write the reader' },
    { id: 'oa-2b7q', title: 'add the check' },
  ],
  blocked: 2,
};

const EMPTY: TasksView = { inProgress: [], ready: [], blocked: 0 };

async function frame(view: TasksView = VIEW): Promise<string> {
  const host = fakeHost();
  const collapse = collapseStore(host.context);
  return renderFrame(() => tasksTree(host.context, view, collapse));
}

describe('the tasks block', () => {
  it('shows what is in progress', async () => {
    const text = await frame();

    expect(text).toContain('Tasks');
    expect(text).toContain('in progress · oa-4f2k fix the ranges');
  });

  it('shows the tasks that can be picked up', async () => {
    const text = await frame();

    expect(text).toContain('ready · oa-9x1p write the reader');
    expect(text).toContain('ready · oa-2b7q add the check');
  });

  it('counts the tasks that are held up', async () => {
    const text = await frame();

    expect(text).toContain('1 in progress');
    expect(text).toContain('2 ready');
    expect(text).toContain('2 blocked');
  });

  it('says so when no task is open', async () => {
    const text = await frame(EMPTY);

    expect(text).toContain('no open task');
  });
});
