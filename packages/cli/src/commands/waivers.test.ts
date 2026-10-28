import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWaiverStore } from '@openagentsy/hooks/quality/waivers';
import { describe, expect, it } from 'vitest';
import { formatWaiver, runWaiver } from './waivers.js';

async function stateRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-cli-waivers-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

describe('the waiver command', () => {
  it('records the waiver a person decided', async () => {
    const { root, remove } = await stateRoot();
    try {
      const report = await runWaiver(
        root,
        'css/no-transition-all',
        'src/app.css',
        'The file is a fixture, not a page.',
      );
      expect(report.ok).toBe(true);
      expect(report.count).toBe(1);
      expect(await createWaiverStore(root).count()).toBe(1);
      expect(formatWaiver(report)).toContain('css/no-transition-all');
    } finally {
      await remove();
    }
  });

  it('refuses a floor rule and says why', async () => {
    const { root, remove } = await stateRoot();
    try {
      const report = await runWaiver(
        root,
        'css/contrast',
        'src/app.css',
        'The contrast is fine, I have looked at it.',
      );
      expect(report.ok).toBe(false);
      expect(report.problem).toContain('cannot be waived');
      expect(report.hint).toContain('floor rule');
      expect(await createWaiverStore(root).count()).toBe(0);
    } finally {
      await remove();
    }
  });

  it('refuses a reason that is too short', async () => {
    const { root, remove } = await stateRoot();
    try {
      const report = await runWaiver(root, 'css/no-transition-all', 'src/app.css', 'because');
      expect(report.ok).toBe(false);
      expect(report.problem).toContain('ten characters');
      expect(report.hint).toContain('ten characters');
      expect(await createWaiverStore(root).count()).toBe(0);
    } finally {
      await remove();
    }
  });

  it('names the person who decided', async () => {
    const { root, remove } = await stateRoot();
    try {
      const report = await runWaiver(
        root,
        'css/no-transition-all',
        'src/app.css',
        'The file is a fixture, not a page.',
        { decidedBy: 'daniel' },
      );
      expect(report.ok).toBe(true);
      const waivers = await createWaiverStore(root).all();
      expect(waivers[0]?.decidedBy).toBe('daniel');
    } finally {
      await remove();
    }
  });
});
