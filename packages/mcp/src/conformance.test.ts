import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFORMANCE_TOOL_NAME, createConformanceTools } from './conformance.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-conformance-mcp-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the conformance tool', () => {
  it('is named the way the other tools are named', () => {
    expect(CONFORMANCE_TOOL_NAME).toBe('oa_conformance_report');
  });

  it('says what it does, and that it never writes', () => {
    const tools = createConformanceTools({ workspace: root, stateRoot: root });
    expect(tools.oa_conformance_report.description).toContain('proven, observed or unverified');
    expect(tools.oa_conformance_report.description).toContain('never writes');
  });

  it('reports the capabilities of the project', async () => {
    const tools = createConformanceTools({ workspace: root, stateRoot: root });
    const result = await tools.oa_conformance_report.handler({});
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? '{}');
    expect(body.counts.total).toBe(18);
    expect(body.counts.observed).toBe(10);
    expect(body.capabilities.length).toBe(18);
  });

  it('reports the evidence of an observed capability with its source', async () => {
    const tools = createConformanceTools({ workspace: root, stateRoot: root });
    const result = await tools.oa_conformance_report.handler({});
    const body = JSON.parse(result.content[0]?.text ?? '{}');
    const capability = body.capabilities.find(
      (entry: { id: string }) => entry.id === 'permission-hook-agent',
    );
    expect(capability.state).toBe('observed');
    expect(capability.evidence[0].source.ref).toBe('688');
  });

  it('names the void capabilities and the plugin-order warnings', async () => {
    const tools = createConformanceTools({ workspace: root, stateRoot: root });
    const result = await tools.oa_conformance_report.handler({});
    const body = JSON.parse(result.content[0]?.text ?? '{}');
    expect(body.voided.length).toBe(11);
    expect(body.pluginOrderWarnings).toEqual([]);
  });
});
