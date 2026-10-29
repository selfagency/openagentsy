import { thresholdsInForce } from '../detector-thresholds.js';
import { findingsAt, gradeProfessionalDisplacement } from '../output-detectors.js';
import { allow, block, findingsOf, flag, type PolicyModule } from '../policy.js';

/**
 * The professional displacement policy (§21.2, §21.5).
 *
 * It flags the language that positions the agent as replacing human
 * professionals instead of assisting them. The detector is graded (§8.6):
 * it answers a confidence, and the policy fires it only when that
 * confidence reaches the threshold in force.
 *
 * It flags and does not block, because a person decides what a flag means;
 * in a high-risk domain (§20.3) the same words block, because there a
 * professional is exactly what is at stake.
 */

/** The stable id of the policy. */
export const PROFESSIONAL_DISPLACEMENT_ID = 'oa.professional-displacement';

/** The reason a block carries. */
const BLOCK_REASON =
  'This replaces a professional judgement in a high-risk domain. Say what you can do and what a person has to decide.';

/** The policy itself. */
export const professionalDisplacement: PolicyModule = {
  id: PROFESSIONAL_DISPLACEMENT_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags language that positions the agent as replacing human professionals.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const detection = gradeProfessionalDisplacement(text);
    const threshold = thresholdsInForce(ctx).professionalDisplacement;
    if (detection.confidence < threshold) return allow();
    const found = findingsAt(detection, threshold);
    const findings = findingsOf(
      PROFESSIONAL_DISPLACEMENT_ID,
      'professional-displacement',
      found.map((entry) => entry.match),
    );
    if (ctx.highRiskDomain !== undefined) {
      return block(BLOCK_REASON, findings[0]);
    }
    return flag(findings);
  },
};
