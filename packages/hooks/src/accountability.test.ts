import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountabilityCounts, formatAccountability } from './accountability.js';
import { createWaiverStore, type Waiver } from './quality/waivers.js';

/** A state root the test reads. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-accountability-'));
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

describe('the accountability counts', () => {
  it('counts no waiver in a project that has none', async () => {
    const root = await scratch();
    const counts = await accountabilityCounts(root);
    expect(counts.waivers).toBe(0);
    expect(formatAccountability(counts)).toBe('0 waivers');
  });

  it('counts the waivers a person recorded', async () => {
    const root = await scratch();
    const store = createWaiverStore(root);
    await store.add(waiver());
    await store.add(waiver({ path: 'src/other.css' }));
    const counts = await accountabilityCounts(root);
    expect(counts.waivers).toBe(2);
    expect(formatAccountability(counts)).toBe('2 waivers');
  });

  it('says one waiver in the singular', () => {
    expect(formatAccountability({ waivers: 1 })).toBe('1 waiver');
  });
});
