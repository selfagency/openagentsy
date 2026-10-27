import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeLedger, openLedger, recordAssistantMessage } from '@openagentsy/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let root: string;
let client: Client;

/**
 * A stand-in for the System One service.
 *
 * The board tool talks to the real service in a project that has a key. In a
 * test the answer has to come from somewhere, and the somewhere is here.
 */
async function startFakeJev(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      const sent = JSON.parse(body) as { questions: Record<string, unknown> };
      const name = Object.keys(sent.questions)[0] ?? 'dispatch';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: {
            [name]: {
              type: 'choice',
              choice: 'solo',
              confidence: 0.97,
              probabilities: { solo: 0.97, 'fanout-read': 0.03 },
            },
          },
          usage: { input_tokens: 120, output_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
  if (result.isError) throw new Error(`tool ${name} failed: ${text}`);
  return JSON.parse(text) as unknown;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-board-'));
  // The roles file is what the board knows the agents by.
  await writeFile(
    join(root, 'roles.yaml'),
    `version: 1
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
`,
    'utf8',
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.OPENAGENTSY_ROOT = root;
  // The board in a test has no key, so the classification tool says so
  // instead of calling a service.
  delete env.TYPESAFE_API_KEY;

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
    expect(names).toContain('board_lease_revoke');
    expect(names).toContain('board_budget');
    expect(names).toContain('board_budget_set');
    expect(names).toContain('board_classify');
    // The lesson tools are not board tools: an agent may propose a lesson,
    // and only a person may decide one.
    expect(names).toContain('oa_lesson_propose');
    expect(names).toContain('oa_lesson_decide');
    expect(names.length).toBe(9);
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

  it('refuses a delegation that has no return condition', async () => {
    // A delegated item names the agent that does the work and what has to
    // come back (plan 8.7). The board refuses the half that is missing.
    const result = await client.callTool({
      name: 'board_record',
      arguments: {
        op: 'post',
        bean: 'proj-42',
        from: 'lead',
        kind: 'contract',
        action: 'Dispatched the search handler',
        state: 'the builder owns it',
        confidence: 'verified',
        to: 'oa-builder',
        contract: {
          id: 'search',
          owner: 'oa-builder',
          status: 'running',
          bean: 'proj-42',
        },
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('return condition');
  });

  it('refuses a delegation that has no owner', async () => {
    const result = await client.callTool({
      name: 'board_record',
      arguments: {
        op: 'post',
        bean: 'proj-42',
        from: 'lead',
        kind: 'contract',
        action: 'Dispatched the search handler',
        state: 'the builder owns it',
        confidence: 'verified',
        to: 'oa-builder',
        contract: {
          id: 'search',
          returnCondition: 'a completion record naming the file',
          status: 'running',
          bean: 'proj-42',
        },
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('owner');
  });

  it('posts a delegation that has both halves, and an interface that has neither', async () => {
    const dispatch = await call('board_record', {
      op: 'post',
      bean: 'proj-42',
      from: 'lead',
      kind: 'contract',
      action: 'Dispatched the search handler',
      state: 'the builder owns it',
      confidence: 'verified',
      to: 'oa-builder',
      contract: {
        id: 'search',
        owner: 'oa-builder',
        returnCondition: 'a completion record naming the file',
        status: 'running',
        bean: 'proj-42',
      },
    });
    expect(dispatch.id).toBeTypeOf('number');

    // An interface is not a delegation: it names no owner, and the board
    // does not ask one of it.
    const contract = await call('board_record', {
      op: 'post',
      bean: 'proj-42',
      from: 'lead',
      kind: 'contract',
      action: 'The search interface is fixed',
      state: 'GET /search -> [{id,title,url}]',
      confidence: 'verified',
      to: 'oa-builder',
      contract: { 'GET /search': '-> [{id,title,url}]' },
    });
    expect(contract.id).toBeTypeOf('number');
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

  it('takes a lease back for an agent that is not using it', async () => {
    await call('board_lease_grant', {
      bean: 'proj-42',
      agent: 'builder-1',
      globs: ['src/revoked/**'],
    });
    const revoked = await call('board_lease_revoke', { glob: 'src/revoked/**' });
    expect(revoked.revoked).toBe(true);
    expect(revoked.lease.agent).toBe('builder-1');

    // The path is free again.
    const decision = await call('board_lease', {
      op: 'check',
      path: join(root, 'src/revoked/search.ts'),
      agent: 'builder-2',
    });
    expect(decision.status).toBe('unleased');
  });

  it('says so when there is no lease to take back', async () => {
    const revoked = await call('board_lease_revoke', { glob: 'nothing/here/**' });
    expect(revoked.revoked).toBe(false);
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

  it('stops a bean on the usage the ledger measured', async () => {
    // The exit test of 2b: the ledger counted the tokens and nobody reported
    // them. The check reads the ledger, so the verdict is the measured one
    // even though the caller reports nothing.
    const ledger = openLedger(root);
    try {
      recordAssistantMessage(
        ledger,
        {
          id: 'msg-ledger-1',
          sessionID: 'ses-ledger-1',
          providerID: 'anthropic',
          modelID: 'claude-sonnet',
          tokens: { input: 100, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        {
          rootSessionId: 'ses-ledger-1',
          role: 'builder',
          activeTaskId: 'proj-ledger',
          ts: new Date().toISOString(),
        },
      );
    } finally {
      closeLedger(ledger);
    }

    await call('board_budget_set', { bean: 'proj-ledger', tokenLimit: 1000 });

    const decision = await call('board_budget', { op: 'check', bean: 'proj-ledger' });
    expect(decision.tokensUsed).toBe(1000);
    expect(decision.stop).toBe(true);
    // The yellow window is 80 percent of the cap, so the warning is owed
    // once, before the stop.
    expect(decision.warning).toContain('yellow window');
  });

  it('lists the measured usage beside the deprecated self-report', async () => {
    // The split-brain the fault case caught: op=list used to show only the
    // self-report, so a lead reading it saw a bean at zero while the check
    // stopped it on the ledger's number. The list now shows both.
    const ledger = openLedger(root);
    try {
      recordAssistantMessage(
        ledger,
        {
          id: 'msg-list-1',
          sessionID: 'ses-list-1',
          providerID: 'anthropic',
          modelID: 'claude-sonnet',
          tokens: { input: 100, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        {
          rootSessionId: 'ses-list-1',
          role: 'builder',
          activeTaskId: 'proj-list',
          ts: new Date().toISOString(),
        },
      );
    } finally {
      closeLedger(ledger);
    }

    await call('board_budget_set', { bean: 'proj-list', tokenLimit: 2000 });

    const { budgets } = await call('board_budget', { op: 'list' });
    const mine = budgets.find((b: { bean: string }) => b.bean === 'proj-list');
    expect(mine.measured).toBe(1000);
    expect(mine.tokensUsed).toBe(0);
  });

  it('keeps the self-reported usage working for the old clients', async () => {
    await call('board_budget_set', { bean: 'proj-self', tokenLimit: 1000 });
    const decision = await call('board_budget', {
      op: 'check',
      bean: 'proj-self',
      tokensUsed: 900,
    });
    expect(decision.tokensUsed).toBe(900);
    expect(decision.stop).toBe(true);
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
        from: 'builder',
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

  it('says it cannot classify when the board has no System One key', async () => {
    const decision = await call('board_classify', { request: 'fix a typo in README.md' });
    expect(decision.available).toBe(false);
    expect(decision.reason).toContain('TYPESAFE_API_KEY');
    expect(decision.profiles).toEqual(['solo', 'fanout-read', 'parallel-write', 'design-options']);
  });
});

describe('the board with a System One key', () => {
  let keyed: Client;
  let fake: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    fake = await startFakeJev();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.OPENAGENTSY_ROOT = root;
    env.TYPESAFE_API_KEY = 'test-key';
    env.OPENAGENTSY_JEV_ENDPOINT = fake.url;

    keyed = new Client({ name: 'board-test-keyed', version: '0.1.0' });
    await keyed.connect(new StdioClientTransport({ command: 'node', args: [SERVER], env }));
  }, 30_000);

  afterAll(async () => {
    await keyed.close();
    await fake.close();
  });

  it('classifies a request into the dispatch profiles', async () => {
    const result = await keyed.callTool({
      name: 'board_classify',
      arguments: { request: 'fix a typo in README.md' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    const decision = JSON.parse(text) as {
      available: boolean;
      profile: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    expect(decision.available).toBe(true);
    expect(decision.profile).toBe('solo');
    expect(decision.confidence).toBe(0.97);
    expect(decision.probabilities['fanout-read']).toBe(0.03);
  });
  it('refuses a record from a name the board does not know', async () => {
    // The board cannot verify who is calling it, so the name is checked
    // against the roles file. A name outside it is a record nobody can
    // attribute.
    await expect(
      call('board_record', {
        op: 'post',
        bean: 'proj-42',
        from: 'definitely-not-an-agent',
        kind: 'status',
        action: 'did a thing',
        state: 'it is done',
        confidence: 'verified',
      }),
    ).rejects.toThrow(/does not know an agent/);
  });

  it('accepts every spelling of an agent the board knows', async () => {
    for (const from of ['builder', 'oa-builder', 'agentsy', 'lead']) {
      const posted = await call('board_record', {
        op: 'post',
        bean: 'proj-42',
        from,
        kind: 'status',
        action: 'did a thing',
        state: 'it is done',
        confidence: 'verified',
      });
      expect(posted.id).toBeGreaterThan(0);
    }
  });
});
