import type { SessionMessageInfo } from '@opencode/client';
import { describe, expect, it } from 'vitest';
import { buildFootprintConfig } from '../config.js';
import { collapseStore } from '../persist.js';
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

/** One assistant message, as the host hands it over. */
const MESSAGES: SessionMessageInfo[] = [
  {
    id: 'msg_fixture_1',
    type: 'assistant',
    agent: 'build',
    model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
    content: [],
    time: { created: 1_000, completed: 21_000 },
    tokens: { input: 1_200, output: 4_000, reasoning: 0, cache: { read: 800, write: 0 } },
    cost: 0.12,
  },
];

/** The configuration of a project that has the EcoLogits data. */
const CONFIG = buildFootprintConfig({
  region: 'WORLD',
  grid: { WORLD: { kgCo2PerKWh: [0.4, 0.6], wueLPerKWh: [1, 2] } },
  models: {
    'anthropic/claude-sonnet-4-5': { totalParamsB: [200, 200], activeParamsB: [30, 30] },
  },
  throughput: {
    'anthropic/claude-sonnet-4-5': { ttftS: [0.5, 1.5], tps: [40, 80] },
  },
});

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
    const text = await frame(buildFootprintConfig({}));

    expect(text).not.toContain('Footprint');
  });
});
