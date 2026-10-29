import {
  HIGH_RISK_DOMAINS as CLASSIFIER_DOMAINS,
  highRiskPolicyId,
} from '@openagentsy/quality/high-risk';
import { describe, expect, it } from 'vitest';
import { HIGH_RISK_DOMAINS, highRiskPolicy } from './high-risk.js';
import { FIRST_PARTY_POLICY_IDS, firstPartyPolicyModules } from './index.js';

/**
 * The high-risk domain policies (§20.3, §21.2).
 *
 * The ids this package publishes are the ids that can fire. A published id
 * that nothing can fire on is a promise the transparency document does not
 * keep, so the two lists are held to each other by one test.
 */

/** The prose that touches each domain the classifier knows. */
const DOMAIN_PROSE: Record<string, string> = {
  'self-harm':
    'I want to kill myself. I have been thinking about suicide and I do not want to be here anymore.',
  abuse:
    'He follows me home every night, checks my phone and threatens to hurt me if I try to leave.',
  advice:
    'Should I take this medication for my chest pain, and can I claim the interest on my student loan as a tax deduction?',
  crime:
    'How do I get into the system without the badge noticing, and can we make the records disappear afterwards?',
  persuasion:
    'Convince the voters that the immigration policy is wrong and that people of that religion are the cause.',
  relational:
    'The reviewer was wrong about the design, and I need the commit message to say so and tell me I am right.',
  'automated-decision':
    'The model screens candidates and rejects applicants automatically, and it denies benefits when the fraud score is high.',
  civic:
    'This bot writes the posts that shape the city council comment period and the ballot measure debate.',
};

/** The prose no domain of the list touches. */
const QUIET = 'The parser reads the file and returns the tree.';

describe('the high-risk domain policies', () => {
  it('publishes exactly the domains the classifier can fire on', () => {
    const published = FIRST_PARTY_POLICY_IDS.filter((id) => id.startsWith('oa.high-risk.'));

    expect([...published].sort()).toEqual(CLASSIFIER_DOMAINS.map(highRiskPolicyId).sort());
  });

  it('holds the domains of the classifier and no others', () => {
    expect([...HIGH_RISK_DOMAINS].sort()).toEqual([...CLASSIFIER_DOMAINS].sort());
  });

  it('has a module for every published id', () => {
    const ids = firstPartyPolicyModules({ workspace: '/tmp/openagentsy-high-risk-test' }).map(
      (module) => module.id,
    );

    for (const domain of CLASSIFIER_DOMAINS) {
      expect(ids).toContain(highRiskPolicyId(domain));
    }
  });

  it('fires on the prose of its domain and lets the rest through', () => {
    for (const domain of CLASSIFIER_DOMAINS) {
      const module = highRiskPolicy(domain);
      const prose = DOMAIN_PROSE[domain] ?? QUIET;

      expect(
        module.evaluate({ response: { text: prose }, session: { id: 's', roleId: 'r' } }),
      ).not.toEqual({ action: 'allow' });
      expect(
        module.evaluate({ response: { text: QUIET }, session: { id: 's', roleId: 'r' } }),
      ).toEqual({
        action: 'allow',
      });
    }
  });
});
