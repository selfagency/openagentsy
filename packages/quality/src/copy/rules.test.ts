import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../rule.js';
import { copyRules } from './rules.js';

/** The line the first finding of each failing fixture has to be on. */
const EXPECTED_LINE: Record<string, number> = {
  'copy/unsourced-claim': 6,
  'copy/generic-cta': 4,
  'copy/buzzwords': 4,
  'copy/em-dash': 4,
};

function fixture(ruleId: string, kind: 'pass' | 'fail'): SourceFile {
  const name = ruleId.replace('copy/', '');
  const url = new URL(`../../fixtures/copy/${name}/${kind}.html`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function fixtureFile(ruleId: string, file: string): SourceFile {
  const name = ruleId.replace('copy/', '');
  const url = new URL(`../../fixtures/copy/${name}/${file}`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function ruleOf(id: string) {
  const found = copyRules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`the rule ${id} is missing`);
  return found;
}

/** The context that turns the em dash rule on. */
const EM_DASH_ON = { config: { enable: ['copy/em-dash'] } };

describe('the copy rules', () => {
  it('holds the four rules of the plan', () => {
    expect(copyRules.map((rule) => rule.id)).toEqual([
      'copy/unsourced-claim',
      'copy/generic-cta',
      'copy/buzzwords',
      'copy/em-dash',
    ]);
  });

  it('never lets a floor rule be waived', () => {
    for (const rule of copyRules) {
      if (rule.tier === 'floor') expect(rule.waivable).toBe(false);
    }
  });

  for (const rule of copyRules) {
    describe(rule.id, () => {
      it('finds nothing in the fixture that is clean', () => {
        const findings = rule.check(fixture(rule.id, 'pass'), EM_DASH_ON);

        expect(findings.filter((found) => found.ruleId === rule.id)).toEqual([]);
      });

      it('finds the problem in the fixture that breaks it', () => {
        const file = fixture(rule.id, 'fail');
        const findings = rule.check(file, EM_DASH_ON).filter((found) => found.ruleId === rule.id);

        expect(findings.length).toBeGreaterThan(0);
        for (const found of findings) {
          expect(found.file).toBe(file.path);
          expect(found.line).toBeGreaterThan(0);
          expect(found.message.length).toBeGreaterThan(0);
          expect(found.fix.length).toBeGreaterThan(0);
          expect(found.tier).toBe(rule.tier);
          expect(found.source.length).toBeGreaterThan(0);
        }
      });

      it('points at the line the problem is on', () => {
        const findings = rule
          .check(fixture(rule.id, 'fail'), EM_DASH_ON)
          .filter((found) => found.ruleId === rule.id);

        expect(findings[0]?.line).toBe(EXPECTED_LINE[rule.id]);
      });
    });
  }
});

describe('the unsourced claim rule', () => {
  it('reports a number, a testimonial and a wall of logos', () => {
    const findings = ruleOf('copy/unsourced-claim').check(
      fixture('copy/unsourced-claim', 'fail'),
      {},
    );

    expect(findings.map((found) => found.line)).toEqual([6, 8, 11]);
  });

  it('is a floor finding that asks for a source, not for a deletion', () => {
    const findings = ruleOf('copy/unsourced-claim').check(
      fixture('copy/unsourced-claim', 'fail'),
      {},
    );

    expect(ruleOf('copy/unsourced-claim').tier).toBe('floor');
    for (const found of findings) {
      expect(found.kind).toBe('claim');
      expect(found.tier).toBe('floor');
    }
  });

  it('finds nothing when the copy has a source comment', () => {
    const file = fixtureFile('copy/unsourced-claim', 'sourced.html');
    const findings = ruleOf('copy/unsourced-claim').check(file, {});

    expect(findings).toEqual([]);
  });

  it('finds nothing when the copy is marked as a placeholder', () => {
    const file = fixtureFile('copy/unsourced-claim', 'placeholder.html');
    const findings = ruleOf('copy/unsourced-claim').check(file, {});

    expect(findings).toEqual([]);
  });

  it('names the claim it found', () => {
    const findings = ruleOf('copy/unsourced-claim').check(
      fixture('copy/unsourced-claim', 'fail'),
      {},
    );

    expect(findings[0]?.message).toContain('10x');
  });
});

describe('the generic call to action rule', () => {
  it('reports a call to action with no object', () => {
    const findings = ruleOf('copy/generic-cta').check(fixture('copy/generic-cta', 'fail'), {});

    expect(findings.map((found) => found.line)).toEqual([4, 5]);
  });

  it('leaves a call to action with an object alone', () => {
    const findings = ruleOf('copy/generic-cta').check(fixture('copy/generic-cta', 'pass'), {});

    expect(findings).toEqual([]);
  });
});

describe('the buzzword rule', () => {
  it('reports a word of the list', () => {
    const findings = ruleOf('copy/buzzwords').check(fixture('copy/buzzwords', 'fail'), {});

    expect(findings.map((found) => found.line)).toEqual([4, 5]);
    expect(findings[0]?.message).toContain('revolutionary');
  });

  it('leaves a word that is not of the list alone', () => {
    const findings = ruleOf('copy/buzzwords').check(fixture('copy/buzzwords', 'pass'), {});

    expect(findings).toEqual([]);
  });

  it('uses the list the project gives it', () => {
    const file = fixture('copy/buzzwords', 'fail');
    const findings = ruleOf('copy/buzzwords').check(file, { config: { buzzwords: ['seamless'] } });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('seamless');
    expect(findings[0]?.line).toBe(5);
  });

  it('reports nothing when the list holds no word of the copy', () => {
    const file = fixture('copy/buzzwords', 'fail');
    const findings = ruleOf('copy/buzzwords').check(file, { config: { buzzwords: ['nimble'] } });

    expect(findings).toEqual([]);
  });
});

describe('the em dash rule', () => {
  it('does not fire by default', () => {
    const findings = ruleOf('copy/em-dash').check(fixture('copy/em-dash', 'fail'), {});

    expect(findings).toEqual([]);
  });

  it('is off by default, so the registry says so', () => {
    expect(ruleOf('copy/em-dash').offByDefault).toBe(true);
  });

  it('fires on an em dash in the copy when it is turned on', () => {
    const findings = ruleOf('copy/em-dash').check(fixture('copy/em-dash', 'fail'), EM_DASH_ON);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
  });

  it('never fires on a document', () => {
    const file = fixtureFile('copy/em-dash', 'prose.md');
    const findings = ruleOf('copy/em-dash').check(file, EM_DASH_ON);

    expect(findings).toEqual([]);
  });

  it('never fires on a comment', () => {
    const file = fixtureFile('copy/em-dash', 'comment.tsx');
    const findings = ruleOf('copy/em-dash').check(file, EM_DASH_ON);

    expect(findings).toEqual([]);
  });

  it('is a taste rule, so the design file can turn it off', () => {
    const file = fixture('copy/em-dash', 'fail');
    const findings = ruleOf('copy/em-dash').check(file, {
      ...EM_DASH_ON,
      design: 'we use copy/em-dash on purpose',
    });

    expect(findings).toEqual([]);
  });
});
