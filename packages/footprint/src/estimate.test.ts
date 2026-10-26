import { describe, expect, it } from 'vitest';
import { TCRE_BEST_C_PER_KG } from './constants.js';
import {
  energyPerToken,
  estimateLocal,
  estimateRemote,
  gpuCount,
  remoteEnergyBreakdown,
} from './estimate.js';
import { type ModelArch, r, type SiteProfile, type Throughput, type Usage } from './types.js';

/** The plan's numbers are rounded, so a relative tolerance is the honest one. */
function expectClose(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

/** The worked example of the plan: a 300B model, 150k tokens, a 0.4 grid. */
const USAGE: Usage = {
  outputTokens: 150_000,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const ARCH: ModelArch = {
  totalParamsB: r(300),
  activeParamsB: r(30),
  source: 'user',
};
const SITE: SiteProfile = {
  pue: r(1.2),
  wueOnSite: r(0.5),
  wueOffSite: r(1.6),
  gridKgCo2PerKWh: r(0.4),
  source: 'test',
  disclosed: true,
};
const THROUGHPUT: Throughput = { ttftS: r(0), tps: r(60) };

/** A generator that repeats, so a failure is a failure and not a bad day. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the footprint estimator', () => {
  it('reproduces the worked example of the plan', () => {
    expect(gpuCount(300)).toBe(16);
    expectClose(energyPerToken(30), 5.76e-5, 2e-3);

    const breakdown = remoteEnergyBreakdown(USAGE, ARCH, THROUGHPUT);
    expectClose(breakdown.gpuWh[0], 138.3, 1e-3);
    expectClose(breakdown.restWh[0], 26.0, 2.5e-3);

    const impact = estimateRemote(USAGE, ARCH, SITE, THROUGHPUT);
    expectClose(impact.energyWh[0], 197.2, 1e-3);
    expectClose(impact.co2Kg[0] * 1000, 78.9, 1e-3);
    expectClose(impact.co2Kg[0] * TCRE_BEST_C_PER_KG, 3.55e-17, 1e-3);
  });

  it('counts the output tokens only, and says so', () => {
    const impact = estimateRemote(USAGE, ARCH, SITE, THROUGHPUT);
    expect(impact.notes).toContain('output tokens only (EcoLogits method)');
    expect(impact.notes).not.toContain('prefill term on (OpenAgentsy extension, not EcoLogits)');
  });

  it('adds the prefill term only when it is asked for', () => {
    const usage: Usage = { ...USAGE, inputTokens: 2000, cacheReadTokens: 500 };
    const without = estimateRemote(usage, ARCH, SITE, THROUGHPUT);
    const with_ = estimateRemote(usage, ARCH, SITE, THROUGHPUT, {
      prefill: { kIn: 1e-8, kCache: 1e-9 },
    });
    expect(with_.energyWh[0]).toBeGreaterThan(without.energyWh[0]);
    expect(with_.notes).toContain('prefill term on (OpenAgentsy extension, not EcoLogits)');
  });

  it('caps the generation time at the measured latency', () => {
    const slow: Usage = { ...USAGE, latencyS: 10 };
    const breakdown = remoteEnergyBreakdown(slow, ARCH, THROUGHPUT);
    expect(breakdown.restWh[1]).toBeLessThan(
      remoteEnergyBreakdown(USAGE, ARCH, THROUGHPUT).restWh[0],
    );
  });

  it('counts no data centre water for a local run', () => {
    const impact = estimateLocal(60, r(25, 60), SITE);
    // 25 W for 60 s is 0.4167 Wh, which is 0.0004167 kWh of electricity.
    expect(impact.waterL[0]).toBeCloseTo(((25 * 60) / 3600 / 1000) * 1.6, 12);
    expect(impact.dominantUncertainty).toBe('grid');
  });

  it('keeps every bound in order, whatever the input', () => {
    const random = makeRandom(20261026);
    for (let i = 0; i < 200; i += 1) {
      const arch: ModelArch = {
        totalParamsB: r(random() * 500, random() * 900),
        activeParamsB: r(random() * 80, random() * 120),
        source: 'user',
      };
      const site: SiteProfile = {
        pue: r(1 + random() * 0.2, 1 + random() * 0.4),
        wueOnSite: r(random() * 0.2, random() * 1.4),
        wueOffSite: r(random() * 0.5, random() * 2),
        gridKgCo2PerKWh: r(random() * 0.1, random() * 0.9),
        source: 'test',
        disclosed: false,
      };
      const usage: Usage = {
        outputTokens: Math.floor(random() * 5000),
        inputTokens: Math.floor(random() * 2000),
        cacheReadTokens: Math.floor(random() * 2000),
        cacheWriteTokens: 0,
      };
      const throughput: Throughput = {
        ttftS: r(random() * 0.5, random() * 1.5),
        tps: r(5 + random() * 100, 10 + random() * 200),
      };
      const impact = estimateRemote(usage, arch, site, throughput);
      for (const range of [impact.energyWh, impact.waterL, impact.co2Kg, impact.warmingC]) {
        expect(range[0]).toBeLessThanOrEqual(range[1]);
      }
    }
  });

  it('never spends less energy for more tokens', () => {
    const random = makeRandom(7);
    for (let i = 0; i < 50; i += 1) {
      const arch: ModelArch = {
        totalParamsB: r(10, 10 + random() * 400),
        activeParamsB: r(2, 2 + random() * 90),
        source: 'user',
      };
      const throughput: Throughput = { ttftS: r(0, random() * 0.5), tps: r(20, 90) };
      const small = estimateRemote(
        { outputTokens: 100, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        arch,
        SITE,
        throughput,
      );
      const large = estimateRemote(
        { outputTokens: 2000, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        arch,
        SITE,
        throughput,
      );
      expect(large.energyWh[0]).toBeGreaterThanOrEqual(small.energyWh[0]);
      expect(large.energyWh[1]).toBeGreaterThanOrEqual(small.energyWh[1]);
    }
  });

  it('never needs fewer GPUs for a bigger model', () => {
    const random = makeRandom(31);
    const sizes = Array.from({ length: 500 }, () => random() * 2000).sort((a, b) => a - b);
    let previous = gpuCount(sizes[0] ?? 0);
    for (const size of sizes) {
      const count = gpuCount(size);
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });
});
