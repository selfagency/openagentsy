import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { AccountabilityView } from '../readers.js';
import { ACCOUNTABILITY, EMPTY_ACCOUNTABILITY } from '../testing/fixtures.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { accountabilityTree } from './accountability.render.js';

/**
 * The accountability block.
 *
 * The counts come from the hooks, the memory package and the ledger. The
 * three the plan names and the project does not keep are not here, because
 * nothing counts them.
 */

async function frame(view: AccountabilityView = ACCOUNTABILITY): Promise<string> {
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
    const text = await frame(EMPTY_ACCOUNTABILITY);

    expect(text).toContain('nothing waiting for a decision');
  });
});
