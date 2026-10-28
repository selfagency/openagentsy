import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { MemoryView } from '../readers.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { memoryTree } from './memory.render.js';

/**
 * The memory inbox block.
 *
 * The candidates are the board's pending `bean: memory` records, and the
 * memory package owns what a pending record is and what a candidate carries.
 */

const VIEW: MemoryView = {
  candidates: [
    {
      id: 12,
      text: 'the board reader lives in the core package',
      category: 'build',
      source: '12 · core',
    },
    { id: 13, text: 'the ledger is the measurement', category: 'run', source: '13 · ledger' },
  ],
};

const EMPTY: MemoryView = { candidates: [] };

async function frame(view: MemoryView = VIEW): Promise<string> {
  const host = fakeHost();
  const collapse = collapseStore(host.context);
  return renderFrame(() => memoryTree(host.context, view, collapse));
}

describe('the memory inbox block', () => {
  it('lists the candidates that wait for a decision', async () => {
    const text = await frame();

    expect(text).toContain('Memory inbox');
    expect(text).toContain('2 candidates');
    expect(text).toContain('12 · build · the board reader lives in the core package');
  });

  it('says so when no candidate waits', async () => {
    const text = await frame(EMPTY);

    expect(text).toContain('0 candidates');
    expect(text).toContain('no candidate waiting');
  });
});
