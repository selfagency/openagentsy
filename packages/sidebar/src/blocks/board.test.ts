import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import type { BoardView } from '../readers.js';
import { BOARD, EMPTY_BOARD } from '../testing/fixtures.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { boardTree } from './board.render.js';

/**
 * The board block.
 *
 * The block is rendered from a fixture, in the test renderer that OpenTUI
 * ships, and the frame it draws is read back as text. The numbers are the
 * ones the core package read off the board's own tables.
 */

async function frame(view: BoardView = BOARD): Promise<string> {
  const host = fakeHost();
  const collapse = collapseStore(host.context);
  return renderFrame(() => boardTree(host.context, view, collapse));
}

describe('the board block', () => {
  it('shows how many records and leases the board holds', async () => {
    const text = await frame();

    expect(text).toContain('Board');
    expect(text).toContain('12 records');
    expect(text).toContain('1 lease');
  });

  it('shows who holds a lease and for how long', async () => {
    const text = await frame();

    expect(text).toContain('builder-2 holds packages/core/**');
    expect(text).toContain('7 min');
  });

  it('shows the cap of a bean against what the bean has spent', async () => {
    const text = await frame();

    expect(text).toContain('proj-42');
    expect(text).toContain('40,000 of 153,000 tokens');
  });

  it('says so when the board holds nothing', async () => {
    const text = await frame(EMPTY_BOARD);

    expect(text).toContain('0 records');
    expect(text).toContain('nothing on the board yet');
  });
});
