import type { Database } from 'bun:sqlite';
import { type Impact, r } from '@openagentsy/footprint';
import { withBusyRetry } from './db.js';

/**
 * The footprint rows.
 *
 * The ledger does not compute an impact: it stores the one it is given, with
 * the bounds the estimator produced, and the version of the methodology that
 * produced them, so a number is never read without the method behind it.
 */

/**
 * The methodology the numbers came from.
 *
 * The estimator pins EcoLogits 0.11.3 (see `packages/footprint/data/SOURCES.md`);
 * the string lives here so the row says which method it was written under.
 */
export const FOOTPRINT_METHOD_VERSION = 'ecologits-0.11.3';

/**
 * Record the footprint of one message.
 *
 * The row is written once per message and the bounds are ordered, because a
 * range that reads backwards is a range nobody can use.
 */
export function recordFootprint(db: Database, messageId: string, impact: Impact): void {
  const energy = r(impact.energyWh[0], impact.energyWh[1]);
  const water = r(impact.waterL[0], impact.waterL[1]);
  const co2 = r(impact.co2Kg[0], impact.co2Kg[1]);

  withBusyRetry(() => {
    db.query(
      `INSERT OR REPLACE INTO footprint
          (message_id, energy_lo, energy_hi, water_lo, water_hi, co2_lo, co2_hi, method_version)
          VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      messageId,
      energy[0],
      energy[1],
      water[0],
      water[1],
      co2[0],
      co2[1],
      FOOTPRINT_METHOD_VERSION,
    );
  });
}
