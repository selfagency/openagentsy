import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, grantLeases, migrate, openDatabase } from '@openagentsy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { joinRoot, targetPathsOf } from './write-guard.js';

let root: string;

const ROLES = `
version: 1
protectedPaths: []
defaults:
  permissions: {}
roles:
  builder:
    description: Implements a bean
    mode: subagent
    writes: true
    scope: leased files
    guidance: test it
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: low
      ceilingVariant: high
      climbTriggers: [test_failed_twice]
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-write-guard-'));
  await writeFile(join(root, 'roles.yaml'), ROLES, 'utf8');
  await mkdir(join(root, '.openagentsy'), { recursive: true });
  const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
  migrate(db);
  grantLeases(db, { bean: 'proj-1', agent: 'oa-builder', globs: ['src/**'] });
  closeDatabase(db);
});

describe('targetPathsOf', () => {
  it('reads the path of an edit', () => {
    expect(targetPathsOf('edit', { filePath: 'src/app.ts' })).toEqual(['src/app.ts']);
  });

  it('reads the paths of a patch', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(targetPathsOf('apply_patch', { patchText })).toEqual(['src/app.ts']);
  });

  it('finds no path in a tool call that names none', () => {
    expect(targetPathsOf('edit', {})).toEqual([]);
  });
});

describe('joinRoot', () => {
  it('joins a relative path the way the board does', () => {
    // The guard and the board have to agree on what a path means, or a
    // write is refused for a file the lease does cover.
    expect(joinRoot('/repo', 'src/app.ts')).toBe('/repo/src/app.ts');
    expect(joinRoot('/repo', 'src/app.ts')).toBe(join('/repo', 'src/app.ts'));
  });

  it('leaves an absolute path alone', () => {
    expect(joinRoot('/repo', '/elsewhere/app.ts')).toBe('/elsewhere/app.ts');
  });

  it('does not join a Windows path by hand', () => {
    // A path that starts with a drive letter is absolute on Windows and
    // not on Unix, so the platform's own rule decides. The guard used to
    // test for a leading slash and join a Windows path into nonsense.
    const windows = 'C:\\repo\\src\\app.ts';
    expect(joinRoot('/repo', windows)).toBe(join('/repo', windows));
  });
});
