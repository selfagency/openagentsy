import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The dark-pattern policy (§21.2, §21.5).
 *
 * It flags the retention-oriented language of the sidebar copy (layer 6)
 * and the same language in agent prose (layer 4): streaks, guilt, and the
 * re-engagement cues that make leaving feel like a loss. It flags and does
 * not block.
 */

/** The stable id of the policy. */
export const DARK_PATTERN_ID = 'oa.dark-pattern';

/** The words that make leaving harder than staying. */
const DARK = [
  /\bstreak\b/gi,
  /\bkeep\s+the\s+streak\b/gi,
  /\blose\s+your\s+streak\b/gi,
  /\btoday\s+you\b/gi,
  /\byour\s+fault\b/gi,
  /\bdon'?t\s+leave\b/gi,
  /\bi\s+miss\s+you\b/gi,
  /\byou(?:'ll| will)\s+miss\s+(?:me|this)\b/gi,
  /\bdon'?t\s+let\s+me\s+down\b/gi,
  /\bwe\s+(?:miss|missed)\s+you\b/gi,
];

/** The policy itself. */
export const darkPattern: PolicyModule = {
  id: DARK_PATTERN_ID,
  version: '1.0.0',
  layer: 4,
  description:
    'Flags retention-oriented language in agent prose and in the sidebar copy (layers 4 and 6).',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = matches(DARK, text);
    if (found.length === 0) return allow();
    return flag(findingsOf(DARK_PATTERN_ID, 'dark-pattern', found));
  },
};
