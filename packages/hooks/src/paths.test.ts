import { describe, expect, it } from 'vitest';
import { isInside, pathSegments, projectName, worktreeRoot } from './paths.js';

describe('isInside', () => {
  it('holds a path inside a root', () => {
    expect(isInside('/repo/src/a.ts', ['/repo'])).toBe(true);
    expect(isInside('/repo', ['/repo'])).toBe(true);
  });

  it('refuses a path outside every root', () => {
    expect(isInside('/elsewhere/a.ts', ['/repo'])).toBe(false);
  });

  it('refuses a path that climbs out with ..', () => {
    expect(isInside('/repo/../elsewhere/a.ts', ['/repo'])).toBe(false);
  });

  it('refuses a sibling that only shares a prefix', () => {
    expect(isInside('/repository/a.ts', ['/repo'])).toBe(false);
  });

  it('does not read a relative path as an absolute one', () => {
    expect(isInside('src/a.ts', ['/repo'])).toBe(false);
    expect(isInside('src/a.ts', ['src'])).toBe(true);
  });
});

describe('the worktree root', () => {
  it('lives under the home directory, named after the project', () => {
    expect(worktreeRoot('openagentsy', '/home/dev')).toBe(
      '/home/dev/.openagentsy/worktrees/openagentsy',
    );
  });

  it('names the project after the workspace', () => {
    expect(projectName('/tmp/oa-wt-2c-1')).toBe('oa-wt-2c-1');
  });
});

describe('the path segments', () => {
  it('resolves .. and drops the empty parts', () => {
    expect(pathSegments('/repo/./src//a.ts')).toEqual(['repo', 'src', 'a.ts']);
    expect(pathSegments('/repo/../etc/passwd')).toEqual(['etc', 'passwd']);
  });
});
