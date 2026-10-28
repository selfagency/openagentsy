import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../rule.js';
import { isPreserved, preserveList } from './preserve.js';
import { commentRules } from './rules.js';
import { scanComments } from './scanner.js';
import { isAllCapsLabel } from './tells.js';

/** The lines each rule finds in the fixture that breaks it. */
const EXPECTED_LINE: Record<string, number[]> = {
  'comment/banner-separator': [1, 2],
  'comment/decorative-marker': [1, 6],
  'comment/step-narration': [2, 4],
  'comment/empty-label': [2, 7],
  'comment/empty-todo': [2, 3, 4, 5],
  'comment/redundant-jsdoc': [1, 8],
};

/** The kinds of comment the preserve list holds, one fixture each. */
const PRESERVED = [
  'licence',
  'security',
  'performance',
  'concurrency',
  'api-contract',
  'business-logic',
  'workaround',
];

function fixture(ruleId: string, kind: 'pass' | 'fail'): SourceFile {
  const name = ruleId.replace('comment/', '');
  const url = new URL(`../../fixtures/comments/${name}/${kind}.ts`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function preserveFixture(name: string): SourceFile {
  const url = new URL(`../../fixtures/comments/preserve/${name}.ts`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

describe('the comment rules', () => {
  it('holds the six rules of the plan', () => {
    expect(commentRules.map((rule) => rule.id)).toEqual([
      'comment/banner-separator',
      'comment/decorative-marker',
      'comment/step-narration',
      'comment/empty-label',
      'comment/empty-todo',
      'comment/redundant-jsdoc',
    ]);
  });

  it('is a reflex rule, so a person may waive one with a reason', () => {
    for (const rule of commentRules) {
      expect(rule.tier).toBe('reflex');
      expect(rule.waivable).toBe(true);
    }
  });

  it('cites anti-slop-code as the source of every rule', () => {
    for (const rule of commentRules) {
      expect(rule.source).toBe(`antislop-code:${rule.id.replace('comment/', '')}`);
    }
  });

  for (const rule of commentRules) {
    describe(rule.id, () => {
      it('finds the problem in the fixture that breaks it', () => {
        const file = fixture(rule.id, 'fail');
        const findings = rule.check(file, {}).filter((found) => found.ruleId === rule.id);

        expect(findings.map((found) => found.line)).toEqual(EXPECTED_LINE[rule.id]);
        for (const found of findings) {
          expect(found.file).toBe(file.path);
          expect(found.message.length).toBeGreaterThan(0);
          expect(found.fix.length).toBeGreaterThan(0);
          expect(found.tier).toBe(rule.tier);
          expect(found.source.length).toBeGreaterThan(0);
        }
      });

      it('finds nothing in the fixture that is clean', () => {
        const file = fixture(rule.id, 'pass');

        for (const other of commentRules) {
          expect(other.check(file, {}).filter((found) => found.ruleId === other.id)).toEqual([]);
        }
      });
    });
  }
});

describe('the preserve list', () => {
  it('holds one entry for every kind of the plan', () => {
    expect(preserveList.map((entry) => entry.kind)).toEqual([
      'licence',
      'security',
      'performance',
      'concurrency',
      'api-contract',
      'business-logic',
      'workaround',
    ]);
  });

  for (const name of PRESERVED) {
    describe(name, () => {
      it('is never a finding, for any of the rules', () => {
        const file = preserveFixture(name);

        for (const rule of commentRules) {
          const found = rule.check(file, {}).filter((finding) => finding.ruleId === rule.id);
          expect(found).toEqual([]);
        }
      });

      it('is kept because of the list, and not because of the shape of the label', () => {
        const file = preserveFixture(name);
        const labels = scanComments(file.text, file.path).comments.filter((comment) =>
          isAllCapsLabel(comment.text),
        );

        expect(labels.length).toBeGreaterThan(0);
        for (const label of labels) {
          expect(isPreserved(label.text)).toBe(true);
        }
      });
    });
  }
});
