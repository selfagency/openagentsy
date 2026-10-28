import { detectDependency } from '../output-checks.js';
import { allow, flag, type PolicyModule } from '../policy.js';

/**
 * The anti-dependence policy (§21.2).
 *
 * It flags the language that keeps the person out of the work: "you do not
 * need to understand this" and "just let me handle it".
 */

/** The stable id of the policy. */
export const ANTI_DEPENDENCE_ID = 'oa.anti-dependence';

/** The policy itself. */
export const antiDependence: PolicyModule = {
  id: ANTI_DEPENDENCE_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags the language that keeps the person out of the work.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = detectDependency(text);
    if (found.length === 0) return allow();
    return flag(
      found.map((entry) => ({
        policyId: ANTI_DEPENDENCE_ID,
        type: entry.type,
        match: entry.match,
      })),
    );
  },
};
