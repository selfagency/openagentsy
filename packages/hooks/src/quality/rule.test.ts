import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '@openagentsy/quality';
import { describe, expect, it } from 'vitest';
import { createFindingsStore } from './findings.js';
import { qualityAfterWrite } from './rule.js';

/** A workspace the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-quality-rule-'));
}

/** A finding, for the check to report. */
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

/** The event a write arrives as. */
function written(files: readonly string[]): unknown {
  return {
    toolName: 'apply_patch',
    args: { patchText: '' },
    files: files.map((path) => ({ path })),
    sessionID: 'ses-1',
  };
}

/** The text the rule appended to the result. */
function appended(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const transform = (result as { transform?: unknown }).transform;
  if (typeof transform !== 'object' || transform === null) return undefined;
  const text = (transform as { appendToResult?: unknown }).appendToResult;
  return typeof text === 'string' ? text : undefined;
}

describe('the quality rule', () => {
  it('checks the files the patch touched and not the others', async () => {
    const root = await scratch();
    await writeFile(join(root, 'app.css'), '.a { transition: all 0.2s; }\n', 'utf8');
    await writeFile(join(root, 'other.css'), '.b { transition: all 0.2s; }\n', 'utf8');
    const rule = qualityAfterWrite({ workspace: root, stateRoot: root, mode: 'during' });

    const result = await rule.handler(written(['app.css']));

    const text = appended(result) ?? '';
    expect(text).toContain('app.css');
    expect(text).not.toContain('other.css');
  });

  it('shows the agent at most eight lines', async () => {
    const root = await scratch();
    const many = Array.from({ length: 12 }, (_unused, index) => finding({ line: index + 1 }));
    const rule = qualityAfterWrite({
      workspace: root,
      stateRoot: root,
      mode: 'during',
      check: async () => many,
    });

    const result = await rule.handler(written(['src/app.css']));

    expect((appended(result) ?? '').split('\n')).toHaveLength(8);
  });

  it('says nothing about a taste finding', async () => {
    const root = await scratch();
    const rule = qualityAfterWrite({
      workspace: root,
      stateRoot: root,
      mode: 'during',
      check: async () => [finding({ tier: 'finish', ruleId: 'copy/em-dash' })],
    });

    const result = await rule.handler(written(['src/app.css']));

    expect(result).toEqual({ continue: true });
  });

  it('records a floor finding for the task of the session', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    const rule = qualityAfterWrite({
      workspace: root,
      stateRoot: root,
      mode: 'during',
      store,
      taskIdForSession: () => 'oa-1',
      check: async () => [finding({ tier: 'floor', ruleId: 'copy/unsourced-claim' })],
    });

    await rule.handler(written(['src/app.css']));

    const floor = await store.openFloor('oa-1');
    expect(floor).toHaveLength(1);
    expect(floor[0]?.ruleId).toBe('copy/unsourced-claim');
  });

  it('records nothing when the session has no task', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    const rule = qualityAfterWrite({
      workspace: root,
      stateRoot: root,
      mode: 'during',
      store,
      check: async () => [finding({ tier: 'floor' })],
    });

    await rule.handler(written(['src/app.css']));

    expect(await store.forTask('oa-1')).toEqual([]);
  });

  it('does nothing in the after mode', async () => {
    const root = await scratch();
    const store = createFindingsStore(root);
    const rule = qualityAfterWrite({
      workspace: root,
      stateRoot: root,
      mode: 'after',
      store,
      taskId: 'oa-1',
      check: async () => [finding({ tier: 'floor' })],
    });

    const result = await rule.handler(written(['src/app.css']));

    expect(result).toEqual({ continue: true });
    expect(await store.forTask('oa-1')).toEqual([]);
  });

  it('does not fail the write when the check throws', async () => {
    const root = await scratch();
    const rule = qualityAfterWrite({
      workspace: root,
      stateRoot: root,
      mode: 'during',
      check: async () => {
        throw new Error('the rule is broken');
      },
    });

    const result = await rule.handler(written(['src/app.css']));

    expect(result).toEqual({ continue: true });
  });

  it('lets a call that touched no file through', async () => {
    const root = await scratch();
    const rule = qualityAfterWrite({ workspace: root, stateRoot: root, mode: 'during' });

    expect(await rule.handler(written([]))).toEqual({ continue: true });
  });
});
