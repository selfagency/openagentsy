import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../rule.js';
import { htmlRules } from './rules.js';

/** The line the first finding of each failing fixture has to be on. */
const EXPECTED_LINE: Record<string, number> = {
  'html/dead-nav': 6,
  'html/inert-control': 4,
  'html/emoji-icon': 5,
  'html/card-in-card': 6,
};

function fixture(ruleId: string, kind: 'pass' | 'fail'): SourceFile {
  const name = ruleId.replace('html/', '');
  const url = new URL(`../../fixtures/html/${name}/${kind}.html`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function fixtureFile(ruleId: string, file: string): SourceFile {
  const name = ruleId.replace('html/', '');
  const url = new URL(`../../fixtures/html/${name}/${file}`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function ruleOf(id: string) {
  const found = htmlRules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`the rule ${id} is missing`);
  return found;
}

describe('the HTML rules', () => {
  it('holds the four rules of the plan', () => {
    expect(htmlRules.map((rule) => rule.id)).toEqual([
      'html/dead-nav',
      'html/inert-control',
      'html/emoji-icon',
      'html/card-in-card',
    ]);
  });

  it('never lets a floor rule be waived', () => {
    for (const rule of htmlRules) {
      if (rule.tier === 'floor') expect(rule.waivable).toBe(false);
    }
  });

  for (const rule of htmlRules) {
    describe(rule.id, () => {
      it('finds nothing in the fixture that is clean', () => {
        const findings = rule.check(fixture(rule.id, 'pass'), {});

        expect(findings.filter((found) => found.ruleId === rule.id)).toEqual([]);
      });

      it('finds the problem in the fixture that breaks it', () => {
        const file = fixture(rule.id, 'fail');
        const findings = rule.check(file, {}).filter((found) => found.ruleId === rule.id);

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
          .check(fixture(rule.id, 'fail'), {})
          .filter((found) => found.ruleId === rule.id);

        expect(findings[0]?.line).toBe(EXPECTED_LINE[rule.id]);
      });
    });
  }
});

describe('the dead nav rule', () => {
  it('reports a link to an anchor the file does not have', () => {
    const findings = ruleOf('html/dead-nav').check(fixture('html/dead-nav', 'fail'), {});

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('#missing');
    expect(findings[0]?.line).toBe(6);
  });

  it('reports nothing for a link to an anchor the file has', () => {
    const findings = ruleOf('html/dead-nav').check(fixture('html/dead-nav', 'pass'), {});

    expect(findings).toEqual([]);
  });

  it('reports a link to a route the project does not have', () => {
    const file = fixtureFile('html/dead-nav', 'route.html');
    const findings = ruleOf('html/dead-nav').check(file, { routes: ['/pricing'] });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('/nowhere');
    expect(findings[0]?.line).toBe(6);
  });

  it('says nothing about a route it cannot see', () => {
    const file = fixtureFile('html/dead-nav', 'route.html');
    const findings = ruleOf('html/dead-nav').check(file, {});

    expect(findings).toEqual([]);
  });
});

describe('the inert control rule', () => {
  it('reports a button with no handler', () => {
    const findings = ruleOf('html/inert-control').check(fixture('html/inert-control', 'fail'), {});

    expect(findings.map((found) => found.line)).toEqual([4, 5]);
    expect(findings[0]?.message).toContain('button');
  });

  it('reports a form with no action', () => {
    const findings = ruleOf('html/inert-control').check(fixture('html/inert-control', 'fail'), {});

    expect(findings[1]?.message).toContain('form');
  });

  it('reports nothing for a button with a handler', () => {
    const file = fixtureFile('html/inert-control', 'handler.html');
    const findings = ruleOf('html/inert-control').check(file, {});

    expect(findings).toEqual([]);
  });

  it('reports nothing for a form with a submit handler', () => {
    const file = fixtureFile('html/inert-control', 'handler.html');
    const findings = ruleOf('html/inert-control').check(file, {});

    expect(findings).toEqual([]);
  });
});

describe('the emoji icon rule', () => {
  it('reports an emoji that stands for an icon', () => {
    const findings = ruleOf('html/emoji-icon').check(fixture('html/emoji-icon', 'fail'), {});

    expect(findings.map((found) => found.line)).toEqual([5, 8]);
  });

  it('leaves an emoji in a sentence alone', () => {
    const findings = ruleOf('html/emoji-icon').check(fixture('html/emoji-icon', 'pass'), {});

    expect(findings).toEqual([]);
  });
});

describe('the card in card rule', () => {
  it('reports a card inside a card', () => {
    const findings = ruleOf('html/card-in-card').check(fixture('html/card-in-card', 'fail'), {});

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(6);
  });

  it('leaves a grid of cards alone', () => {
    const findings = ruleOf('html/card-in-card').check(fixture('html/card-in-card', 'pass'), {});

    expect(findings).toEqual([]);
  });

  it('is a taste rule, so the design file can turn it off', () => {
    const file = fixture('html/card-in-card', 'fail');
    const findings = ruleOf('html/card-in-card').check(file, {
      design: 'we nest html/card-in-card on purpose',
    });

    expect(findings).toEqual([]);
  });
});
