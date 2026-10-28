import { describe, expect, it } from 'vitest';
import { cssRules } from './css/rules.js';
import { allRegistry, allRules } from './rules.js';

describe('the registry of every rule', () => {
  it('holds the twenty-three rules of the plan', () => {
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
      'comment/banner-separator',
      'comment/decorative-marker',
      'comment/step-narration',
      'comment/empty-label',
      'comment/empty-todo',
      'comment/redundant-jsdoc',
    ]);
  });

  it('holds the nine CSS rules, the eight of the plan and the six of the comments', () => {
    expect(allRules).toHaveLength(23);
    expect(allRules.filter((rule) => rule.id.startsWith('css/'))).toHaveLength(9);
    expect(allRules.filter((rule) => rule.id.startsWith('html/'))).toHaveLength(4);
    expect(allRules.filter((rule) => rule.id.startsWith('copy/'))).toHaveLength(4);
    expect(allRules.filter((rule) => rule.id.startsWith('comment/'))).toHaveLength(6);
  });

  it('is built at load, so a waivable floor rule stops the package', () => {
    expect(allRegistry.rules()).toHaveLength(23);
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
    expect(allRegistry.forFile('src/app.css').map((rule) => rule.id)).toEqual([
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
    expect(allRegistry.forFile('src/app.html').map((rule) => rule.id)).toEqual([
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

  it('picks the page rules and the comment rules for a component', () => {
    expect(allRegistry.forFile('src/app.tsx').map((rule) => rule.id)).toEqual([
      'html/dead-nav',
      'html/inert-control',
      'html/emoji-icon',
      'html/card-in-card',
      'copy/unsourced-claim',
      'copy/generic-cta',
      'copy/buzzwords',
      'copy/em-dash',
      'comment/banner-separator',
      'comment/decorative-marker',
      'comment/step-narration',
      'comment/empty-label',
      'comment/empty-todo',
      'comment/redundant-jsdoc',
    ]);
  });

  it('picks the comment rules for a source file', () => {
    expect(allRegistry.forFile('src/app.ts').map((rule) => rule.id)).toEqual([
      'comment/banner-separator',
      'comment/decorative-marker',
      'comment/step-narration',
      'comment/empty-label',
      'comment/empty-todo',
      'comment/redundant-jsdoc',
    ]);
  });

  it('picks no rule for a document', () => {
    expect(allRegistry.forFile('docs/plan.md')).toEqual([]);
  });
});
