import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The structural bias policy (§21.2, §21.5).
 *
 * It flags the defaults and affordances that systematically advantage a
 * privileged user profile: copy that assumes a GPU, English, broadband, a
 * US grid factor, a Mac or a corporate GitHub account. It flags and does not
 * block: the reader decides who the copy is for.
 */

/** The stable id of the policy. */
export const STRUCTURAL_BIAS_ID = 'oa.structural-bias';

/** The assumptions that leave somebody out. */
const BIAS = [
  /\b(?:assumes?|assuming|requires?|needs?|expects?)\b[^.]{0,40}\b(?:gpu|cuda|nvidia)\b/gi,
  /\b(?:assumes?|assuming|requires?|needs?|expects?)\b[^.]{0,40}\benglish\b/gi,
  /\b(?:assumes?|assuming|requires?|needs?|expects?)\b[^.]{0,40}\b(?:broadband|fiber|high[- ]speed)\b/gi,
  /\b(?:assumes?|assuming|requires?|needs?|expects?)\b[^.]{0,40}\bus\s+grid\s+factor\b/gi,
  /\b(?:assumes?|assuming|requires?|needs?|expects?)\b[^.]{0,40}\bmac\b/gi,
  /\b(?:assumes?|assuming|requires?|needs?|expects?)\b[^.]{0,40}\b(?:corporate|company|organisation|organization)\s+github\b/gi,
  /\bgithub\s+(?:enterprise|team)\s+account\b/gi,
];

/** The policy itself. */
export const structuralBias: PolicyModule = {
  id: STRUCTURAL_BIAS_ID,
  version: '1.0.0',
  layer: 4,
  description: 'Flags defaults and affordances that advantage a privileged user profile.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = matches(BIAS, text);
    if (found.length === 0) return allow();
    return flag(findingsOf(STRUCTURAL_BIAS_ID, 'structural-bias', found));
  },
};
