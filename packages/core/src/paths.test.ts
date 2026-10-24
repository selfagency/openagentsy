import { describe, expect, it } from 'vitest';
import { MAX_GLOB_LENGTH, matchesGlob, normalizePath, relativeToRoot } from './paths.js';

describe('matchesGlob', () => {
  it('lets a single star stay inside one path segment', () => {
    expect(matchesGlob('src/*', 'src/index.ts')).toBe(true);
    expect(matchesGlob('src/*', 'src/api/index.ts')).toBe(false);
  });

  it('lets a double star cross path segments', () => {
    expect(matchesGlob('src/**', 'src/api/index.ts')).toBe(true);
    expect(matchesGlob('src/**', 'src/index.ts')).toBe(true);
    expect(matchesGlob('src/**', 'test/index.ts')).toBe(false);
  });

  it('treats a question mark as exactly one character', () => {
    expect(matchesGlob('v?.ts', 'v1.ts')).toBe(true);
    expect(matchesGlob('v?.ts', 'v12.ts')).toBe(false);
  });

  it('treats the rest of the pattern as literal', () => {
    expect(matchesGlob('a.b+c.ts', 'a.b+c.ts')).toBe(true);
    expect(matchesGlob('a.b+c.ts', 'axbbc.ts')).toBe(false);
  });

  it('anchors the whole value', () => {
    expect(matchesGlob('src', 'src/index.ts')).toBe(false);
    expect(matchesGlob('src', 'src')).toBe(true);
  });

  it('matches a nested path under a double star', () => {
    expect(matchesGlob('src/api/**', 'src/api/search.ts')).toBe(true);
  });

  it('does not match a path outside the pattern', () => {
    expect(matchesGlob('src/api/**', 'src/web/page.ts')).toBe(false);
  });

  it('matches a leading double star with or without a segment', () => {
    expect(matchesGlob('**/index.ts', 'index.ts')).toBe(true);
    expect(matchesGlob('**/index.ts', 'src/api/index.ts')).toBe(true);
    expect(matchesGlob('**/index.ts', 'src/api/index.js')).toBe(false);
  });

  it('answers in linear time on a pattern made to backtrack', () => {
    // A regular expression built from this pattern costs exponential time on
    // a path that nearly matches, and the glob is written by an agent.
    const pattern = `${'*a'.repeat(40)}b`;
    const path = `${'a'.repeat(400)}c`;
    const started = Date.now();
    expect(matchesGlob(pattern, path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('covers nothing when the glob is longer than the limit', () => {
    const pattern = 'a'.repeat(MAX_GLOB_LENGTH + 1);
    expect(matchesGlob(pattern, pattern)).toBe(false);
  });
});

describe('normalizePath', () => {
  it('drops a leading dot slash and a trailing slash', () => {
    expect(normalizePath('./src/api/')).toBe('src/api');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\api\\x.ts')).toBe('src/api/x.ts');
  });
});

describe('relativeToRoot', () => {
  it('makes a path under the root relative', () => {
    expect(relativeToRoot('/repo', '/repo/src/api/x.ts')).toBe('src/api/x.ts');
  });

  it('keeps a path outside the root absolute so it cannot match by accident', () => {
    expect(relativeToRoot('/repo', '/elsewhere/x.ts')).toBe('/elsewhere/x.ts');
  });
});
