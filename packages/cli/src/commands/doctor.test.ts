import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';

let root: string;

const ROLES = `
version: 1
protectedPaths: []
defaults:
  permissions: {}
roles:
  lead:
    agentName: agentsy
    description: Plans the work
    mode: primary
    writes: false
    scope: the plan
    guidance: delegate
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: agentic
      hardRequirements: [tool_calls]
      costStance: quality_first
    effort:
      startVariant: medium
      ceilingVariant: high
      climbTriggers: [planning]
  builder:
    description: Implements a bean
    mode: subagent
    writes: true
    scope: leased files
    guidance: test it
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: low
      ceilingVariant: high
      climbTriggers: [test_failed_twice]
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-doctor-'));
  await writeFile(join(root, 'roles.yaml'), ROLES, 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the doctor', () => {
  it('names the Lead by the agent a person picks', async () => {
    // The agent id is 'agentsy' and the role key is 'lead'. The doctor used
    // to print 'oa-lead', which is a file that does not exist.
    const report = await runDoctor(root);
    const lead = report.roles.find((role) => role.role === 'lead');
    expect(lead?.agent).toBe('agentsy');
  });

  it('names the other roles by the agent file they are in', async () => {
    const report = await runDoctor(root);
    const builder = report.roles.find((role) => role.role === 'builder');
    expect(builder?.agent).toBe('oa-builder');
  });

  it('warns when the compaction is off and nothing shrinks the context', async () => {
    // Compaction off is right for a memory integration, and there is none.
    await writeFile(
      join(root, 'opencode.json'),
      JSON.stringify({ compaction: { auto: false } }),
      'utf8',
    );
    const report = await runDoctor(root);
    expect(report.warnings.some((warning) => warning.includes('compaction is off'))).toBe(true);
  });

  it('says nothing about the compaction when it is left alone', async () => {
    const report = await runDoctor(root);
    expect(report.warnings.some((warning) => warning.includes('compaction'))).toBe(false);
  });

  it('reports every config file OpenCode merges', async () => {
    // OpenCode reads a root config and a config in the config directory, and
    // merges them. A doctor that reads only the root one describes a
    // different system from the one the runtime runs on.
    await writeFile(join(root, 'opencode.json'), JSON.stringify({}), 'utf8');
    await mkdir(join(root, '.opencode'), { recursive: true });
    await writeFile(join(root, '.opencode', 'opencode.jsonc'), JSON.stringify({}), 'utf8');

    const report = await runDoctor(root);
    expect(report.config.paths).toHaveLength(2);
    expect(report.config.paths.some((path) => path.includes('.opencode'))).toBe(true);
  });
});
