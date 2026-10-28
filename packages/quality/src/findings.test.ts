import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findingsFile, readFindings, readOpenFloor } from './findings.js';

/** A state root the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-quality-findings-'));
}

/** The file, as the store writes it. */
async function writeFindings(root: string, tasks: Record<string, unknown[]>): Promise<void> {
  const path = findingsFile(root);
  await mkdir(join(root, '.openagentsy', 'quality'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, tasks })}\n`, 'utf8');
}

/** A finding, as the store holds it. */
function finding(tier: 'floor' | 'reflex' | 'finish'): Record<string, unknown> {
  return {
    ruleId: 'css/no-transition-all',
    source: 'hallmark:floor-2',
    tier,
    file: 'src/app.css',
    line: 12,
    message: 'A transition of all moves every property.',
    fix: 'Name the properties to transition instead of all',
  };
}

describe('the findings read path', () => {
  it('reads the findings of every task', async () => {
    const root = await scratch();
    await writeFindings(root, { 'oa-1': [finding('reflex')], 'oa-2': [finding('floor')] });

    const tasks = await readFindings(root);

    expect(Object.keys(tasks).sort()).toEqual(['oa-1', 'oa-2']);
    expect(tasks['oa-2']?.[0]?.tier).toBe('floor');
  });

  it('names the task a floor finding belongs to', async () => {
    const root = await scratch();
    await writeFindings(root, { 'oa-7': [finding('floor'), finding('reflex')] });

    const open = await readOpenFloor(root);

    expect(open).toHaveLength(1);
    expect(open[0]?.taskId).toBe('oa-7');
    expect(open[0]?.finding.ruleId).toBe('css/no-transition-all');
  });

  it('reads a project with no findings file as empty', async () => {
    const root = await scratch();

    expect(await readFindings(root)).toEqual({});
    expect(await readOpenFloor(root)).toEqual([]);
  });

  it('reads a file that cannot be parsed as empty', async () => {
    const root = await scratch();
    await writeFindings(root, {});
    await writeFile(findingsFile(root), 'not json', 'utf8');

    expect(await readFindings(root)).toEqual({});
  });

  it('keeps the file where the store writes it', () => {
    expect(findingsFile('/state')).toBe(join('/state', '.openagentsy', 'quality', 'findings.json'));
  });
});
