import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITIES } from './capabilities.js';
import { evidencePath, recordObservation } from './evidence.js';
import { buildConformanceReport, stateOf } from './report.js';

let root: string;

/** Write a file of the workspace. */
async function write(relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** A workspace that holds the files the probes read. */
async function workspace(): Promise<void> {
  await write(
    'packages/sidebar/src/tui.tsx',
    "Plugin.define({ setup(c) { c.ui.slot({ append: 'sidebar.content' }); } });",
  );
  await write('packages/sidebar/src/usage.ts', 'context.data.session.family(sessionID());');
  await write('packages/sidebar/src/panel.ts', "export const PANEL_NAME = 'openagentsy.panel';");
  await write(
    'packages/adapter-opencode/src/v2.ts',
    [
      "await ctx.permission.hook('evaluate', async () => {});",
      "await ctx.shell.hook('create.before', async () => {});",
      "await ctx.tool.hook('execute.before', async () => {});",
      'const payload = event.data;',
    ].join('\n'),
  );
  await write(
    'packages/adapter-opencode/src/v2-approval.ts',
    "export const SHELL_ACTION = 'shell';",
  );
  await write('packages/adapter-opencode/src/v2-bridge.ts', 'export const bridge = 1;');
  await write('packages/adapter-opencode/src/ledger-bridge.ts', 'export const bridge = 1;');
  await write('packages/hooks/src/shell-env.ts', 'export const policy = 1;');
  await write('packages/ledger/src/ingest.ts', 'const cache = record(tokens.cache);');
  await write('packages/offload/src/router.ts', 'await fetch(`${url}/api/tags`);');
  await write('packages/offload/src/local-detector.ts', "probePath: '/api/tags',");
  await write('.opencode/plugins/openagentsy.js', 'export default {};');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-report-'));
  await workspace();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the conformance report', () => {
  it('reports every capability of the registry', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    expect(report.capabilities.length).toBe(CAPABILITIES.length);
    expect(report.counts.total).toBe(CAPABILITIES.length);
  });

  it('counts the capabilities in each state', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    expect(report.counts.observed).toBe(10);
    expect(report.counts.proven_static).toBe(6);
    expect(report.counts.unverified).toBe(2);
  });

  it('names the state of every capability', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    const states = new Map(report.capabilities.map((entry) => [entry.id, entry.state]));
    expect(states.get('permission-hook-agent')).toBe('observed');
    expect(states.get('session-family')).toBe('proven_static');
    expect(states.get('prompt-insert')).toBe('unverified');
    expect(states.get('opencode-db-schema')).toBe('unverified');
    expect(states.get('local-offload')).toBe('proven_static');
  });

  it('carries the evidence of an observed capability', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    const entry = report.capabilities.find((candidate) => candidate.id === 'permission-hook-agent');
    expect(entry?.evidence.length).toBeGreaterThan(0);
    expect(entry?.evidence[0]?.kind).toBe('live');
    expect(entry?.evidence[0]?.source.ref).toBe('688');
  });

  it('never writes the evidence file', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    expect(report.evidenceOnDisk).toBe(false);
    await expect(readFileOrUndefined(evidencePath(root))).resolves.toBeUndefined();
  });

  it('takes the observation of the file over the seed', async () => {
    await recordObservation(root, {
      capabilityId: 'prompt-insert',
      eventType: 'prompt.inserted',
      at: '2026-10-29T00:00:00.000Z',
      kind: 'live',
      source: { kind: 'board-record', ref: '999', date: '2026-10-29' },
      note: 'a row of the task block put its command into the prompt',
    });
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    const entry = report.capabilities.find((candidate) => candidate.id === 'prompt-insert');
    expect(entry?.state).toBe('observed');
    expect(entry?.evidence[0]?.source.ref).toBe('999');
  });

  it('names the void capabilities of the plan', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    expect(report.voided.length).toBeGreaterThan(0);
    for (const entry of report.voided) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('the state of a capability', () => {
  it('is observed only on a live observation', () => {
    const capability = CAPABILITIES[0];
    expect(capability).toBeDefined();
    if (capability === undefined) return;
    const files = new Map<string, string>();
    expect(stateOf(capability, [], files)).toBe('unverified');
    expect(
      stateOf(
        capability,
        [
          {
            capabilityId: capability.id,
            eventType: 'x',
            at: '2026-10-28T00:00:00.000Z',
            kind: 'schema',
            source: { kind: 'declaration', ref: 'x', date: '2026-10-28' },
            note: 'x',
          },
        ],
        files,
      ),
    ).toBe('proven_static');
    expect(
      stateOf(
        capability,
        [
          {
            capabilityId: capability.id,
            eventType: 'x',
            at: '2026-10-28T00:00:00.000Z',
            kind: 'live',
            source: { kind: 'board-record', ref: 'x', date: '2026-10-28' },
            note: 'x',
          },
        ],
        files,
      ),
    ).toBe('observed');
  });
});

describe('the plugin-order warnings', () => {
  it('names the plugin that is loaded beside the OpenAgentsy one', async () => {
    await write(
      'opencode.json',
      '{ "plugin": [".opencode/plugins/openagentsy.js", "some-guard"] }',
    );
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    const warning = report.pluginOrderWarnings.find((entry) => entry.plugin === 'some-guard');
    expect(warning?.detail).toContain('after the OpenAgentsy checks');
  });

  it('names the YAML hook plugin', async () => {
    await write('.opencode/plugins/hooks.yaml', 'hooks: []');
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    const warning = report.pluginOrderWarnings.find((entry) => entry.plugin.endsWith('hooks.yaml'));
    expect(warning?.detail).toContain('YAML hook plugin');
  });

  it('says nothing about the OpenAgentsy plugin itself', async () => {
    await write('opencode.json', '{ "plugin": [".opencode/plugins/openagentsy.js"] }');
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    expect(report.pluginOrderWarnings).toEqual([]);
  });

  it('has no warning in a project with no other plugin', async () => {
    const report = await buildConformanceReport({ workspace: root, stateRoot: root });
    expect(report.pluginOrderWarnings).toEqual([]);
  });
});

/** Read a file, or nothing when it is not there. */
async function readFileOrUndefined(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').then(
    (text) => text,
    () => undefined,
  );
}
