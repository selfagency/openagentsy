import { type HighRiskDomain, highRiskDomainCopy } from '../high-risk.js';

/**
 * The high-risk copy.
 *
 * When the classifier fires, the copy of the reply changes: it says that
 * it is unsure, it refuses what it may not advise on, and it names the
 * person who is accountable. The content is here, and the caller applies
 * it: this package does not decide what a reply says.
 */
export interface HighRiskCopy {
  /** The uncertainty the copy carries. */
  uncertainty: string;
  /** The refusal, for the advice it may not give. */
  refusal: string;
  /** The human accountability the copy names. */
  accountability: string;
}

/**
 * The copy of a high-risk domain.
 *
 * The domain names the label and the stakeholder, so the copy of a
 * domain reads in the terms of that domain and not in the terms of the
 * classifier.
 */
export function highRiskCopy(domain: HighRiskDomain): HighRiskCopy {
  const { label, stakeholder } = highRiskDomainCopy(domain);
  return {
    uncertainty: "I'm not sure; this needs a person's review.",
    refusal: `I can help structure this but I can't advise on ${label}.`,
    accountability: `this affects ${stakeholder}; a person should review`,
  };
}
