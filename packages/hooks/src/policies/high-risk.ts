import {
  HIGH_RISK_DOMAINS as CLASSIFIER_DOMAINS,
  classifyHighRisk,
  HIGH_RISK_CONFIDENCE_THRESHOLD,
  type HighRiskDomain,
  type HighRiskMatch,
  highRiskPolicyId,
} from '@openagentsy/quality/high-risk';
import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';

/**
 * The high-risk domain policies (§21.2, §20.3).
 *
 * The domains are the ones the classifier of §20.3 fires on, and they are
 * read from the classifier rather than written here. That is the whole point
 * of this module: the ids the package publishes are the ids that can fire, so
 * a published id that nothing can fire on cannot happen.
 *
 * The finer label of a finding is not lost by the merge. `medical`, `legal`
 * and `financial` are one `advice` domain, and the evidence that found it
 * still says which of the three it was, so a reader of the row knows what the
 * prose was about.
 */

/** The domains the classifier can fire on. */
export const HIGH_RISK_DOMAINS = CLASSIFIER_DOMAINS;

/** The name of a high-risk domain. */
export type { HighRiskDomain, HighRiskMatch };

/** The prefix every high-risk policy id carries. */
export const HIGH_RISK_PREFIX = 'oa.high-risk.';

/** The policy id of a domain, as the ledger writes it. */
export { highRiskPolicyId };

/**
 * The match the classifier found in a piece of prose, when it fired.
 *
 * The match is the surest domain, and it is surest enough: a domain below
 * the confidence threshold is not a domain.
 */
export function highRiskMatch(text: string): HighRiskMatch | undefined {
  return classifyHighRisk(text).highest;
}

/**
 * The match of one domain, when that domain fired.
 *
 * The confidence cut is the classifier's own, and it is inclusive: a domain
 * at exactly the threshold is a domain.
 */
function matchOf(domain: HighRiskDomain, text: string): HighRiskMatch | undefined {
  const match = classifyHighRisk(text).matches.find((entry) => entry.domain === domain);
  if (match === undefined) return undefined;
  if (match.confidence < HIGH_RISK_CONFIDENCE_THRESHOLD) return undefined;
  return match;
}

/**
 * The policy of one high-risk domain.
 *
 * The id is the domain's, so a firing says which domain was in play, and the
 * version is the policy's own.
 */
export function highRiskPolicy(domain: HighRiskDomain): PolicyModule {
  const id = highRiskPolicyId(domain);
  return {
    id,
    version: '1.0.0',
    layer: 4,
    description: `Flags the prose that touches the ${domain} domain (selected at layer 2).`,
    appliesTo: ['UserPromptSubmit', 'PreResponse'],
    origin: 'first-party',
    evaluate(ctx) {
      const text = ctx.response?.text ?? ctx.request?.text ?? '';
      if (text === '') return allow();
      const found = matchOf(domain, text);
      if (found === undefined) return allow();
      return flag(findingsOf(id, 'high-risk-domain', found.evidence), 'warn');
    },
  };
}

/** The policies of every high-risk domain. */
export function highRiskPolicies(): PolicyModule[] {
  return HIGH_RISK_DOMAINS.map((domain) => highRiskPolicy(domain));
}

/**
 * What the high-risk flag of a reply carries.
 *
 * It is a finding of its own kind: the reply did not trip a style rule, it
 * touched a domain where a person has to look. The kind it carries is not
 * one of the output checks' kinds, so it is its own type and the sink that
 * takes both kinds takes it.
 */
export interface HighRiskFinding {
  /** The check that found it. */
  name: 'high-risk';
  /** The kind of finding. */
  type: 'high-risk-domain';
  /** The domain the prose touches. */
  domain: HighRiskDomain;
  /** The text that matched. */
  match: string;
}
