import { detectSycophancy } from '../output-detectors.js';
import { allow, flag, type PolicyModule } from '../policy.js';

/**
 * The anti-sycophancy policy (§21.2).
 *
 * It flags praise and agreement that come without reasoning. The threshold
 * is lower in a high-risk context (§20.3): there, the same words are a
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
    const found = detectSycophancy(text);
    if (found.length === 0) return allow();
    return flag(
      found.map((entry) => ({
        policyId: ANTI_SYCOPHANCY_ID,
        type: entry.type,
        match: entry.match,
      })),
      ctx.highRiskDomain === undefined ? 'warn' : 'error',
    );
  },
};
