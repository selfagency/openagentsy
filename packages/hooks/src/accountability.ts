import { createWaiverStore } from './quality/waivers.js';

/**
 * The counts the Accountability block shows.
 *
 * The block itself is the sidebar's (plan §7.4) and it is phase 2e's. What
 * lives here is the data the block renders: the count of the waivers a
 * person recorded, and the line the block shows for it. A block that has to
 * reach into a file to count a thing is a block that has to know where the
 * file is, so the reading is done here and the block only renders.
 */

/** The counts. */
export type AccountabilityCounts = {
  /** The waivers a person recorded. */
  waivers: number;
};

/**
 * The counts, read from the state root.
 *
 * A state root with no waivers file holds no waivers, and that is a count
 * of zero and not a failure.
 */
export async function accountabilityCounts(root: string): Promise<AccountabilityCounts> {
  return { waivers: await createWaiverStore(root).count() };
}

/**
 * The line the block shows.
 *
 * The plan's example reads "2 waivers", so the count comes first and the
 * word follows it.
 */
export function formatAccountability(counts: AccountabilityCounts): string {
  const waivers = counts.waivers;
  return `${waivers} ${waivers === 1 ? 'waiver' : 'waivers'}`;
}
