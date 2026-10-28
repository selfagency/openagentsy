import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { AccountabilityView } from '../readers.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { accountabilityTree } from './accountability.render.js';

/**
 * The accountability block.
 *
 * The counts come from the hooks, the memory package and the ledger. The
 * three the plan names and the project does not keep are not here, because
 * nothing counts them.
 */

const VIEW: AccountabilityView = {
  lessons: 3,
  waivers: 2,
  memory: 1,
  outcomes: { tasksCompleted: 2, tasksScrapped: 0, commits: 5, prsMerged: 1 },
};

const EMPTY: AccountabilityView = {
  lessons: 0,
  waivers: 0,
  memory: 0,
  outcomes: { tasksCompleted: 0, tasksScrapped: 0, commits: 0, prsMerged: 0 },
};

async function frame(view: AccountabilityView = VIEW): Promise<string> {
  const host = fakeHost();
  const collapse = collapseStore(host.context);
  return renderFrame(() => accountabilityTree(host.context, view, collapse));
}

describe('the accountability block', () => {
  it('shows what waits for a decision', async () => {
    const text = await frame();

    expect(text).toContain('Accountability');
    expect(text).toContain('3 lessons');
    expect(text).toContain('1 memory');
    expect(text).toContain('2 waivers');
  });

  it('shows what the run produced', async () => {
    const text = await frame();

    expect(text).toContain('2 tasks completed');
    expect(text).toContain('5 commits');
    expect(text).toContain('1 merged');
  });

  it('says so when nothing waits for a decision', async () => {
    const text = await frame(EMPTY);

    expect(text).toContain('nothing waiting for a decision');
  });
});
