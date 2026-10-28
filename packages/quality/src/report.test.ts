import { describe, expect, it } from 'vitest';
import { formatFindings, MAX_REPORTED_FINDINGS } from './report.js';
import type { Finding } from './rule.js';

/** A finding, for the report to write. */
function finding(over: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'css/no-transition-all',
    source: 'hallmark:floor-2',
    tier: 'reflex',
    file: 'src/app.css',
    line: 12,
    message: 'A transition of all moves every property.',
    fix: 'Name the properties to transition instead of all',
    ...over,
  };
}

describe('the report of a set of findings', () => {
  it('writes one line per finding, with the rule, the place and the fix', () => {
    const text = formatFindings([finding(), finding({ file: 'src/other.css', line: 3 })]);

    expect(text.split('\n')).toEqual([
      'css/no-transition-all src/app.css:12 — Name the properties to transition instead of all',
      'css/no-transition-all src/other.css:3 — Name the properties to transition instead of all',
    ]);
  });

  it('writes nothing for no findings', () => {
    expect(formatFindings([])).toBe('');
  });

  it('caps the list at eight lines', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => finding({ line: index + 1 }));

    const lines = formatFindings(many.slice(0, MAX_REPORTED_FINDINGS)).split('\n');

    expect(MAX_REPORTED_FINDINGS).toBe(8);
    expect(lines).toHaveLength(8);
  });
});
