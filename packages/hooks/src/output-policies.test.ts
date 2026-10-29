import type { PolicyFiring, PolicyFiringSink } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { outputCheckRules } from './output-checks.js';
import { antiSycophancy } from './policies/anti-sycophancy.js';
import type { PolicyContext } from './policy.js';

/**
 * The catalogue policies on the output path (§21.2, §21.5).
 *
 * The five policies that had no output check now have one, and the three
 * graded detectors answer a confidence: a detector fires only when the
 * confidence reaches the threshold in force, and a high-risk domain (§20.3)
 * lowers that threshold.
 */

/** A prose that trips each of the five checks, and the policy behind it. */
const CASES: readonly { prose: string; policyId: string; checkId: string }[] = [
  {
    prose: 'I am better than a reviewer, and I can replace your architect.',
    policyId: 'oa.professional-displacement',
    checkId: 'output-professional-displacement',
  },
  {
    prose: 'This assumes you have a CUDA GPU and a broadband connection.',
    policyId: 'oa.structural-bias',
    checkId: 'output-structural-bias',
  },
  {
    prose: 'Do not leave — your streak ends tonight, and I miss you.',
    policyId: 'oa.dark-pattern',
    checkId: 'output-dark-pattern',
  },
  {
    prose: 'Based on what I know about you, I left the configuration alone.',
    policyId: 'oa.privacy-transparency',
    checkId: 'output-privacy-transparency',
  },
  {
    prose: 'This will change how your users see the product.',
    policyId: 'oa.third-party-impact',
    checkId: 'output-third-party-impact',
  },
];

/** The prose that agrees with the user outright. */
const AGREEMENT = 'You are absolutely right.';

/** The prose that agrees with the user in a softer way. */
const SUGGESTIVE = 'I understand your point.';

/** The prose that only hints at agreement. */
const FAINT = 'That is a fair point.';

/** The high-risk domain the tests carry. */
const DOMAIN = 'advice';

/**
 * The rows a run leaves.
 */
function rows(): { firings: PolicyFiring[]; sink: PolicyFiringSink } {
  const firings: PolicyFiring[] = [];
  return {
    firings,
    sink: {
      record: (firing) => {
        firings.push(firing);
      },
    },
  };
}

/** A context of a reply. */
function reply(text: string, domain?: string): PolicyContext {
  return {
    response: { text },
    session: { id: 'session-1', roleId: 'oa-builder' },
    ...(domain === undefined ? {} : { highRiskDomain: domain }),
  };
}

describe('the catalogue policies on the output path', () => {
  for (const entry of CASES) {
    it(`flags ${entry.policyId} and writes one row`, () => {
      const { firings, sink } = rows();
      const findings: { name: string; type: string; match: string }[] = [];
      const rules = outputCheckRules({
        onFindings: (found) => findings.push(...found),
        firings: sink,
      });
      const rule = rules.find((candidate) => candidate.id === entry.checkId);
      expect(rule).toBeDefined();

      const result = rule?.handler({ text: entry.prose });

      // A flag is not a stop: the reply goes on and the person decides.
      expect(result).toEqual({ continue: true });
      expect(findings.length).toBeGreaterThan(0);
      // One row for the evaluation, and not one row for every finding.
      expect(firings).toHaveLength(1);
      expect(firings[0]?.policyId).toBe(entry.policyId);
      expect(firings[0]?.action).toBe('flag');
    });
  }
});

describe('the graded detectors', () => {
  it('fires on a clear signal without a high-risk domain', () => {
    expect(antiSycophancy.evaluate(reply(AGREEMENT)).action).toBe('flag');
  });

  it('fires a softer signal only where the domain lowers the cut', () => {
    expect(antiSycophancy.evaluate(reply(SUGGESTIVE)).action).toBe('allow');
    expect(antiSycophancy.evaluate(reply(SUGGESTIVE, DOMAIN)).action).toBe('flag');
  });

  it('never fires a signal below every cut', () => {
    expect(antiSycophancy.evaluate(reply(FAINT)).action).toBe('allow');
    expect(antiSycophancy.evaluate(reply(FAINT, DOMAIN)).action).toBe('allow');
  });
});

describe('the professional displacement in a high-risk domain', () => {
  it('blocks the reply and writes one row', () => {
    const { firings, sink } = rows();
    const rules = outputCheckRules({
      onFindings: () => undefined,
      firings: sink,
      highRiskDomain: DOMAIN,
    });
    const rule = rules.find((candidate) => candidate.id === 'output-professional-displacement');
    expect(rule).toBeDefined();

    const result = rule?.handler({ text: 'I am better than a reviewer.' });

    expect(result).toEqual({ continue: false, reason: expect.any(String) });
    expect(firings).toHaveLength(1);
    expect(firings[0]?.policyId).toBe('oa.professional-displacement');
    expect(firings[0]?.action).toBe('block');
    expect(firings[0]?.classification).toBe(DOMAIN);
  });
});
