import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '@openagentsy/quality/rule';
import { describe, expect, it } from 'vitest';
import { waive } from './waive.js';
import {
  createWaiverStore,
  loadWaiverLookup,
  noWaivers,
  type Waiver,
  waiversPath,
} from './waivers.js';

/** A state root the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-waivers-'));
}

/** A finding, for a waiver to cover. */
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

/** A waiver, as a person recorded it. */
function waiver(over: Partial<Waiver> = {}): Waiver {
  return {
    ruleId: 'css/no-transition-all',
    path: 'src/app.css',
    reason: 'The file is a fixture, not a page.',
    decidedBy: 'human',
    ts: '2026-10-27T10:00:00.000Z',
    ...over,
  };
}

describe('the waiver store', () => {
  it('holds no waiver when the project has none', async () => {
    const root = await scratch();
    const store = createWaiverStore(root);
    expect(await store.all()).toEqual([]);
    expect(await store.count()).toBe(0);
  });

  it('keeps the waivers in the state root', async () => {
    const root = await scratch();
    await createWaiverStore(root).add(waiver());
    expect(waiversPath(root)).toBe(join(root, '.openagentsy', 'quality', 'waivers.json'));
    const text = await readFile(waiversPath(root), 'utf8');
    expect(text).toContain('css/no-transition-all');
  });

  it('reads a file that is not there as no waiver', async () => {
    const root = await scratch();
    expect(await createWaiverStore(root).all()).toEqual([]);
  });

  it('reads a file that is broken as no waiver', async () => {
    const root = await scratch();
    const store = createWaiverStore(root);
    await store.add(waiver());
    await writeFile(waiversPath(root), 'not json', 'utf8');
    expect(await store.all()).toEqual([]);
  });
});

describe('the waiver lookup', () => {
  it('covers the finding the waiver names', async () => {
    const root = await scratch();
    await createWaiverStore(root).add(waiver());
    const lookup = await loadWaiverLookup(root);
    expect(lookup.covers(finding())).toBe(true);
  });

  it('covers no other rule and no other file', async () => {
    const root = await scratch();
    await createWaiverStore(root).add(waiver());
    const lookup = await loadWaiverLookup(root);
    expect(lookup.covers(finding({ ruleId: 'css/contrast' }))).toBe(false);
    expect(lookup.covers(finding({ file: 'src/other.css' }))).toBe(false);
  });

  it('covers nothing when the project has no waiver', async () => {
    const root = await scratch();
    const lookup = await loadWaiverLookup(root);
    expect(lookup.covers(finding())).toBe(false);
  });

  it('covers nothing with the empty lookup', () => {
    expect(noWaivers.covers(finding())).toBe(false);
  });

  it('compares an absolute path with a relative one', async () => {
    const root = await scratch();
    await createWaiverStore(root).add(waiver({ path: join(root, 'src/app.css') }));
    const lookup = await loadWaiverLookup(root);
    expect(lookup.covers(finding({ file: join(root, 'src/app.css') }))).toBe(true);
  });
});

describe('the recording of a waiver', () => {
  it('records a waiver for a rule that may be waived', async () => {
    const root = await scratch();
    const recorded = await waive({
      stateRoot: root,
      ruleId: 'css/no-transition-all',
      path: 'src/app.css',
      reason: 'The file is a fixture, not a page.',
      decidedBy: 'human',
    });
    expect(recorded.ruleId).toBe('css/no-transition-all');
    expect(recorded.decidedBy).toBe('human');
    expect(await createWaiverStore(root).count()).toBe(1);
  });

  it('refuses a floor rule', async () => {
    const root = await scratch();
    await expect(
      waive({
        stateRoot: root,
        ruleId: 'css/contrast',
        path: 'src/app.css',
        reason: 'The contrast is fine, I have looked at it.',
        decidedBy: 'human',
      }),
    ).rejects.toThrow('cannot be waived');
    expect(await createWaiverStore(root).count()).toBe(0);
  });

  it('refuses a reason that is too short', async () => {
    const root = await scratch();
    await expect(
      waive({
        stateRoot: root,
        ruleId: 'css/no-transition-all',
        path: 'src/app.css',
        reason: 'because',
        decidedBy: 'human',
      }),
    ).rejects.toThrow('ten characters');
    expect(await createWaiverStore(root).count()).toBe(0);
  });

  it('refuses a rule that does not exist', async () => {
    const root = await scratch();
    await expect(
      waive({
        stateRoot: root,
        ruleId: 'css/no-such-rule',
        path: 'src/app.css',
        reason: 'The file is a fixture, not a page.',
        decidedBy: 'human',
      }),
    ).rejects.toThrow('no rule is named');
    expect(await createWaiverStore(root).count()).toBe(0);
  });
});
