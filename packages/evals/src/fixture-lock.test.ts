import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteLockModels } from './fixture.js';

describe('rewriteLockModels', () => {
  it('keeps the ladder, so a role can still climb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-lock-'));
    const path = join(dir, 'openagentsy.models.lock.json');
    await writeFile(
      path,
      JSON.stringify({
        roles: {
          lead: {
            model: 'opencode-go/glm-5.3',
            ladder: [
              { model: 'opencode-go/glm-5.3', variant: 'low' },
              { model: 'opencode-go/glm-5.3', variant: 'max' },
            ],
          },
          scout: { model: 'opencode-go/mimo-v2.6-flash' },
        },
      }),
      'utf8',
    );

    await rewriteLockModels(path, 'opencode-go/deepseek-v4.1-flash');

    const lock = JSON.parse(await readFile(path, 'utf8'));
    // The model under test answers every role.
    expect(lock.roles.lead.model).toBe('opencode-go/deepseek-v4.1-flash');
    expect(lock.roles.scout.model).toBe('opencode-go/deepseek-v4.1-flash');
    // The ladder keeps its rungs: a ladder of one is a role that does not
    // climb, and the case about the climb would fail for the wrong reason.
    expect(lock.roles.lead.ladder).toHaveLength(2);
    expect(lock.roles.lead.ladder[0].model).toBe('opencode-go/deepseek-v4.1-flash');
    // The variant is gone: the model under test has none.
    expect(lock.roles.lead.ladder[0].variant).toBeUndefined();
  });

  it('leaves a role without a ladder without one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-lock-'));
    const path = join(dir, 'openagentsy.models.lock.json');
    await writeFile(
      path,
      JSON.stringify({ roles: { scout: { model: 'opencode-go/mimo-v2.6-flash' } } }),
      'utf8',
    );

    await rewriteLockModels(path, 'opencode-go/deepseek-v4.1-flash');

    const lock = JSON.parse(await readFile(path, 'utf8'));
    expect(lock.roles.scout.ladder).toEqual([]);
  });
});
