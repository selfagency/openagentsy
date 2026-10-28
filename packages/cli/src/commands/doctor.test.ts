import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectRoots } from '@openagentsy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBuild } from './build.js';
import { formatDoctorReport, runDoctor } from './doctor.js';

/** The two roots of a project that is its own state root. */
function rootsOf(root: string): ProjectRoots {
  return { workspace: root, stateRoot: root };
}

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
  reviewer:
    description: Reviews a change
    mode: subagent
    writes: false
    scope: the diff
    guidance: read it
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: overall
      hardRequirements: [tool_calls]
      costStance: quality_first
    effort:
      startVariant: medium
      ceilingVariant: high
      climbTriggers: [planning]
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-doctor-'));
  await writeFile(join(root, 'roles.yaml'), ROLES, 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The Phase 2 keys, written the way a person writes them: with comments. */
const AGENTSY_CONFIG = `{
  // the Phase 2 keys
  "tasks": { "path": ".work", "prefix": "x-", "idLength": 6 },
  "memory": { "maxTextChars": 120, "inboxLimit": 10 },
  "footprint": {
    "showWarming": false,
    "prefill": true,
    "gridRegion": "FR",
    "localDeviceWatts": [10, 30],
    "models": { "ollama/qwen3:8b": { "totalParamsB": [8, 8], "activeParamsB": [8, 8] } }
  }
}`;

const BEANS_CONFIG = `beans:
  path: .beans-tasks
  prefix: b-
  id_length: 8
`;

describe('the doctor', () => {
  it('names the Lead by the agent a person picks', async () => {
    // The agent id is 'agentsy' and the role key is 'lead'. The doctor used
    // to print 'oa-lead', which is a file that does not exist.
    const report = await runDoctor(rootsOf(root));
    const lead = report.roles.find((role) => role.role === 'lead');
    expect(lead?.agent).toBe('agentsy');
  });

  it('names the other roles by the agent file they are in', async () => {
    const report = await runDoctor(rootsOf(root));
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
    const report = await runDoctor(rootsOf(root));
    expect(report.warnings.some((warning) => warning.includes('compaction is off'))).toBe(true);
  });

  it('says nothing about the compaction when it is left alone', async () => {
    const report = await runDoctor(rootsOf(root));
    expect(report.warnings.some((warning) => warning.includes('compaction'))).toBe(false);
  });

  it('reports every config file OpenCode merges', async () => {
    // OpenCode reads a root config and a config in the config directory, and
    // merges them. A doctor that reads only the root one describes a
    // different system from the one the runtime runs on.
    await writeFile(join(root, 'opencode.json'), JSON.stringify({}), 'utf8');
    await mkdir(join(root, '.opencode'), { recursive: true });
    await writeFile(join(root, '.opencode', 'opencode.jsonc'), JSON.stringify({}), 'utf8');

    const report = await runDoctor(rootsOf(root));
    expect(report.config.paths).toHaveLength(2);
    expect(report.config.paths.some((path) => path.includes('.opencode'))).toBe(true);
  });
});

describe('the config map', () => {
  it('prints the five authorities when they are all there', async () => {
    await writeFile(join(root, 'opencode.json'), JSON.stringify({}), 'utf8');
    await writeFile(join(root, 'openagentsy.jsonc'), AGENTSY_CONFIG, 'utf8');
    await writeFile(join(root, '.beans.yml'), BEANS_CONFIG, 'utf8');
    await writeFile(join(root, 'openagentsy.models.lock.json'), JSON.stringify({}), 'utf8');

    const report = await runDoctor(rootsOf(root));
    expect(report.configMap.authorities).toHaveLength(5);
    expect(report.configMap.authorities.every((authority) => authority.exists)).toBe(true);
    const paths = report.configMap.authorities.map((authority) => authority.path);
    expect(paths).toContain('roles.yaml');
    expect(paths).toContain('openagentsy.jsonc');
    expect(paths).toContain('.beans.yml');
    expect(paths).toContain('openagentsy.models.lock.json');
    expect(paths.some((path) => path.includes('opencode.json'))).toBe(true);

    const printed = formatDoctorReport(report);
    expect(printed).toContain('Config map');
    expect(printed).toContain('roles.yaml');
    expect(printed).toContain('written by a person');
  });

  it('says a file is missing and falls back to the defaults', async () => {
    const report = await runDoctor(rootsOf(root));

    const missing = report.configMap.authorities.filter((authority) => !authority.exists);
    expect(missing.map((authority) => authority.path)).toEqual([
      'opencode.json',
      'openagentsy.jsonc',
      '.beans.yml',
      'openagentsy.models.lock.json',
    ]);

    const effective = report.configMap.effective;
    expect(effective.tasks).toEqual({ path: '.beans', prefix: 'oa-', idLength: 4 });
    expect(effective.memory).toEqual({ maxTextChars: 280, inboxLimit: 50 });
    expect(effective.footprint.showWarming).toBe(true);
    expect(effective.footprint.prefill).toBe(false);
    expect(effective.footprint.gridRegion).toBe('auto');
    expect(effective.footprint.localDeviceWatts).toEqual([25, 60]);
    expect(effective.footprint.models).toEqual([]);
  });

  it('reads the Phase 2 keys out of the openagentsy file', async () => {
    await writeFile(join(root, 'openagentsy.jsonc'), AGENTSY_CONFIG, 'utf8');

    const effective = (await runDoctor(rootsOf(root))).configMap.effective;
    expect(effective.tasks.path).toBe('.work');
    expect(effective.tasks.prefix).toBe('x-');
    expect(effective.tasks.idLength).toBe(6);
    expect(effective.memory.maxTextChars).toBe(120);
    expect(effective.memory.inboxLimit).toBe(10);
    expect(effective.footprint.showWarming).toBe(false);
    expect(effective.footprint.prefill).toBe(true);
    expect(effective.footprint.gridRegion).toBe('FR');
    expect(effective.footprint.localDeviceWatts).toEqual([10, 30]);
    expect(effective.footprint.models).toEqual(['ollama/qwen3:8b']);
  });

  it('lets the beans file outrank the tasks keys, and says so', async () => {
    await writeFile(join(root, 'openagentsy.jsonc'), AGENTSY_CONFIG, 'utf8');
    await writeFile(join(root, '.beans.yml'), BEANS_CONFIG, 'utf8');

    const report = await runDoctor(rootsOf(root));
    expect(report.configMap.effective.tasks.path).toBe('.beans-tasks');
    expect(report.configMap.effective.tasks.prefix).toBe('b-');
    expect(report.configMap.effective.tasks.idLength).toBe(8);
    expect(report.configMap.overlaps.some((overlap) => overlap.includes('.beans.yml'))).toBe(true);
  });
});

/**
 * Render the agent files the way the project was built.
 *
 * There is one target, so the build takes none: the doctor judges the tree
 * against the target the installed files name.
 */
async function buildAgents(root: string): Promise<void> {
  await runBuild({ workspace: root, stateRoot: root, outDir: join(root, '.opencode') });
}

/** The files of a tree, by name and content. */
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await tree(path, `${prefix}${entry.name}/`)));
      continue;
    }
    found.push(`${prefix}${entry.name}: ${await readFile(path, 'utf8')}`);
  }
  return found.sort();
}

describe('the regeneration check', () => {
  it('flags a hand-edited generated agent file with the reconcile command', async () => {
    await buildAgents(root);
    const agentFile = join(root, '.opencode', 'agents', 'oa-builder.md');
    const original = await readFile(agentFile, 'utf8');
    await writeFile(agentFile, `${original}\nhand edited\n`, 'utf8');

    const report = await runDoctor(rootsOf(root));
    const warning = report.warnings.find((entry) => entry.includes('oa-builder.md'));
    expect(warning).toBeDefined();
    expect(warning).toContain('openagentsy build');
    expect(report.regeneration.drifted.join(' ')).toContain('oa-builder.md');
  });

  it('says nothing about a tree the generator wrote', async () => {
    await buildAgents(root);

    const report = await runDoctor(rootsOf(root));
    expect(report.regeneration.drifted).toEqual([]);
    expect(report.warnings.some((entry) => entry.includes('openagentsy build'))).toBe(false);
  });

  it('never writes into the project it is describing', async () => {
    await buildAgents(root);
    const before = await tree(root);

    await runDoctor(rootsOf(root));

    const after = await tree(root);
    expect(after).toEqual(before);
  });

  it('says so when the generated files cannot be read', async () => {
    await buildAgents(root);
    const dir = join(root, '.opencode', 'agents');
    await chmod(dir, 0o000);
    try {
      const report = await runDoctor(rootsOf(root));
      expect(report.regeneration.error).toBeDefined();
      expect(report.regeneration.drifted).toEqual([]);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('does not present a skipped check as a clean tree', async () => {
    // A hand-written agent file beside ours may name no target at all, and
    // then the tree cannot be judged. The doctor says the check did not
    // run, instead of saying the tree is clean.
    await mkdir(join(root, '.opencode', 'agents'), { recursive: true });
    await writeFile(
      join(root, '.opencode', 'agents', 'my-helper.md'),
      '---\ndescription: a helper\nmode: primary\npermission: {}\n---\n\nbody\n',
      'utf8',
    );

    const report = await runDoctor(rootsOf(root));
    expect(report.regeneration.error).toBeDefined();
    expect(report.regeneration.drifted).toEqual([]);
    expect(
      report.warnings.some((entry) => entry.includes('the regeneration check did not run')),
    ).toBe(true);
  });

  it('does not present a skipped check as a clean tree after a hand edit', async () => {
    // The hand edit the check exists for: one file's permission map lost
    // the key the host reads, and the tree can no longer be judged.
    await buildAgents(root);
    const dir = join(root, '.opencode', 'agents');
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      const content = await readFile(file, 'utf8');
      await writeFile(file, content.replace('permissions:', 'permission:'), 'utf8');
    }

    const report = await runDoctor(rootsOf(root));
    expect(report.regeneration.error).toBeDefined();
    expect(report.regeneration.drifted).toEqual([]);
    expect(
      report.warnings.some((entry) => entry.includes('the regeneration check did not run')),
    ).toBe(true);
  });
});
