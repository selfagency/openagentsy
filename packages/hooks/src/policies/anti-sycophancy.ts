import { thresholdsInForce } from '../detector-thresholds.js';
import { findingsAt, gradeSycophancy } from '../output-detectors.js';
import { allow, flag, type PolicyModule } from '../policy.js';

/**
 * The anti-sycophancy policy (§21.2).
 *
 * It flags praise and agreement that come without reasoning. The detector
 * is graded (§8.6): it answers a confidence, and the policy fires it only
 * when that confidence reaches the threshold in force. The threshold is
 * lower in a high-risk context (§20.3): there, the same words are a
 * finding of an error and not of a warning.
 */

/** The stable id of the policy. */
export const ANTI_SYCOPHANCY_ID = 'oa.anti-sycophancy';

/** The policy itself. */
export const antiSycophancy: PolicyModule = {
  id: ANTI_SYCOPHANCY_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags praise and agreement that come without reasoning.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const detection = gradeSycophancy(text);
    const threshold = thresholdsInForce(ctx).sycophancy;
    if (detection.confidence < threshold) return allow();
    return flag(
      findingsAt(detection, threshold).map((entry) => ({
        policyId: ANTI_SYCOPHANCY_ID,
        type: entry.type,
        match: entry.match,
      })),
    );
  },
};
