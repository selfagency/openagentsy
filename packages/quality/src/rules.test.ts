import { describe, expect, it } from 'vitest';
import { cssRules } from './css/rules.js';
import { allRules, qualityRegistry } from './rules.js';

describe('the registry of every rule', () => {
  it('holds the seventeen rules of the plan', () => {
    expect(allRules.map((rule) => rule.id)).toEqual([
      'css/token-only-colour-font',
      'css/no-transition-all',
      'css/no-layout-animation',
      'css/overflow-clip',
      'css/grid-minmax',
      'css/reduced-motion',
      'css/focus-visible',
      'css/contrast',
      'css/purple-blue-gradient',
      'html/dead-nav',
      'html/inert-control',
      'html/emoji-icon',
      'html/card-in-card',
      'copy/unsourced-claim',
      'copy/generic-cta',
      'copy/buzzwords',
      'copy/em-dash',
    ]);
  });

  it('holds the nine CSS rules and the eight of the plan', () => {
    expect(allRules).toHaveLength(17);
    expect(allRules.filter((rule) => rule.id.startsWith('css/'))).toHaveLength(9);
    expect(allRules.filter((rule) => rule.id.startsWith('html/'))).toHaveLength(4);
    expect(allRules.filter((rule) => rule.id.startsWith('copy/'))).toHaveLength(4);
  });

  it('is built at load, so a waivable floor rule stops the package', () => {
    expect(qualityRegistry.rules()).toHaveLength(17);
  });

  it('never lets a floor rule be waived', () => {
    for (const rule of allRules) {
      if (rule.tier === 'floor') expect(rule.waivable).toBe(false);
    }
  });

  it('holds the CSS rules the plan asks for', () => {
    expect(cssRules).toHaveLength(9);
  });
});

describe('the rules of a file', () => {
  it('picks the stylesheet rules for a stylesheet', () => {
    expect(qualityRegistry.forFile('src/app.css').map((rule) => rule.id)).toEqual([
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

  it('picks the page rules for a page', () => {
    expect(qualityRegistry.forFile('src/app.html').map((rule) => rule.id)).toEqual([
      'html/dead-nav',
      'html/inert-control',
      'html/emoji-icon',
      'html/card-in-card',
      'copy/unsourced-claim',
      'copy/generic-cta',
      'copy/buzzwords',
      'copy/em-dash',
    ]);
  });

  it('picks the page rules for a component', () => {
    expect(qualityRegistry.forFile('src/app.tsx').map((rule) => rule.id)).toEqual([
      'html/dead-nav',
      'html/inert-control',
      'html/emoji-icon',
      'html/card-in-card',
      'copy/unsourced-claim',
      'copy/generic-cta',
      'copy/buzzwords',
      'copy/em-dash',
    ]);
  });

  it('picks no rule for a document', () => {
    expect(qualityRegistry.forFile('docs/plan.md')).toEqual([]);
  });
});
