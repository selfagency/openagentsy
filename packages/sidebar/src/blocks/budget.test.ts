import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { BudgetView } from '../readers.js';
import { BUDGET, EMPTY_BUDGET } from '../testing/fixtures.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { budgetTree } from './budget.render.js';

/**
 * The budget block.
 *
 * The numbers are the ledger's own export and the board's own check, so the
 * block and the `oa ledger` command answer the same question the same way.
 */

async function frame(view: BudgetView = BUDGET): Promise<string> {
  const host = fakeHost();
  const collapse = collapseStore(host.context);
  return renderFrame(() => budgetTree(host.context, view, collapse));
}

describe('the budget block', () => {
  it('shows the tokens and the price', async () => {
    const text = await frame();

    expect(text).toContain('Budget');
    expect(text).toContain('12,345 tokens');
    expect(text).toContain('$0.4200');
  });

  it('shows the tokens of each resolved role', async () => {
    const text = await frame();

    expect(text).toContain('build · 8,000 tokens');
    expect(text).toContain('lead · 4,345 tokens');
  });

  it('shows the waste and the tokens one completed task cost', async () => {
    const text = await frame();

    expect(text).toContain('waste · 120 tokens (1.0%)');
    expect(text).toContain('per task · 4,000 tokens');
  });

  it('shows the offloaded work', async () => {
    const text = await frame();

    expect(text).toContain('offload · 3 messages · 2,000 tokens');
  });

  it('shows the cap of a bean against what the bean has spent', async () => {
    const text = await frame();

    expect(text).toContain('proj-42 · 40,000 of 153,000 tokens');
  });

  it('says the price is unknown when no message carried one', async () => {
    const text = await frame(EMPTY_BUDGET);

    expect(text).toContain('unpriced');
    expect(text).toContain('per task · no completed task');
  });
});
