import { detectAgiFraming } from '../output-detectors.js';
import { allow, flag, type PolicyModule } from '../policy.js';

/**
 * The AGI framing policy (§21.2).
 *
 * It flags the claim that the system replaces the people who built it, and
 * the longtermist framing around it (§17.2).
 */

/** The stable id of the policy. */
export const AGI_FRAMING_ID = 'oa.agi-framing';

/** The policy itself. */
export const agiFraming: PolicyModule = {
  id: AGI_FRAMING_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags AGI, longtermist and post-human framing.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = detectAgiFraming(text);
    if (found.length === 0) return allow();
    return flag(
      found.map((entry) => ({
        policyId: AGI_FRAMING_ID,
        type: entry.type,
        match: entry.match,
      })),
    );
  },
};
