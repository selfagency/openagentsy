import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';
import { formatConformanceReport, runConformance } from './conformance.js';

let root: string;
let written: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-conformance-cli-'));
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('the conformance report', () => {
  it('reports every capability of the registry, with its state', async () => {
    const report = await runConformance({ workspace: root, stateRoot: root });
    expect(report.capabilities.length).toBe(18);
    // The root of the test holds no project, so the local offload router is
    // not there and its capability has no static proof. The ten observed
    // capabilities carry the seed, and the seed is in the package.
    expect(report.counts.observed).toBe(10);
    expect(report.counts.proven_static).toBe(5);
    expect(report.counts.unverified).toBe(3);
  });

  it('prints the state of every capability', async () => {
    const report = await runConformance({ workspace: root, stateRoot: root });
    const text = formatConformanceReport(report);
    expect(text).toContain('permission-hook-agent');
    expect(text).toContain('observed');
    expect(text).toContain('unverified');
    expect(text).toContain('proven_static');
  });

  it('prints the evidence of an observed capability, and where it came from', async () => {
    const report = await runConformance({ workspace: root, stateRoot: root });
    const text = formatConformanceReport(report);
    expect(text).toContain('board-record 688');
    expect(text).toContain('the raw permission event of a live 2.1.3 server carried agent build');
  });

  it('says so when a capability has no observation', async () => {
    const report = await runConformance({ workspace: root, stateRoot: root });
    const text = formatConformanceReport(report);
    expect(text).toContain('no observation');
  });

  it('names the plugin-order warnings and the void capabilities', async () => {
    const report = await runConformance({ workspace: root, stateRoot: root });
    const text = formatConformanceReport(report);
    expect(text).toContain('plugin-order warnings: 0');
    expect(text).toContain('void capabilities: 11');
  });
});

describe('the conformance command', () => {
  it('prints the report', async () => {
    const code = await main(['conformance', '--root', root]);
    expect(code).toBe(0);
    const output = written.join('');
    expect(output).toContain('OpenAgentsy conformance');
    expect(output).toContain('permission-hook-agent');
  });

  it('prints the report as JSON when it is asked to', async () => {
    const code = await main(['conformance', '--root', root, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(written.join(''));
    expect(report.counts.total).toBe(18);
    expect(report.capabilities[0].state).toBeDefined();
  });
});
