import type { FootprintFacts, ReportRange } from '@openagentsy/core';
import { providerDefaults } from '@openagentsy/footprint';
import type { LedgerDb } from './scope.js';

/**
 * The footprint of the scope.
 *
 * The numbers are the ledger's `footprint` table: the estimate the
 * estimator produced, with the ends of the interval it produced it with and
 * the method that produced it. The table is the only place the estimate
 * lives, so the report reads it and computes nothing of its own.
 */

/** A number, when it is one. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** An interval, when both of its ends are numbers. */
function rangeOf(lo: unknown, hi: unknown): ReportRange | null {
  if (typeof lo !== 'number' || typeof hi !== 'number') return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** How wide an interval is, relative to its low end. */
function width(range: ReportRange): number {
  return (range[1] - range[0]) / Math.max(range[0], 1e-12);
}

/**
 * The input the answer leans on hardest.
 *
 * The rule is the one the estimator uses: the energy widens with the size
 * of the model, the water with the site and the carbon with the grid, and
 * the widest interval relative to its low end decides. The ledger stores
 * the bounds and not the inputs, so the rule is applied to the bounds. An
 * estimate whose bounds are all exact has nothing that dominates, and the
 * report says so rather than naming a winner.
 */
function dominant(
  energy: ReportRange | null,
  water: ReportRange | null,
  co2: ReportRange | null,
): string | null {
  const scores: [string, number][] = [
    ['model-size', energy === null ? 0 : width(energy)],
    ['site', water === null ? 0 : width(water)],
    ['grid', co2 === null ? 0 : width(co2)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const top = scores[0];
  if (top === undefined || top[1] <= 0) return null;
  return top[0];
}

/** The facts of a scope with no footprint estimate. */
function emptyFacts(): FootprintFacts {
  return {
    present: false,
    energyKwh: null,
    waterL: null,
    co2Kg: null,
    method: null,
    dominantUncertainty: null,
    grid: null,
    undisclosedProviders: 0,
  };
}

/**
 * The footprint of the scope.
 *
 * The rows are the estimates of the messages the scope selects, and the
 * bounds of the scope are the sums of the bounds of the rows. The table
 * records no grid, so the report says the grid is not recorded rather than
 * naming one it cannot read.
 */
export function footprintFacts(db: LedgerDb | null): FootprintFacts {
  if (db === null) return emptyFacts();

  const row = db
    .query(
      `SELECT
        SUM(f.energy_lo) AS energy_lo, SUM(f.energy_hi) AS energy_hi,
        SUM(f.water_lo) AS water_lo, SUM(f.water_hi) AS water_hi,
        SUM(f.co2_lo) AS co2_lo, SUM(f.co2_hi) AS co2_hi,
        COUNT(*) AS rows
       FROM main.footprint f
       JOIN temp.usage u ON u.message_id = f.message_id`,
    )
    .get() as Record<string, unknown> | null;

  const rows = n(row?.rows);
  if (rows === 0) {
    const providers = providersOf(db);
    return { ...emptyFacts(), undisclosedProviders: undisclosed(providers) };
  }

  const energy = rangeOf(row?.energy_lo, row?.energy_hi);
  const water = rangeOf(row?.water_lo, row?.water_hi);
  const co2 = rangeOf(row?.co2_lo, row?.co2_hi);
  const method = db
    .query(
      `SELECT DISTINCT f.method_version AS method
       FROM main.footprint f
       JOIN temp.usage u ON u.message_id = f.message_id`,
    )
    .all() as { method: string }[];

  return {
    present: true,
    energyKwh: energy === null ? null : [energy[0] / 1000, energy[1] / 1000],
    waterL: water,
    co2Kg: co2,
    method: method[0]?.method ?? null,
    dominantUncertainty: dominant(energy, water, co2),
    grid: null,
    undisclosedProviders: undisclosed(providersOf(db)),
  };
}

/** The providers the scope used. */
function providersOf(db: LedgerDb): string[] {
  const rows = db.query('SELECT DISTINCT provider FROM temp.usage').all() as { provider: string }[];
  return rows.map((row) => row.provider);
}

/**
 * The providers that do not disclose their infrastructure.
 *
 * The disclosure is the footprint package's table of what a provider says
 * about its own site: a provider that is not in the table discloses
 * nothing, and the report says how many of them there are rather than
 * leaving the reader to assume every number is known.
 */
function undisclosed(providers: readonly string[]): number {
  return providers.filter((provider) => !providerDefaults(provider).disclosed).length;
}
