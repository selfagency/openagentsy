import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateRemote, remoteEnergyBreakdown } from './estimate.js';
import { type ModelArch, r, type SiteProfile, type Throughput, type Usage } from './types.js';

/** The shape of the fit file, as the derivation script writes it. */
interface FitFile {
  k_in: {
    value: number;
    unit: string;
    source: string;
    fittedOn: string;
    range: [number, number];
  };
  k_cache: {
    value: number;
    unit: string;
    source: string;
    fittedOn: string;
    range: [number, number];
  };
  method: string[];
  data_source: { id: string; snapshot: string; measurements: number };
  notes: string[];
  diagnostics: {
    residual_rms: number;
    residuals: { relative_residual: number }[];
  };
}

/** The fit the derivation script wrote. The tests use it, so it cannot drift. */
const FIT = JSON.parse(
  readFileSync(new URL('../data/prefill-fit.json', import.meta.url), 'utf8'),
) as FitFile;

const ARCH: ModelArch = { totalParamsB: r(300), activeParamsB: r(30), source: 'user' };
const SITE: SiteProfile = {
  pue: r(1.2),
  wueOnSite: r(0.5),
  wueOffSite: r(1.6),
  gridKgCo2PerKWh: r(0.4),
  source: 'test',
  disclosed: true,
};
const THROUGHPUT: Throughput = { ttftS: r(0), tps: r(60) };
const USAGE: Usage = {
  outputTokens: 0,
  inputTokens: 4000,
  cacheReadTokens: 2000,
  cacheWriteTokens: 0,
};

/** The fit as the package takes it: a coefficient with its range. */
const coeff = { kIn: r(FIT.k_in.value), kCache: r(FIT.k_cache.value) };

describe('the prefill term', () => {
  it('is the fit times the active parameters and the tokens', () => {
    const without = remoteEnergyBreakdown(USAGE, ARCH, THROUGHPUT);
    const with_ = remoteEnergyBreakdown(USAGE, ARCH, THROUGHPUT, { prefill: coeff });
    const expected = FIT.k_in.value * 30 * 4000 + FIT.k_cache.value * 30 * 2000;
    expect(with_.serverWh[0] - without.serverWh[0]).toBeCloseTo(expected, 12);
    expect(with_.serverWh[1] - without.serverWh[1]).toBeCloseTo(expected, 12);
  });

  it('reaches the impact through the data centre overhead', () => {
    const without = estimateRemote(USAGE, ARCH, SITE, THROUGHPUT);
    const with_ = estimateRemote(USAGE, ARCH, SITE, THROUGHPUT, { prefill: coeff });
    const prefillWh = FIT.k_in.value * 30 * 4000 + FIT.k_cache.value * 30 * 2000;
    expect(with_.energyWh[0] - without.energyWh[0]).toBeCloseTo(prefillWh * SITE.pue[0], 12);
    expect(with_.notes).toContain('prefill term on (OpenAgentsy extension, not EcoLogits)');
  });

  it('propagates the range of the coefficient', () => {
    const low = remoteEnergyBreakdown(USAGE, ARCH, THROUGHPUT, {
      prefill: { kIn: r(FIT.k_in.range[0]), kCache: r(FIT.k_cache.range[0]) },
    });
    const high = remoteEnergyBreakdown(USAGE, ARCH, THROUGHPUT, {
      prefill: { kIn: r(FIT.k_in.range[1]), kCache: r(FIT.k_cache.range[1]) },
    });
    expect(low.serverWh[0]).toBeLessThan(high.serverWh[0]);
    expect(low.serverWh[1]).toBeLessThan(high.serverWh[1]);
  });

  it('changes nothing when it is not asked for', () => {
    const usage: Usage = { ...USAGE, outputTokens: 150_000 };
    const impact = estimateRemote(usage, ARCH, SITE, THROUGHPUT);
    const withoutTokens = estimateRemote(
      { ...usage, inputTokens: 0, cacheReadTokens: 0 },
      ARCH,
      SITE,
      THROUGHPUT,
    );
    // The 2a behaviour, unchanged: the input tokens do not count, and the
    // estimate of the plan's worked example still holds.
    expect(impact.energyWh).toEqual(withoutTokens.energyWh);
    expect(Math.abs(impact.energyWh[0] - 197.2) / 197.2).toBeLessThan(1e-3);
    expect(impact.notes).not.toContain('prefill term on (OpenAgentsy extension, not EcoLogits)');
  });

  it('pins the fitted numbers, so a refit cannot drift silently', () => {
    expect(FIT.k_in.value).toBeCloseTo(7.187297432523553e-7, 18);
    expect(FIT.k_cache.value).toBeCloseTo(FIT.k_in.value * 0.1, 18);
    expect(FIT.k_in.range[0]).toBeLessThan(FIT.k_in.value);
    expect(FIT.k_in.value).toBeLessThan(FIT.k_in.range[1]);
    expect(FIT.diagnostics.residuals.length).toBe(12);
    expect(FIT.data_source.measurements).toBe(12);
  });

  it('names the source of every number', () => {
    expect(FIT.k_in.source).toContain('2505.06371');
    expect(FIT.k_in.fittedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FIT.k_cache.source).toContain('assumption');
    expect(FIT.method.length).toBeGreaterThan(3);
    expect(FIT.notes.join(' ')).toContain('does not ship enabled');
  });
});
