import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { BudgetView } from '../readers.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { budgetTree } from './budget.render.js';

/**
 * The budget block.
 *
 * The numbers are the ledger's own export and the board's own check, so the
 * block and the `oa ledger` command answer the same question the same way.
 */

const VIEW: BudgetView = {
  totals: {
    messages: 12,
    tokens: 12_345,
    input: 4_000,
    output: 8_000,
    reasoning: 0,
    cacheRead: 200,
    cacheWrite: 145,
    usd: 0.42,
    unpricedMessages: 0,
  },
  byRole: [
    { role: 'build', messages: 8, tokens: 8_000, usd: 0.3, unpriced: 0 },
    { role: 'lead', messages: 4, tokens: 4_345, usd: 0.12, unpriced: 0 },
  ],
  waste: { tokens: 120, percentage: 1 },
  tokensPerTask: 4_000,
  offload: { messages: 3, tokens: 2_000, usd: 0.01 },
  caps: [
    { bean: 'proj-42', tokenLimit: 180_000, stopAt: 153_000, tokensUsed: 40_000, stop: false },
  ],
};

const EMPTY: BudgetView = {
  totals: {
    messages: 0,
    tokens: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usd: null,
    unpricedMessages: 0,
  },
  byRole: [],
  waste: { tokens: 0, percentage: 0 },
  tokensPerTask: null,
  offload: { messages: 0, tokens: 0, usd: null },
  caps: [],
};

async function frame(view: BudgetView = VIEW): Promise<string> {
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
    const text = await frame(EMPTY);

    expect(text).toContain('unpriced');
    expect(text).toContain('per task · no completed task');
  });
});
