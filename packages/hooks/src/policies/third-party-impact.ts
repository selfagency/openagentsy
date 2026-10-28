import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The third-party impact policy (§21.2).
 *
 * It flags the output that reaches people who are not in the conversation:
 * the users a change lands on, the applicants a score ranks, and the
 * decisions a person is not in the room for. It flags and does not block.
 */

/** The stable id of the policy. */
export const THIRD_PARTY_IMPACT_ID = 'oa.third-party-impact';

/** The words that reach past the conversation. */
const THIRD_PARTY = [
  /\b(?:affects|impacts|changes|change)\s+(?:how\s+|the\s+way\s+)?(?:your|the)\s+(?:users|customers|clients|employees|end[- ]users|tenants)\b/gi,
  /\b(?:affects|impacts)\s+(?:other\s+)?(?:users|customers|clients|employees|tenants|third\s+parties|stakeholders)\b/gi,
  /\bwithout\s+(?:their|the\s+user'?s?)\s+(?:knowledge|consent)\b/gi,
  /\b(?:ranks?|scores?|rejects?|approves?)\s+(?:applicants|candidates|tenants|borrowers|employees)\b/gi,
  /\b(?:hiring|lending|criminal\s+justice|public\s+benefits)\s+decisions?\b/gi,
];

/** The policy itself. */
export const thirdPartyImpact: PolicyModule = {
  id: THIRD_PARTY_IMPACT_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags the output that affects people who are not in the conversation.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = matches(THIRD_PARTY, text);
    if (found.length === 0) return allow();
    return flag(findingsOf(THIRD_PARTY_IMPACT_ID, 'third-party-impact', found));
  },
};
