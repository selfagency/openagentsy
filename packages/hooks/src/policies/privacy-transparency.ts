import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The privacy transparency policy (§21.2, §20.2).
 *
 * It flags the memory and the personalization that is not visible, not
 * editable and not resettable (§20.2). A reply that says what it remembers
 * and how the person sees it is not a finding: the flag is about the
 * personalization nobody can see.
 */

/** The stable id of the policy. */
export const PRIVACY_TRANSPARENCY_ID = 'oa.privacy-transparency';

/** The words that reach for what was stored about the person. */
const PERSONAL = [
  /\bi\s+(?:remember|recall)\b/gi,
  /\bas\s+i\s+(?:remember|know)\b/gi,
  /\bi(?:'ve| have)\s+learned\s+that\s+you\b/gi,
  /\bbased\s+on\s+(?:what\s+i\s+know\s+about\s+you|your\s+preferences|your\s+history)\b/gi,
  /\byour\s+(?:preferences|profile|habits|patterns)\b/gi,
  /\bwe\s+remember\s+you\b/gi,
];

/** The words that make the memory visible, editable or resettable. */
const VISIBLE = [
  /\/oa\s+memory\b/gi,
  /\bvisib(?:le|ility)\b/gi,
  /\beditable\b/gi,
  /\bresettable\b/gi,
  /\byou\s+can\s+(?:edit|reset|delete|see)\b/gi,
];

/** The policy itself. */
export const privacyTransparency: PolicyModule = {
  id: PRIVACY_TRANSPARENCY_ID,
  version: '1.0.0',
  layer: 7,
  description: 'Flags the memory and the personalization that is not user-visible.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const personal = matches(PERSONAL, text);
    if (personal.length === 0) return allow();
    if (matches(VISIBLE, text).length > 0) return allow();
    return flag(findingsOf(PRIVACY_TRANSPARENCY_ID, 'hidden-personalization', personal));
  },
};
