import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateRemote } from './estimate.js';
import { type ModelArch, r, type SiteProfile, type Throughput, type Usage } from './types.js';

type GoldenEntry = {
  provider: string;
  model: string;
  outputTokens: number;
  tps: number;
  ttftS: number;
  paramsB: number;
  pue: [number, number];
  wueOnSite: [number, number];
  gridKgCo2PerKWh: number;
  gridWueLPerKWh: number;
  energyKWh: number;
  co2Kg: number;
  waterL: number;
};

const goldenPath = fileURLToPath(new URL('../data/golden.json', import.meta.url));
const present = existsSync(goldenPath);

function readEntries(): GoldenEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(goldenPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) return [];
  const entries = (parsed as { entries?: unknown }).entries;
  return Array.isArray(entries) ? (entries as GoldenEntry[]) : [];
}

const entries = present ? readEntries() : [];

function mid(range: readonly [number, number]): number {
  return (range[0] + range[1]) / 2;
}

function expectClose(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

describe.skipIf(!present)('the golden estimates', () => {
  it('holds twenty fixed pairs', () => {
    expect(entries).toHaveLength(20);
  });

  for (const entry of entries) {
    it(`matches the methodology for ${entry.provider}/${entry.model}`, () => {
      const arch: ModelArch = {
        totalParamsB: r(entry.paramsB),
        activeParamsB: r(entry.paramsB),
        source: 'ecologits',
      };
      const site: SiteProfile = {
        pue: r(entry.pue[0], entry.pue[1]),
        wueOnSite: r(entry.wueOnSite[0], entry.wueOnSite[1]),
        wueOffSite: r(entry.gridWueLPerKWh),
        gridKgCo2PerKWh: r(entry.gridKgCo2PerKWh),
        source: `ecologits:${entry.provider}`,
        disclosed: true,
      };
      const usage: Usage = {
        outputTokens: entry.outputTokens,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const throughput: Throughput = { ttftS: r(entry.ttftS), tps: r(entry.tps) };

      const impact = estimateRemote(usage, arch, site, throughput);

      expectClose(mid(impact.energyWh) / 1000, entry.energyKWh, 0.01);
      expectClose(mid(impact.co2Kg), entry.co2Kg, 0.01);
      expectClose(mid(impact.waterL), entry.waterL, 0.01);
    });
  }
});
