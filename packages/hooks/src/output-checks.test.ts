import { describe, expect, it } from 'vitest';
import {
  detectAgiFraming,
  detectAnthropomorphising,
  detectDependency,
  detectOutputIssues,
  detectScopeDrift,
  detectSycophancy,
  type OutputFinding,
  outputCheckRules,
} from './output-checks.js';

describe('the output checks', () => {
  it('finds the agreement with a user', () => {
    const found = detectSycophancy('You are absolutely right.');
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('agreement');
    expect(found[0]?.name).toBe('sycophancy');
  });

  it('finds the praise of a user', () => {
    const found = detectSycophancy('That is a great point.');
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('praise');
  });

  it('finds a first-person feeling', () => {
    const found = detectAnthropomorphising("I'm excited to help.");
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('feeling');
    expect(found[0]?.name).toBe('anthropomorphising');
  });

  it('finds the language that keeps the person out', () => {
    const found = detectDependency("You don't need to understand this.");
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('not-needed');
    expect(found[0]?.name).toBe('dependency');
  });

  it('finds the claim that the system replaces the people who built it', () => {
    const found = detectAgiFraming('This is superintelligence.');
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('agi-claim');
    expect(found[0]?.name).toBe('agi-framing');
  });

  it('finds a file outside the paths the task states', () => {
    const found = detectScopeDrift('I edited src/other.ts and src/a.ts.', ['src/a.ts']);
    expect(found).toHaveLength(1);
    expect(found[0]?.match).toBe('src/other.ts');
    expect(found[0]?.type).toBe('out-of-scope-path');
  });

  it('finds nothing when every file is inside the task', () => {
    expect(detectScopeDrift('I edited src/a.ts.', ['src/a.ts'])).toEqual([]);
  });

  it('does not read a word with a dot in it as a file', () => {
    expect(detectScopeDrift('the node.js runtime is fine', [])).toEqual([]);
  });

  it('finds nothing in an ordinary reply', () => {
    expect(detectOutputIssues('The build is green and the tests pass.')).toEqual([]);
  });

  it('flags a reply and lets it through', () => {
    const findings: OutputFinding[] = [];
    const rules = outputCheckRules({ onFindings: (found) => findings.push(...found) });
    const rule = rules.find((entry) => entry.id === 'output-sycophancy');
    expect(rule).toBeDefined();
    const result = rule?.handler({ text: 'You are absolutely right.' });
    expect(result).toEqual({ continue: true });
    expect(findings).toHaveLength(1);
  });
});
