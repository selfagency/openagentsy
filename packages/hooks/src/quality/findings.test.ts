import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '@openagentsy/quality';
import { describe, expect, it } from 'vitest';
import { createFindingsStore, findingsPath } from './findings.js';

/** A state root the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-findings-'));
}

/** A finding, for the store to hold. */
function finding(over: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'css/no-transition-all',
    source: 'hallmark:floor-2',
    tier: 'reflex',
    file: 'src/app.css',
    line: 12,
    message: 'A transition of all moves every property.',
    fix: 'Name the properties to transition instead of all',
    ...over,
  };
}

describe('the findings store', () => {
  it('writes the findings under the state root', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);

    await store.record('oa-1', ['src/app.css'], [finding()]);

    const written = await readFile(findingsPath(root), 'utf8');
    expect(written).toContain('css/no-transition-all');
    expect(findingsPath(root)).toBe(join(root, '.openagentsy', 'quality', 'findings.json'));
  });

  it('reads the findings back in a store that was made later', async () => {
    const root = await scratch();
    await createFindingsStore(root).record('oa-1', ['src/app.css'], [finding()]);

    const found = await createFindingsStore(root).forTask('oa-1');

    expect(found).toHaveLength(1);
    expect(found[0]?.ruleId).toBe('css/no-transition-all');
  });

  it('keeps the findings of one task apart from the findings of another', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    await store.record('oa-1', ['src/app.css'], [finding()]);

    await store.record('oa-2', ['src/other.css'], [finding({ file: 'src/other.css' })]);

    expect(await store.forTask('oa-1')).toHaveLength(1);
    expect((await store.forTask('oa-2'))[0]?.file).toBe('src/other.css');
  });

  it('holds the floor findings apart from the rest', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    await store.record(
      'oa-1',
      ['src/app.css'],
      [
        finding({ tier: 'floor' }),
        finding({ tier: 'reflex', ruleId: 'copy/buzzwords' }),
        finding({ tier: 'finish', ruleId: 'copy/em-dash' }),
      ],
    );

    const floor = await store.openFloor('oa-1');

    expect(floor).toHaveLength(1);
    expect(floor[0]?.tier).toBe('floor');
  });

  it('drops the findings of a file that was checked again', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    await store.record('oa-1', ['src/app.css'], [finding()]);

    await store.record('oa-1', ['src/app.css'], []);

    expect(await store.forTask('oa-1')).toEqual([]);
  });

  it('keeps the findings of the files that were not checked', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    await store.record('oa-1', ['src/app.css'], [finding()]);

    await store.record('oa-1', ['src/other.css'], [finding({ file: 'src/other.css' })]);

    const found = await store.forTask('oa-1');
    expect(found.map((entry) => entry.file).sort()).toEqual(['src/app.css', 'src/other.css']);
  });

  it('starts empty for a project that has no findings yet', async () => {
    const root = await scratch();

    expect(await createFindingsStore(root).forTask('oa-1')).toEqual([]);
  });
});
