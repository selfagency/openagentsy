import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../rule.js';
import { contrastRatio, parseColour } from './colour.js';
import { cssRules } from './rules.js';

/** The line the first finding of each failing fixture has to be on. */
const EXPECTED_LINE: Record<string, number> = {
  'css/token-only-colour-font': 3,
  'css/no-transition-all': 3,
  'css/no-layout-animation': 4,
  'css/overflow-clip': 3,
  'css/grid-minmax': 4,
  'css/reduced-motion': 3,
  'css/focus-visible': 2,
  'css/contrast': 4,
  'css/purple-blue-gradient': 3,
};

function fixture(ruleId: string, kind: 'pass' | 'fail'): SourceFile {
  const name = ruleId.replace('css/', '');
  const url = new URL(`../../fixtures/css/${name}/${kind}.css`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function ruleOf(id: string) {
  const found = cssRules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`the rule ${id} is missing`);
  return found;
}

describe('the CSS rules', () => {
  it('holds the nine rules of the plan', () => {
    expect(cssRules.map((rule) => rule.id)).toEqual([
      'css/token-only-colour-font',
      'css/no-transition-all',
      'css/no-layout-animation',
      'css/overflow-clip',
      'css/grid-minmax',
      'css/reduced-motion',
      'css/focus-visible',
      'css/contrast',
      'css/purple-blue-gradient',
    ]);
  });

  it('never lets a floor rule be waived', () => {
    for (const rule of cssRules) {
      if (rule.tier === 'floor') expect(rule.waivable).toBe(false);
    }
  });

  for (const rule of cssRules) {
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

describe('the contrast rule', () => {
  it('compares the unrounded ratio with the AA minimum', () => {
    const rule = ruleOf('css/contrast');
    const findings = rule.check(fixture('css/contrast', 'fail'), {});

    expect(findings).toHaveLength(1);

    const grey = parseColour('#777777');
    const white = parseColour('#ffffff');
    if (grey === undefined || white === undefined) throw new Error('the colours must parse');

    const ratio = contrastRatio(grey, white);

    expect(ratio).toBeLessThan(4.5);
    expect(Math.round(ratio * 10) / 10).toBe(4.5);
  });

  it('names the two tokens of the pair', () => {
    const findings = ruleOf('css/contrast').check(fixture('css/contrast', 'fail'), {});

    expect(findings[0]?.message).toContain('--color-text');
    expect(findings[0]?.message).toContain('--color-bg');
  });
});

describe('the reduced-motion rule', () => {
  it('reports the animation as a floor finding, never as a warning', () => {
    const rule = ruleOf('css/reduced-motion');
    const findings = rule.check(fixture('css/reduced-motion', 'fail'), {});

    expect(rule.tier).toBe('floor');
    expect(findings.length).toBeGreaterThan(0);
    for (const found of findings) {
      expect(found.tier).toBe('floor');
    }
  });
});

describe('the design file', () => {
  it('turns a taste rule off when it names the rule', () => {
    const rule = ruleOf('css/purple-blue-gradient');
    const file = fixture('css/purple-blue-gradient', 'fail');

    expect(rule.check(file, { design: 'we use css/purple-blue-gradient on purpose' })).toEqual([]);
  });

  it('never turns a floor rule off', () => {
    const rule = ruleOf('css/reduced-motion');
    const file = fixture('css/reduced-motion', 'fail');

    expect(rule.check(file, { design: 'css/reduced-motion is fine here' }).length).toBeGreaterThan(
      0,
    );
  });
});
