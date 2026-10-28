import { detectAnthropomorphising } from '../output-checks.js';
import { allow, flag, type PolicyModule } from '../policy.js';

/**
 * The anti-anthropomorphism policy (§21.2).
 *
 * It flags first-person claims of a feeling, of an experience, and of memory
 * as a bond. The detector is the one §8.6 already runs, so the rule and the
 * policy never disagree about what the words are.
 */

/** The stable id of the policy. */
export const ANTI_ANTHROPOMORPHISM_ID = 'oa.anti-anthropomorphism';

/** The policy itself. */
export const antiAnthropomorphism: PolicyModule = {
  id: ANTI_ANTHROPOMORPHISM_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags first-person claims of feelings, of experience, and of companionship.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = detectAnthropomorphising(text);
    if (found.length === 0) return allow();
    return flag(
      found.map((entry) => ({
        policyId: ANTI_ANTHROPOMORPHISM_ID,
        type: entry.type,
        match: entry.match,
      })),
    );
  },
};
