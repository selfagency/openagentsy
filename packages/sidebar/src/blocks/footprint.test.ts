import type { SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { describe, expect, it } from 'vitest';
import { buildFootprintConfig } from '../config.js';
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

/** The host, as far as the block can tell. */
function fakeContext(messages: SessionMessageInfo[]): Plugin.Context {
  const data = {
    session: {
      family: (sessionID: string) => [sessionID],
      message: {
        list: () => messages,
        sync: async () => undefined,
      },
    },
  };
  const theme = {
    text: { base: RGBA.fromHex('#e6e6e6'), muted: RGBA.fromHex('#8a8a8a') },
  };
  const ui = { panel: { open: () => true } };
  return { data, theme, ui } as unknown as Plugin.Context;
}

/** The frame the block draws, as text. */
async function renderFrame(config = CONFIG): Promise<string> {
  const setup = await testRender(() => footprintTree(fakeContext(MESSAGES), config), {
    width: 72,
    height: 24,
  });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  await setup.dispose();
  return frame;
}

describe('the footprint block', () => {
  it('renders the footprint of a fixture', async () => {
    const frame = await renderFrame();

    expect(frame).toContain('Footprint');
    expect(frame).toContain('Electricity');
    expect(frame).toContain('Water');
    expect(frame).toContain('Carbon');
    expect(frame).toContain('Warming');
  });

  it('shows every value as a range and not as a single number', async () => {
    const frame = await renderFrame();

    expect(frame).toMatch(/Electricity \d[\d.]*–[\d.]* (Wh|kWh)/);
    expect(frame).toMatch(/Carbon \d[\d.]*–[\d.]* (g|kg) WORLD/);
    expect(frame).toMatch(/Warming \d[\d.]*–[\d.]* × 10/);
  });

  it('says what the range comes mostly from', async () => {
    const frame = await renderFrame();

    expect(frame).toContain('the range comes mostly from');
  });

  it('stays hidden when the project configured nothing', async () => {
    const frame = await renderFrame(buildFootprintConfig({}));

    expect(frame).not.toContain('Footprint');
  });
});
