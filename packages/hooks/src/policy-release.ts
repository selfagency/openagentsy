import { isSemver } from './policies/discovery.js';
import type { PolicyModule } from './policy.js';

/**
 * The release criteria of the policy library (§18.3).
 *
 * `oa release-check` is a later bean; what it needs from here is the list
 * of criteria the policy library answers, the severity of each of them and
 * whether it is met. The severity follows the decision the human made: a
 * first-party template and a first-party role are held to the criteria
 * hard, and a library is held to them softly.
 */

/** What is being released. */
export type ReleaseScope = 'template' | 'role' | 'library';

/** How hard a criterion is held. */
export type ReleaseSeverity = 'hard' | 'soft';

/** One criterion, and whether it is met. */
export interface ReleaseCriterion {
  /** The stable id of the criterion. */
  id: string;
  /** What the criterion asks for, in a line. */
  description: string;
  /** How hard the criterion is held. */
  severity: ReleaseSeverity;
  /** Whether the modules meet it. */
  met: boolean;
  /** What the answer was, in a line. */
  detail: string;
}

/**
 * The severity a scope holds a criterion to.
 *
 * A template and a role are what a person installs and trusts, so a
 * criterion is hard there. A library is a building block, and a soft
 * criterion is what a soft failure looks like.
 */
export function severityFor(scope: ReleaseScope): ReleaseSeverity {
  return scope === 'library' ? 'soft' : 'hard';
}

/**
 * The criteria the policy library answers, and their answers.
 *
 * Only the first-party modules are counted: a module a plugin brought is
 * marked external and does not count towards the criteria of a first-party
 * release.
 */
export function policyReleaseCriteria(
  modules: readonly PolicyModule[],
  scope: ReleaseScope,
): ReleaseCriterion[] {
  const severity = severityFor(scope);
  const firstParty = modules.filter((module) => module.origin === 'first-party');
  const external = modules.filter((module) => module.origin === 'external');

  const withoutId = firstParty.filter((module) => module.id.trim().length === 0);
  const withoutVersion = firstParty.filter((module) => !isSemver(module.version));
  const withoutLayer = firstParty.filter((module) => !Number.isInteger(module.layer));

  return [
    {
      id: 'policy-ids',
      description: 'Every first-party policy module carries a stable id.',
      severity,
      met: withoutId.length === 0,
      detail:
        withoutId.length === 0
          ? `${firstParty.length} first-party modules carry an id`
          : `${withoutId.length} modules carry no id`,
    },
    {
      id: 'policy-versions',
      description: 'Every first-party policy module carries a version.',
      severity,
      met: withoutVersion.length === 0,
      detail:
        withoutVersion.length === 0
          ? `${firstParty.length} first-party modules carry a version`
          : `${withoutVersion.length} modules carry no version`,
    },
    {
      id: 'policy-layers',
      description: 'Every first-party policy module maps to a layer of the guardrail stack.',
      severity,
      met: withoutLayer.length === 0,
      detail:
        withoutLayer.length === 0
          ? `${firstParty.length} first-party modules map to a layer`
          : `${withoutLayer.length} modules map to no layer`,
    },
    {
      id: 'policy-origin',
      description:
        'The modules a plugin brought are marked external and do not count towards the criteria.',
      severity,
      met: external.every((module) => module.origin === 'external'),
      detail:
        external.length === 0
          ? 'no plugin module is in the release'
          : `${external.length} plugin modules are marked external and are not counted`,
    },
  ];
}
