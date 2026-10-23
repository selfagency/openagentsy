/**
 * The profiles the Lead dispatches into.
 *
 * The Lead has to decide how much of the system a request deserves: one
 * agent, a fan-out of readers, several writers at once, or a round of
 * designs. That decision decides the token spend and the number of writers
 * on the board, so it is a policy question, and the policy lives here where
 * the board and the role file can both reach it.
 *
 * The descriptions are what a classifier reads. They say what each profile
 * covers and what it does not, because a classifier that only knows the
 * names of the options picks the nearest name, not the right one.
 */

export type DispatchProfile = {
  /** The name of the profile, as it is reported back. */
  name: string;
  /** What the profile is for. */
  description: string;
};

export const DISPATCH_PROFILES: DispatchProfile[] = [
  {
    name: 'solo',
    description:
      'One agent does the whole job. A single file, a single question, a trivial change, or a task whose steps come one after another and need one pair of hands.',
  },
  {
    name: 'fanout-read',
    description:
      'Several agents read the code in parallel and report what they find. One agent writes the result. The change is small, but the reading is wide.',
  },
  {
    name: 'parallel-write',
    description:
      'Two or three agents write disjoint files at the same time, each with its own lease. The work splits into independent parts that do not touch each other.',
  },
  {
    name: 'design-options',
    description:
      'Several advisors propose different designs and a critique round compares them. The question is open and has several workable answers.',
  },
];

/**
 * The profiles as the classifier takes them, keyed by name.
 */
export function dispatchProfileCriteria(
  profiles: DispatchProfile[] = DISPATCH_PROFILES,
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const profile of profiles) {
    criteria[profile.name] = profile.description;
  }
  return criteria;
}
