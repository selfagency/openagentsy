import { describe, expect, it } from 'vitest';
import { collapseStore } from '../persist.js';
import { CONFIG, EMPTY_CONFIG, MESSAGES } from '../testing/fixtures.js';
import { fakeHost, renderFrame } from '../testing/harness.js';
import { footprintTree } from './footprint.render.js';

/**
 * The exit test of the package.
 *
 * The block is rendered from a fixture, in the test renderer that OpenTUI
 * ships, and the frame it draws is read back as text. That is the claim
 * being tested: the block turns a session's numbers into a frame, with the
 * values the footprint estimator produced and nothing else.
 */

/** The frame the block draws, as text. */
async function frame(config = CONFIG): Promise<string> {
  const host = fakeHost({ messages: MESSAGES });
  const collapse = collapseStore(host.context);
  return renderFrame(() => footprintTree(host.context, config, collapse));
}

describe('the footprint block', () => {
  it('renders the footprint of a fixture', async () => {
    const text = await frame();

    expect(text).toContain('Footprint');
    expect(text).toContain('Electricity');
    expect(text).toContain('Water');
    expect(text).toContain('Carbon');
    expect(text).toContain('Warming');
  });

  it('shows every value as a range and not as a single number', async () => {
    const text = await frame();

    expect(text).toMatch(/Electricity \d[\d.]*–[\d.]* (Wh|kWh)/);
    expect(text).toMatch(/Carbon \d[\d.]*–[\d.]* (g|kg) WORLD/);
    expect(text).toMatch(/Warming \d[\d.]*–[\d.]* × 10/);
  });

  it('says what the range comes mostly from', async () => {
    const text = await frame();

    expect(text).toContain('the range comes mostly from');
  });

  it('stays hidden when the project configured nothing', async () => {
    const text = await frame(EMPTY_CONFIG);

    expect(text).not.toContain('Footprint');
  });
});
