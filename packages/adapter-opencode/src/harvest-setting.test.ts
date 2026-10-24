import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestEnabled } from './harvest.js';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'oa-harvest-setting-'));
}

describe('harvestEnabled', () => {
  it('is on when nothing says otherwise', async () => {
    expect(await harvestEnabled(await root())).toBe(true);
  });

  it('is off when the marker says off', async () => {
    const dir = await root();
    await mkdir(join(dir, '.openagentsy'), { recursive: true });
    await writeFile(join(dir, '.openagentsy', 'harvest'), 'off\n', 'utf8');
    expect(await harvestEnabled(dir)).toBe(false);
  });

  it('is on when the marker says on', async () => {
    const dir = await root();
    await mkdir(join(dir, '.openagentsy'), { recursive: true });
    await writeFile(join(dir, '.openagentsy', 'harvest'), 'on\n', 'utf8');
    expect(await harvestEnabled(dir)).toBe(true);
  });

  it('is on when the marker says something else', async () => {
    // An unknown word is not a switch. The pipeline runs unless it is told
    // not to, because a pipeline that stops on a typo loses memories.
    const dir = await root();
    await mkdir(join(dir, '.openagentsy'), { recursive: true });
    await writeFile(join(dir, '.openagentsy', 'harvest'), 'maybe\n', 'utf8');
    expect(await harvestEnabled(dir)).toBe(true);
  });
});
