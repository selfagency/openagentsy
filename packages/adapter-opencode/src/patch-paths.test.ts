import { describe, expect, it } from 'vitest';
import { patchPaths } from './patch-paths.js';

describe('patchPaths', () => {
  it('finds the file an update touches', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(patchPaths(text)).toEqual(['src/app.ts']);
  });

  it('finds every file a patch touches', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: src/new-file.ts',
      '+hello',
      '*** Delete File: src/obsolete.ts',
      '*** End Patch',
    ].join('\n');
    expect(patchPaths(text).sort()).toEqual(['src/new-file.ts', 'src/obsolete.ts']);
  });

  it('finds the target of a move', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/new.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(patchPaths(text).sort()).toEqual(['src/new.ts', 'src/old.ts']);
  });

  it('names a path once, however often the patch mentions it', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: src/app.ts',
      '*** End Patch',
    ].join('\n');
    expect(patchPaths(text)).toEqual(['src/app.ts']);
  });

  it('finds nothing in a patch that names no file', () => {
    expect(patchPaths('*** Begin Patch\n*** End Patch')).toEqual([]);
    expect(patchPaths('')).toEqual([]);
  });

  it('ignores a line that only looks like a marker', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '+// *** Add File: not-a-file.ts',
      '*** End Patch',
    ].join('\n');
    expect(patchPaths(text)).toEqual(['src/app.ts']);
  });
});
