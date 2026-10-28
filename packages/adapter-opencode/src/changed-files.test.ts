import { describe, expect, it } from 'vitest';
import { changedFiles } from './changed-files.js';

describe('changedFiles', () => {
  it('gives a reader no files at all', () => {
    // A read names a file as well, and that is not a write. A reader that
    // carried files would make the write rules fire on a read.
    expect(changedFiles('read', { filePath: 'roles.yaml' })).toEqual([]);
    expect(changedFiles('grep', { path: 'src/app.ts' })).toEqual([]);
  });

  it('reads the file a write names', () => {
    expect(changedFiles('write', { filePath: 'src/app.ts' })).toEqual([{ path: 'src/app.ts' }]);
    expect(changedFiles('edit', { path: 'src/app.ts' })).toEqual([{ path: 'src/app.ts' }]);
    expect(changedFiles('multi_edit', { file: 'src/app.ts' })).toEqual([{ path: 'src/app.ts' }]);
  });

  it('reads the file of a tool the package does not know', () => {
    // A name in neither list that carries a file is a write, so the file
    // has to be read out of the arguments.
    expect(changedFiles('some_mcp_tool', { path: 'src/app.ts' })).toEqual([{ path: 'src/app.ts' }]);
  });

  it('reads every file a patch touches', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: src/new-file.ts',
      '+hello',
      '*** Delete File: src/obsolete.ts',
      '*** End Patch',
    ].join('\n');
    expect(changedFiles('apply_patch', { patchText })).toEqual([
      { path: 'src/new-file.ts' },
      { path: 'src/obsolete.ts' },
    ]);
  });

  it('reads both ends of a move', () => {
    // A patch that moves a file onto a protected path has touched the
    // protected path, so both ends have to be read.
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/new.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(changedFiles('apply_patch', { patchText })).toEqual([
      { path: 'src/new.ts', fromPath: 'src/old.ts' },
    ]);
  });

  it('finds no file in a call that names none', () => {
    expect(changedFiles('write', {})).toEqual([]);
    expect(changedFiles('apply_patch', {})).toEqual([]);
    expect(changedFiles('bash', { command: 'ls -la' })).toEqual([]);
  });

  it('finds no file in a call whose arguments are not a set of names', () => {
    expect(changedFiles('write', 'src/app.ts')).toEqual([]);
    expect(changedFiles('write', undefined)).toEqual([]);
  });
});
