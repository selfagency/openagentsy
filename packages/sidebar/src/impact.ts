import {
  add,
  estimateLocal,
  estimateRemote,
  type Impact,
  type PrefillCoeff,
  type Range,
  r,
  type Usage,
} from '@openagentsy/footprint';
import { type FootprintConfig, isLocalProvider } from './config.js';
import type { UsageRow } from './usage.js';

/**
 * What the block knows about the footprint of a session.
 *
 * The estimates come from `@openagentsy/footprint`, which re-implements the
 * EcoLogits methodology and carries its own golden test against EcoLogits
 * 0.11.3. Nothing here re-estimates anything: this module only adds the
 * per-model estimates up and says which ones it could not make.
 */

/** The estimate of a whole family, and what it was made of. */
export interface FootprintEstimate {
  /** The sum over every model that could be estimated. */
  readonly impact: Impact;
  /** How many models went into the sum. */
  readonly estimated: number;
  /** How many models were left out, and why they are not in the sum. */
  readonly skipped: number;
}

/** How wide an interval is, relative to its low end. */
function width(range: Range): number {
  return (range[1] - range[0]) / Math.max(range[0], 1e-12);
}

/**
 * Which input the answer leans on hardest.
 *
 * The width of an interval, relative to its low end, decides it: the energy
 * widens with the model size, the water with the site, the carbon with the
 * grid and the warming with the climate sensitivity.
 */
function dominant(
  energyWh: Range,
  waterL: Range,
  co2Kg: Range,
  warmingC: Range,
): Impact['dominantUncertainty'] {
  const scores: Array<[Impact['dominantUncertainty'], number]> = [
    ['model-size', width(energyWh)],
    ['site', width(waterL)],
    ['grid', width(co2Kg)],
    ['tcre', width(warmingC)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0]?.[0] ?? 'model-size';
}

/**
 * The sum of a set of impacts.
 *
 * The plan names this helper in the footprint package, and it is not there:
 * the package estimates one request at a time and leaves the sum to the
 * caller, because only the caller knows which requests belong together.
 */
export function sumImpacts(impacts: readonly Impact[]): Impact {
  let energyWh: Range = r(0);
  let waterL: Range = r(0);
  let co2Kg: Range = r(0);
  let warmingC: Range = r(0);
  const notes: string[] = [];

  for (const impact of impacts) {
    energyWh = add(energyWh, impact.energyWh);
    waterL = add(waterL, impact.waterL);
    co2Kg = add(co2Kg, impact.co2Kg);
    warmingC = add(warmingC, impact.warmingC);
    for (const note of impact.notes) {
      if (!notes.includes(note)) notes.push(note);
    }
  }

  return {
    energyWh,
    waterL,
    co2Kg,
    warmingC,
    dominantUncertainty: dominant(energyWh, waterL, co2Kg, warmingC),
    notes,
  };
}

/** The impact of one model, when the project configured enough to say. */
function estimateRow(row: UsageRow, config: FootprintConfig): Impact | undefined {
  const site = config.site(row.providerID);
  if (!site) return undefined;

  if (isLocalProvider(config, row.providerID)) {
    if (!config.localDeviceWatts) return undefined;
    return estimateLocal(row.genSeconds, config.localDeviceWatts, site);
  }

  const throughput = config.throughput(row.providerID, row.modelID);
  if (!throughput) return undefined;

  const usage: Usage = {
    outputTokens: row.output,
    inputTokens: row.input,
    cacheReadTokens: row.cacheRead,
    cacheWriteTokens: row.cacheWrite,
  };

  const options: { prefill?: PrefillCoeff } = {};
  if (config.prefill) options.prefill = config.prefillCoeff;

  return estimateRemote(usage, config.arch(row.providerID, row.modelID), site, throughput, options);
}

/** The estimate of a whole family of models. */
export function estimateImpact(
  rows: readonly UsageRow[],
  config: FootprintConfig,
): FootprintEstimate {
  const impacts: Impact[] = [];
  let skipped = 0;

  for (const row of rows) {
    const impact = estimateRow(row, config);
    if (impact) impacts.push(impact);
    else skipped += 1;
  }

  return { impact: sumImpacts(impacts), estimated: impacts.length, skipped };
}
