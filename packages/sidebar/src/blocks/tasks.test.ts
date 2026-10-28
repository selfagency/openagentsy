import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { TasksView } from '../readers.js';
import { EMPTY_TASKS, TASKS } from '../testing/fixtures.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { tasksTree } from './tasks.render.js';

/**
 * The tasks block.
 *
 * The view is the task store's own answer: what is in progress, what is
 * ready, and how many tasks are held up. The store owns the file format and
 * the meaning of a blocked task.
 */

async function frame(view: TasksView = TASKS): Promise<string> {
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
    const text = await frame(EMPTY_TASKS);

    expect(text).toContain('no open task');
  });
});
