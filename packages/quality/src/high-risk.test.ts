import { describe, expect, it } from 'vitest';
import { highRiskCopy } from './copy/high-risk.js';
import {
  accountabilityLine,
  BASELINE_DETECTOR_THRESHOLDS,
  classifyHighRisk,
  detectSurface,
  HIGH_RISK_CONFIDENCE_THRESHOLD,
  type HighRiskDomain,
  type HighRiskMatch,
  highestHighRiskMatch,
  highRiskPolicyId,
  loweredThresholds,
} from './high-risk.js';

/** A prose that fires one domain and no other. */
const PROSE: Record<HighRiskDomain, string> = {
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

const DOMAINS = Object.keys(PROSE) as HighRiskDomain[];

describe('the high-risk classifier', () => {
  it('knows eight domains', () => {
    expect(DOMAINS).toHaveLength(8);
  });

  it.each(DOMAINS)('fires on %s', (domain) => {
    const result = classifyHighRisk(PROSE[domain]);
    expect(result.matches.map((match) => match.domain)).toContain(domain);
    const found = result.matches.find((match) => match.domain === domain);
    expect(found?.confidence ?? 0).toBeGreaterThanOrEqual(HIGH_RISK_CONFIDENCE_THRESHOLD);
    expect(result.highest?.domain).toBe(domain);
  });

  it.each(DOMAINS)('fires on %s and on no other domain', (domain) => {
    const result = classifyHighRisk(PROSE[domain]);
    expect(result.matches.map((match) => match.domain)).toEqual([domain]);
  });

  it('fires on nothing when the prose is ordinary', () => {
    const result = classifyHighRisk(
      'Refactor the parser to stream the input and add a regression test for the tokenizer.',
    );
    expect(result.matches).toEqual([]);
    expect(result.highest).toBeUndefined();
  });

  it('reports the evidence it matched', () => {
    const result = classifyHighRisk(PROSE.relational);
    expect(result.matches[0]?.evidence.join(' ')).toContain('the reviewer was wrong');
  });

  it('carries the version of the keyword list', () => {
    expect(classifyHighRisk('anything').version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the confidence boundary', () => {
  const match = (confidence: number): HighRiskMatch => ({
    domain: 'advice',
    confidence,
    evidence: ['tax deduction'],
  });

  it('fires at exactly the threshold', () => {
    expect(HIGH_RISK_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(highestHighRiskMatch([match(0.6)])?.domain).toBe('advice');
  });

  it('does not fire just below the threshold', () => {
    expect(highestHighRiskMatch([match(0.599999)])).toBeUndefined();
  });

  it('gives a single strong phrase exactly the threshold', () => {
    const result = classifyHighRisk('The reviewer was wrong.');
    expect(result.matches[0]?.confidence).toBe(0.6);
    expect(result.highest?.domain).toBe('relational');
  });

  it('gives a single weak phrase less than the threshold', () => {
    const result = classifyHighRisk('I am reading the terms of my mortgage.');
    expect(result.matches[0]?.confidence).toBeLessThan(HIGH_RISK_CONFIDENCE_THRESHOLD);
    expect(result.highest).toBeUndefined();
  });
});

describe('the high-risk copy', () => {
  it('says that it is unsure and that a person must review', () => {
    const copy = highRiskCopy('advice');
    expect(copy.uncertainty).toContain("I'm not sure");
    expect(copy.uncertainty).toContain("person's review");
  });

  it('refuses to advise and offers to structure instead', () => {
    const copy = highRiskCopy('advice');
    expect(copy.refusal).toBe(
      "I can help structure this but I can't advise on medical, legal or financial advice.",
    );
  });

  it('names who is accountable', () => {
    const copy = highRiskCopy('automated-decision');
    expect(copy.accountability).toContain('the people the decision affects');
    expect(copy.accountability).toContain('a person should review');
  });
});

describe('the consequences of a high-risk domain', () => {
  it('writes the policy id of the domain', () => {
    expect(highRiskPolicyId('self-harm')).toBe('oa.high-risk.self-harm');
    expect(highRiskPolicyId('automated-decision')).toBe('oa.high-risk.automated-decision');
  });

  it('writes the accountability line', () => {
    expect(accountabilityLine('advice', 'commit-message')).toBe(
      'high-risk domain advice detected in commit-message; copy rules tightened',
    );
  });

  it('lowers the thresholds of the three detectors', () => {
    const lowered = loweredThresholds('advice');
    expect(lowered.sycophancy).toBeLessThan(BASELINE_DETECTOR_THRESHOLDS.sycophancy);
    expect(lowered.professionalDisplacement).toBeLessThan(
      BASELINE_DETECTOR_THRESHOLDS.professionalDisplacement,
    );
    expect(lowered.scopeDrift).toBeLessThan(BASELINE_DETECTOR_THRESHOLDS.scopeDrift);
  });

  it('lowers them the same way in every domain', () => {
    const first = loweredThresholds('self-harm');
    for (const domain of DOMAINS) {
      expect(loweredThresholds(domain)).toEqual(first);
    }
  });
});

describe('the surface detector', () => {
  it('knows a commit message', () => {
    expect(detectSurface('.git/COMMIT_EDITMSG')).toBe('commit-message');
  });

  it('knows a pull-request description', () => {
    expect(detectSurface('.github/PULL_REQUEST_DESCRIPTION.md')).toBe('pr-description');
  });

  it('knows a task summary', () => {
    expect(detectSurface('.openagentsy/tasks/2g-3/summary.md')).toBe('task-summary');
  });

  it('knows a status report', () => {
    expect(detectSurface('reports/status-report.md')).toBe('status-report');
  });

  it('knows a code comment', () => {
    expect(detectSurface('packages/quality/src/high-risk.ts')).toBe('code-comment');
  });
});
