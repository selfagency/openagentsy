import { type Impact, r } from '@openagentsy/footprint';
import { describe, expect, it } from 'vitest';
import { buildFootprintConfig } from './config.js';
import { estimateImpact, sumImpacts } from './impact.js';
import type { UsageRow } from './usage.js';

/**
 * The summation of the estimates.
 *
 * The footprint package estimates one request at a time, and leaves the sum
 * to the caller, because only the caller knows which requests belong
 * together.
 */

/** An impact, as the estimator returns it. */
function impact(energy: number, notes: string[] = []): Impact {
  return {
    energyWh: r(energy, energy * 2),
    waterL: r(energy / 10, energy / 5),
    co2Kg: r(energy / 1000, energy / 500),
    warmingC: r(energy * 1e-19, energy * 2e-19),
    dominantUncertainty: 'model-size',
    notes,
  };
}

/** A row of usage, as the family hook returns it. */
function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    key: 'anthropic/claude-sonnet-4-5',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    input: 1_200,
    output: 4_000,
    cacheRead: 800,
    cacheWrite: 0,
    cost: 0.12,
    genSeconds: 20,
    ...overrides,
  };
}

describe('the sum of the impacts', () => {
  it('adds the ends of every interval', () => {
    const total = sumImpacts([impact(10), impact(5)]);

    expect(total.energyWh).toEqual([15, 30]);
    expect(total.waterL).toEqual([1.5, 3]);
  });

  it('keeps each note once', () => {
    const total = sumImpacts([impact(10, ['one']), impact(5, ['one', 'two'])]);

    expect(total.notes).toEqual(['one', 'two']);
  });

  it('is empty for no impact at all', () => {
    const total = sumImpacts([]);

    expect(total.energyWh).toEqual([0, 0]);
    expect(total.notes).toEqual([]);
  });
});

describe('the estimate of a family', () => {
  const config = buildFootprintConfig({
    region: 'WORLD',
    grid: { WORLD: { kgCo2PerKWh: [0.4, 0.6], wueLPerKWh: [1, 2] } },
    models: {
      'anthropic/claude-sonnet-4-5': { totalParamsB: [200, 200], activeParamsB: [30, 30] },
    },
    throughput: {
      'anthropic/claude-sonnet-4-5': { ttftS: [0.5, 1.5], tps: [40, 80] },
    },
  });

  it('estimates the model the project configured', () => {
    const estimate = estimateImpact([row()], config);

    expect(estimate.estimated).toBe(1);
    expect(estimate.skipped).toBe(0);
    expect(estimate.impact.energyWh[1]).toBeGreaterThan(0);
  });

  it('leaves out a model the project did not configure', () => {
    const estimate = estimateImpact(
      [row(), row({ key: 'openai/gpt-5', providerID: 'openai', modelID: 'gpt-5' })],
      config,
    );

    expect(estimate.estimated).toBe(1);
    expect(estimate.skipped).toBe(1);
  });

  it('estimates nothing when the project configured no grid', () => {
    const estimate = estimateImpact([row()], buildFootprintConfig({}));

    expect(estimate.estimated).toBe(0);
    expect(estimate.skipped).toBe(1);
  });
});
