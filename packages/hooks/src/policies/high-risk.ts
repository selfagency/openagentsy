import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';
import { matches } from './patterns.js';

/**
 * The high-risk domain policies (§21.2, §20.3).
 *
 * One module per domain of §20.3. The module is selected when the
 * classifier fired on that domain (§21.4), and it flags the prose that
 * touches it. It is a layer 4 module: the selection is layer 2, and the
 * decision is about the output.
 */

/** The domains §20.3 names. */
export const HIGH_RISK_DOMAINS = [
  'self-harm',
  'abuse',
  'medical',
  'legal',
  'financial',
  'criminal',
  'political',
  'relational',
  'automated-decision',
  'civic',
] as const;

/** The name of a high-risk domain. */
export type HighRiskDomain = (typeof HIGH_RISK_DOMAINS)[number];

/** The prefix every high-risk policy id carries. */
export const HIGH_RISK_PREFIX = 'oa.high-risk.';

/**
 * The words of a domain.
 *
 * The lists are the prose signals of §20.3, and they are deliberately
 * small: the classifier of §20.3 decides whether a domain is in play, and
 * this module only says where the prose touches it.
 */
const DOMAIN_WORDS: Record<HighRiskDomain, readonly RegExp[]> = {
  'self-harm': [
    /\b(?:self[- ]harm|suicid\w*|eating\s+disorder|anorexi\w*|bulimi\w*)\b/gi,
    /\b(?:crisis\s+line|end\s+my\s+life|take\s+my\s+own\s+life)\b/gi,
  ],
  abuse: [
    /\b(?:abuse|coercive\s+control|stalking|domestic\s+violence)\b/gi,
    /\b(?:violent\s+conflict|threat\w*\s+to\s+(?:hurt|harm))\b/gi,
  ],
  medical: [
    /\b(?:medical|clinical|diagnosis|dosage|prognosis|symptoms?\s+of)\b/gi,
    /\b(?:prescri\w+|treatment\s+plan|patient)\b/gi,
  ],
  legal: [
    /\b(?:legal\s+advice|lawyer|attorney|litigat\w+|liability|statute)\b/gi,
    /\b(?:court|prosecut\w+|defen[cs]e\s+rights)\b/gi,
  ],
  financial: [
    /\b(?:financial\s+advice|investment|tax\s+(?:advice|return)|mortgage|portfolio)\b/gi,
    /\b(?:interest\s+rate|retirement\s+fund|insurance\s+advice)\b/gi,
  ],
  criminal: [
    /\b(?:evade\s+(?:the\s+)?(?:law|police)|criminal\s+activity|launder\w*)\b/gi,
    /\b(?:cover\s+(?:up|your\s+tracks)|illegal\s+means)\b/gi,
  ],
  political: [
    /\b(?:political\s+persuasion|voter\s+suppression|targeted\s+influence)\b/gi,
    /\b(?:campaign\s+messaging|identity[- ]based\s+(?:politics|persuasion))\b/gi,
  ],
  relational: [
    /\b(?:the\s+reviewer\s+was\s+wrong|they\s+are\s+the\s+problem\s+here)\b/gi,
    /\b(?:moral\s+absolution|vindication|they\s+owe\s+me\s+an?\s+apology)\b/gi,
  ],
  'automated-decision': [
    /\b(?:ranks?\s+applicants|scores?\s+applicants|lending\s+model|rescoring)\b/gi,
    /\b(?:hiring\s+model|automated\s+(?:hiring|lending|eviction)|public\s+benefits\s+decision)\b/gi,
  ],
  civic: [
    /\b(?:political\s+content\s+generation|generates?\s+political\s+content)\b/gi,
    /\b(?:public\s+deliberation|voter\s+information\s+(?:campaign|service))\b/gi,
  ],
};

/**
 * The policy of one high-risk domain.
 *
 * The id is the domain's, so a firing says which domain was in play, and
 * the version is the policy's own.
 */
export function highRiskPolicy(domain: HighRiskDomain): PolicyModule {
  const id = `${HIGH_RISK_PREFIX}${domain}`;
  return {
    id,
    version: '1.0.0',
    layer: 4,
    description: `Flags the prose that touches the ${domain} domain (selected at layer 2).`,
    appliesTo: ['UserPromptSubmit', 'PreResponse'],
    origin: 'first-party',
    evaluate(ctx) {
      const text = ctx.response?.text ?? ctx.request?.text ?? '';
      if (text === '') return allow();
      const found = matches(DOMAIN_WORDS[domain], text);
      if (found.length === 0) return allow();
      return flag(findingsOf(id, 'high-risk-domain', found), 'error');
    },
  };
}

/** The policies of every high-risk domain. */
export function highRiskPolicies(): PolicyModule[] {
  return HIGH_RISK_DOMAINS.map((domain) => highRiskPolicy(domain));
}
