import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '@openagentsy/quality';
import { describe, expect, it } from 'vitest';
import { qualityTools } from './tools.js';

/** A workspace the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-quality-tools-'));
}

/** The findings of an answer of the tool. */
function findingsOf(result: unknown): Finding[] {
  if (typeof result !== 'object' || result === null) return [];
  const list = (result as { findings?: unknown }).findings;
  return Array.isArray(list) ? (list as Finding[]) : [];
}

describe('the quality tool', () => {
  it('returns the findings of every rule, the comment rules included', async () => {
    const root = await scratch();
    await writeFile(
      join(root, 'app.ts'),
      '// Step 1: trim the input\nexport const a = 1;\n',
      'utf8',
    );
    const tools = qualityTools({ workspace: root });
    const tool = tools.oa_quality_check;
    if (tool === undefined) throw new Error('the quality tool is missing');

    const result = await tool.execute(
      { paths: ['app.ts'] },
      { sessionID: 'ses-1', agent: 'oa-builder' },
    );

    const findings = findingsOf(result);
    expect(findings.some((finding) => finding.ruleId === 'comment/step-narration')).toBe(true);
  });

  it('returns the findings of the rules that need no compiler as well', async () => {
    const root = await scratch();
    await writeFile(join(root, 'app.css'), '.a { transition: all 0.2s; }\n', 'utf8');
    const tools = qualityTools({ workspace: root });
    const tool = tools.oa_quality_check;
    if (tool === undefined) throw new Error('the quality tool is missing');

    const result = await tool.execute(
      { paths: ['app.css'] },
      { sessionID: 'ses-1', agent: 'oa-builder' },
    );

    const findings = findingsOf(result);
    expect(findings.some((finding) => finding.ruleId === 'css/no-transition-all')).toBe(true);
  });
});
