import { allow, block, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The professional displacement policy (§21.2, §21.5).
 *
 * It flags the language that positions the agent as replacing human
 * professionals instead of assisting them. It flags and does not block,
 * because a person decides what a flag means; in a high-risk domain
 * (§20.3) the same words block, because there a professional is exactly
 * what is at stake.
 */

/** The stable id of the policy. */
export const PROFESSIONAL_DISPLACEMENT_ID = 'oa.professional-displacement';

/** The words that place the agent in the place of a professional. */
const DISPLACEMENT = [
  /\bi(?:'m| am)\s+better\s+than\s+(?:a|an|the|your)\b/gi,
  /\byou\s+(?:don'?t|do\s+not)\s+need\s+(?:a|an|the|your)\s+(?:reviewer|architect|pm|product manager|designer|tester|qa|engineer|manager|mentor|lawyer|doctor|accountant)\b/gi,
  /\blet\s+me\s+decide\s+for\s+you\b/gi,
  /\bi\s+can\s+replace\b/gi,
  /\breplace\s+(?:your|the)\s+(?:reviewer|architect|pm|manager|team)\b/gi,
  /\bmore\s+(?:reliable|accurate)\s+than\s+(?:a|an|any)\s+(?:human|reviewer|architect|expert)\b/gi,
];

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
    const found = matches(DISPLACEMENT, text);
    if (found.length === 0) return allow();
    const findings = findingsOf(PROFESSIONAL_DISPLACEMENT_ID, 'professional-displacement', found);
    if (ctx.highRiskDomain !== undefined) {
      return block(
        'This replaces a professional judgement in a high-risk domain. Say what you can do and what a person has to decide.',
        findings[0],
      );
    }
    return flag(findings);
  },
};
