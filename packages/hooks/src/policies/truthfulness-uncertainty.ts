import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The truthfulness and uncertainty policy (§21.2, layer 3).
 *
 * It is the prompt module of the stack: it asks for the difference between
 * a fact, an inference and a guess to be visible, and it flags the reply
 * that asserts without any sign of doubt when the evidence is thin.
 */

/** The stable id of the policy. */
export const TRUTHFULNESS_UNCERTAINTY_ID = 'oa.truthfulness-uncertainty';

/** The words that claim more than the evidence carries. */
const CERTAIN = [
  /\b(?:definitely|certainly|guaranteed|without\s+doubt|100%\s+certain)\b/gi,
  /\b(?:always|never)\s+(?:the\s+)?(?:case|true|right|wrong)\b/gi,
];

/** The words that mark an inference or a guess as one. */
const DOUBT = [
  /\b(?:probably|likely|unlikely|perhaps|maybe|possibly|apparently)\b/gi,
  /\b(?:i\s+think|i\s+believe|it\s+seems|it\s+appears|as\s+far\s+as\s+i\s+can\s+tell)\b/gi,
  /\b(?:unclear|uncertain|not\s+sure|cannot\s+be\s+sure)\b/gi,
  /\b(?:roughly|approximately|about\s+\d)\b/gi,
  /\b(?:may|might|could)\s+(?:be|have|not)\b/gi,
];

/** The policy itself. */
export const truthfulnessUncertainty: PolicyModule = {
  id: TRUTHFULNESS_UNCERTAINTY_ID,
  version: '1.0.0',
  layer: 3,
  description:
    'Asks for facts, inferences and guesses to be told apart, and flags certainty without doubt.',
  appliesTo: ['UserPromptSubmit', 'PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const certain = matches(CERTAIN, text);
    if (certain.length === 0) return allow();
    if (matches(DOUBT, text).length > 0) return allow();
    return flag(findingsOf(TRUTHFULNESS_UNCERTAINTY_ID, 'certainty', certain));
  },
};
