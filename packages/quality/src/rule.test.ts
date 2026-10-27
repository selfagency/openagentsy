import { describe, expect, it } from 'vitest';
import { createRegistry, defineRule, type QualityRule } from './rule.js';

function rule(overrides: Partial<QualityRule> = {}): QualityRule {
  return {
    id: 'css/example',
    source: 'hallmark:floor-1',
    tier: 'floor',
    appliesTo: ['**/*.css'],
    waivable: false,
    check: () => [],
    ...overrides,
  };
}

describe('the rule registry', () => {
  it('refuses a floor rule a person could waive', () => {
    expect(() => createRegistry([rule({ waivable: true })])).toThrow(
      'floor rule css/example cannot be waivable',
    );
  });

  it('takes a floor rule that is not waivable', () => {
    expect(() => createRegistry([rule()])).not.toThrow();
  });

  it('takes a reflex rule a person can waive', () => {
    expect(() => createRegistry([rule({ tier: 'reflex', waivable: true })])).not.toThrow();
  });

  it('selects the rules that apply to a path', () => {
    const registry = createRegistry([
      rule({ id: 'css/example' }),
      rule({
        id: 'html/example',
        tier: 'reflex',
        waivable: true,
        appliesTo: ['**/*.{html,tsx}'],
      }),
    ]);

    expect(registry.forFile('src/app.css').map((found) => found.id)).toEqual(['css/example']);
    expect(registry.forFile('src/app.html').map((found) => found.id)).toEqual(['html/example']);
    expect(registry.forFile('src/app.tsx').map((found) => found.id)).toEqual(['html/example']);
  });

  it('selects the rules that apply to an absolute path', () => {
    const registry = createRegistry([rule({ id: 'css/example' })]);

    expect(registry.forFile('/repo/src/app.css').map((found) => found.id)).toEqual(['css/example']);
  });

  it('selects no rule for a path no rule applies to', () => {
    const registry = createRegistry([rule({ id: 'css/example' })]);

    expect(registry.forFile('src/app.ts')).toEqual([]);
  });

  it('keeps every rule in the order it was given', () => {
    const registry = createRegistry([rule({ id: 'css/one' }), rule({ id: 'css/two' })]);

    expect(registry.rules().map((found) => found.id)).toEqual(['css/one', 'css/two']);
  });
});

describe('a rule built by defineRule', () => {
  it('fills the metadata the check does not repeat', () => {
    const built = defineRule({
      id: 'css/example',
      source: ['hallmark:floor-2', 'antislop:R-32'],
      tier: 'reflex',
      appliesTo: ['**/*.css'],
      waivable: true,
      check: () => [{ line: 3, message: 'a message', fix: 'a fix' }],
    });

    const findings = built.check({ path: 'src/app.css', text: '' }, {});

    expect(findings).toEqual([
      {
        ruleId: 'css/example',
        source: 'hallmark:floor-2, antislop:R-32',
        tier: 'reflex',
        file: 'src/app.css',
        line: 3,
        message: 'a message',
        fix: 'a fix',
      },
    ]);
  });
});
