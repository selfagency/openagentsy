import {
  BASELINE_DETECTOR_THRESHOLDS,
  type DetectorThresholds,
  HIGH_RISK_DOMAINS,
  type HighRiskDomain,
  loweredThresholds,
} from '@openagentsy/quality/high-risk';
import type { PolicyContext } from './policy.js';

/**
 * The thresholds the graded detectors fire at (§20.3).
 *
 * The quality package publishes the two sets: the baseline thresholds, and
 * the lowered ones a high-risk domain brings in. This package does not
 * keep a third set of its own - the numbers live in one place, and a
 * change there is a change everywhere.
 *
 * The domain in a context is a string, and the quality package names its
 * domains with a union of its own. A domain the quality package does not
 * know cannot lower a threshold, so it falls back to the baseline rather
 * than throwing in the middle of a reply.
 */

/**
 * Whether a domain is one the quality package knows.
 *
 * The list is the classifier's, so the two cannot drift apart.
 */
function isKnownDomain(domain: string): domain is HighRiskDomain {
  return (HIGH_RISK_DOMAINS as readonly string[]).includes(domain);
}

/**
 * The thresholds in force for a context.
 *
 * The baseline thresholds hold unless the context carries a high-risk
 * domain (§20.3): there, the same thresholds are lowered, so a reply that
 * would be a warning elsewhere is a finding here.
 */
export function thresholdsInForce(ctx: PolicyContext): DetectorThresholds {
  const domain = ctx.highRiskDomain;
  if (domain === undefined) return BASELINE_DETECTOR_THRESHOLDS;
  if (!isKnownDomain(domain)) return BASELINE_DETECTOR_THRESHOLDS;
  return loweredThresholds(domain);
}
