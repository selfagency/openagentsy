import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, grantLeases, migrate, openDatabase } from '@openagentsy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { guardWrite, targetPathsOf } from './write-guard.js';

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

describe('guardWrite', () => {
  it('allows a write to a file the agent holds', async () => {
    await expect(
      guardWrite(root, 'edit', { filePath: 'src/app.ts' }, 'oa-builder', 'ses-1'),
    ).resolves.toBeUndefined();
  });

  it('refuses a write to a file no lease covers', async () => {
    await expect(
      guardWrite(root, 'edit', { filePath: 'docs/app.ts' }, 'oa-builder', 'ses-1'),
    ).rejects.toThrow(/no lease covers/);
  });

  it('refuses a write from a session with no agent', async () => {
    await expect(
      guardWrite(root, 'edit', { filePath: 'src/app.ts' }, undefined, 'ses-1'),
    ).rejects.toThrow(/no agent/);
  });

  it('refuses a write whose path cannot be read', async () => {
    await expect(guardWrite(root, 'edit', {}, 'oa-builder', 'ses-1')).rejects.toThrow(
      /names no path/,
    );
  });

  it('allows a patch that touches a leased file', async () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    await expect(
      guardWrite(root, 'apply_patch', { patchText }, 'oa-builder', 'ses-1'),
    ).resolves.toBeUndefined();
  });

  it('refuses a patch that touches a file no lease covers', async () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: docs/app.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    await expect(
      guardWrite(root, 'apply_patch', { patchText }, 'oa-builder', 'ses-1'),
    ).rejects.toThrow(/no lease covers/);
  });

  it('leaves a tool that is not a write alone', async () => {
    await expect(
      guardWrite(root, 'read', { filePath: 'src/app.ts' }, 'oa-builder', 'ses-1'),
    ).resolves.toBeUndefined();
  });
});
