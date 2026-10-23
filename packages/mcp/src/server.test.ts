import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let root: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
  if (result.isError) throw new Error(`tool ${name} failed: ${text}`);
  return JSON.parse(text) as unknown;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-board-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.OPENAGENTSY_ROOT = root;

  client = new Client({ name: 'board-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER], env }));
}, 30_000);

afterAll(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

describe('the board server over stdio', () => {
  it('registers the board tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('board_record');
    expect(names).toContain('board_lease');
    expect(names).toContain('board_lease_grant');
    expect(names).toContain('board_budget');
    expect(names).toContain('board_budget_set');
    expect(names.length).toBe(5);
  });

  it('posts a record and reads it back in the inbox', async () => {
    const posted = await call('board_record', {
      op: 'post',
      bean: 'proj-42',
      from: 'builder-2',
      kind: 'status',
      action: 'Added GET /search handler',
      state: 'tests: 14/14 pass',
      confidence: 'verified',
      surprise: 'the index had no title column',
    });
    expect(posted.id).toBeTypeOf('number');

    const inbox = await call('board_record', { op: 'inbox', agent: 'lead' });
    expect(inbox.records).toHaveLength(1);
    expect(inbox.records[0].surprise).toBe('the index had no title column');
    expect(inbox.unread).toBe(1);
  });

  it('marks the record read for the agent that fetched it', async () => {
    const inbox = await call('board_record', { op: 'inbox', agent: 'lead' });
    expect(inbox.records).toHaveLength(0);
  });

  it('keeps a record addressed to another agent out of the inbox', async () => {
    await call('board_record', {
      op: 'post',
      bean: 'proj-42',
      from: 'builder-2',
      kind: 'question',
      action: 'Which file owns the schema?',
      state: 'blocked',
      confidence: 'verified',
      to: 'lead',
    });

    const builder = await call('board_record', { op: 'inbox', agent: 'builder-2' });
    expect(builder.records.some((record: { kind: string }) => record.kind === 'question')).toBe(
      false,
    );

    const lead = await call('board_record', { op: 'inbox', agent: 'lead' });
    expect(lead.records).toHaveLength(1);
    expect(lead.records[0].kind).toBe('question');
  });

  it('refuses to lease a file another agent already holds', async () => {
    const granted = await call('board_lease_grant', {
      bean: 'proj-42',
      agent: 'builder-1',
      globs: ['src/api/**'],
    });
    expect(granted.granted).toHaveLength(1);

    const second = await call('board_lease_grant', {
      bean: 'proj-43',
      agent: 'builder-2',
      globs: ['src/api/**'],
    });
    expect(second.conflicts).toHaveLength(1);
  });

  it('reports a conflict when another agent holds the file', async () => {
    const decision = await call('board_lease', {
      op: 'check',
      path: join(root, 'src/api/search.ts'),
      agent: 'builder-2',
    });
    expect(decision.status).toBe('conflict');
    expect(decision.agent).toBe('builder-1');
  });

  it('reports an unleased path', async () => {
    const decision = await call('board_lease', {
      op: 'check',
      path: join(root, 'src/web/page.ts'),
      agent: 'builder-2',
    });
    expect(decision.status).toBe('unleased');
  });

  it('stops a bean that reached its budget', async () => {
    const budget = await call('board_budget_set', { bean: 'proj-42', tokenLimit: 1000 });
    expect(budget.stopAt).toBe(850);

    const under = await call('board_budget', { op: 'check', bean: 'proj-42', tokensUsed: 100 });
    expect(under.stop).toBe(false);

    const over = await call('board_budget', { op: 'check', bean: 'proj-42', tokensUsed: 900 });
    expect(over.stop).toBe(true);
  });

  it('writes an audit line for every decision', async () => {
    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    const entries = audit
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { policyId: string; effect: string; actor: string });

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => typeof entry.policyId === 'string')).toBe(true);
    expect(entries.some((entry) => entry.effect === 'deny')).toBe(true);
    expect(entries.some((entry) => entry.policyId === 'oa.record.post')).toBe(true);
  });

  it('names the next call when a record is invalid', async () => {
    const result = await client.callTool({
      name: 'board_record',
      arguments: {
        op: 'post',
        bean: '',
        from: 'x',
        kind: 'status',
        action: 'a',
        state: 'b',
        confidence: 'verified',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Next:');
  });

  it('names the field a grouped op needs when it is missing', async () => {
    const result = await client.callTool({
      name: 'board_record',
      arguments: {
        op: 'post',
        bean: 'proj-42',
        from: 'x',
        kind: 'status',
        action: 'a',
        state: 'b',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('confidence');
    expect(text).toContain('Next:');
  });

  it('rejects a record kind that is not one of the five', async () => {
    const result = await client.callTool({
      name: 'board_record',
      arguments: {
        op: 'post',
        bean: 'proj-42',
        from: 'x',
        kind: 'gossip',
        action: 'a',
        state: 'b',
        confidence: 'verified',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('blocker');
  });
});
