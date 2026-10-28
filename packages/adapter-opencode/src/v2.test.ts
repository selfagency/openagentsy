import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, createRecord, migrate, openDatabase } from '@openagentsy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupV2,
  type V2Context,
  type V2ContextEvent,
  type V2PermissionEvent,
  type V2ToolEvent,
} from './v2.js';

let root: string;

const ROLES = `
version: 1
protectedPaths: []
defaults:
  permissions: {}
roles:
  lead:
    description: Runs the board
    mode: primary
    writes: false
    scope: the board
    guidance: report honestly
    agentName: agentsy
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: default
      ceilingVariant: high
      climbTriggers: []
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
      startVariant: default
      ceilingVariant: high
      climbTriggers: []
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-'));
  await writeFile(join(root, 'roles.yaml'), ROLES, 'utf8');
  await mkdir(join(root, '.openagentsy'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A context that records what the plugin asked of it. */
function fakeContext(
  events: {
    type: string;
    properties?: { sessionID?: string };
    data?: { sessionID?: string; text?: string };
  }[],
  directory = root,
  messages: { parts?: { type: string; text?: string }[] }[] = [
    { parts: [{ type: 'text', text: 'what the session said' }] },
  ],
) {
  const created: { title?: string; parentID?: string }[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  const agents: { sessionID: string; agent: string }[] = [];
  const removed: string[] = [];
  const contextHooks: ((event: V2ContextEvent) => Promise<void> | void)[] = [];
  const toolHooks: { name: string; callback: (event: V2ToolEvent) => Promise<void> | void }[] = [];
  const permissionHooks: {
    name: string;
    callback: (event: V2PermissionEvent) => Promise<void> | void;
  }[] = [];
  // The sessions the janitor reads. The old harvest children are here.
  const listed: unknown[] = [
    {
      id: 'ses_old',
      title: 'harvest builder',
      agent: 'oa-archivist',
      time: { created: Date.now() - 8 * 24 * 60 * 60 * 1000 },
    },
    {
      id: 'ses_new',
      title: 'harvest builder',
      agent: 'oa-archivist',
      time: { created: Date.now() - 1000 },
    },
    {
      id: 'ses_person',
      title: 'a session of a person',
      agent: 'oa-archivist',
      time: { created: Date.now() - 8 * 24 * 60 * 60 * 1000 },
    },
  ];
  // The subscription ends when the events run out, and the idle handler has
  // finished by then: the loop awaits the body before it asks for the next
  // event. A timer would be a guess.
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const ctx: V2Context = {
    location: { directory },
    session: {
      hook: async (_name, callback) => {
        contextHooks.push(callback);
        return { dispose: async () => {} };
      },
      switchModel: async () => {},
      switchAgent: async (input) => {
        agents.push({ sessionID: input.sessionID, agent: input.agent });
      },
      create: async (input) => {
        created.push({
          ...(input?.title !== undefined ? { title: input.title } : {}),
          ...(input?.parentID !== undefined ? { parentID: input.parentID } : {}),
        });
        return { id: 'ses_archivist' };
      },
      context: async () => messages,
      prompt: async (input) => {
        prompts.push({ sessionID: input.sessionID, text: input.text });
        return {};
      },
      list: async () => listed,
      remove: async (input) => {
        removed.push(input.sessionID);
        return {};
      },
    },
    tool: {
      hook: async (name, callback) => {
        toolHooks.push({ name, callback });
        return { dispose: async () => {} };
      },
      transform: async () => ({ dispose: async () => {} }),
    },
    permission: {
      hook: async (name, callback) => {
        permissionHooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: async function* () {
        try {
          for (const event of events) yield event;
        } finally {
          finish();
        }
      },
    },
  };

  return { ctx, created, prompts, agents, removed, contextHooks, toolHooks, permissionHooks, done };
}

/** The tool hook of a name, once the plugin registered it. */
function toolHook(
  toolHooks: { name: string; callback: (event: V2ToolEvent) => Promise<void> | void }[],
  name: string,
): (event: V2ToolEvent) => Promise<void> | void {
  const found = toolHooks.find((hook) => hook.name === name);
  if (found === undefined) throw new Error(`the plugin registered no ${name} hook`);
  return found.callback;
}

/** The permission hook, once the plugin registered it. */
function permissionHook(
  permissionHooks: {
    name: string;
    callback: (event: V2PermissionEvent) => Promise<void> | void;
  }[],
): (event: V2PermissionEvent) => Promise<void> | void {
  const found = permissionHooks.find((hook) => hook.name === 'evaluate');
  if (found === undefined) throw new Error('the plugin registered no permission hook');
  return found.callback;
}

describe('the OpenCode 2 path', () => {
  it('launches the archivist when a session goes idle', async () => {
    // The archivist is the one that turns what a session learned into
    // candidate memories, and the adapter is the only part that knows a
    // session ended. The V2 path does the same thing the V1 path does.
    const { ctx, created, prompts, agents, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);

    // The session is known to be the builder's, the way the context hook
    // learns it.
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    // The archivist stands on its own: a child of the harvested session dies
    // with it, and the delete is a delete the server does without asking.
    expect(created).toEqual([{ title: 'harvest builder' }]);
    // The agent of a turn is the agent of its session, so the archivist is
    // named on the session before the packet is handed over.
    expect(agents).toEqual([{ sessionID: 'ses_archivist', agent: 'oa-archivist' }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe('ses_archivist');
    // The packet carries what the session said and where a candidate goes.
    expect(prompts[0]?.text).toContain('what the session said');
    expect(prompts[0]?.text).toContain('the candidate in the action');
  });

  it('launches the archivist when the execution of a session ends', async () => {
    // The 2.x server says a turn is over with the execution events and says
    // nothing with the v1 `session.idle`: the event stream of a live
    // OpenCode 2.2.0 server carried `session.execution.started`,
    // `session.execution.succeeded` and `session.execution.failed`, and no
    // idle event at all (measured 2026-10-27). The plugin context hands the
    // plugin the server's own event shape, so the session is under `data`.
    const { ctx, created, prompts, contextHooks, done } = fakeContext([
      { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    expect(created).toEqual([{ title: 'harvest builder' }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe('ses_archivist');
  });

  it('does not launch the archivist when the execution of a session starts', async () => {
    // The start of an execution is not the end of a turn, and a session that
    // is only starting has nothing to distil.
    const { ctx, created, prompts, contextHooks, done } = fakeContext([
      { type: 'session.execution.started', data: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('does not launch the archivist when the harvest is off', async () => {
    // The harvest is a real agent run per finished session, and a project
    // that does not want it says so in a file.
    await writeFile(join(root, '.openagentsy', 'harvest'), 'off\n', 'utf8');

    const { ctx, created, prompts, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('does not harvest the Lead, which keeps its own history', async () => {
    const { ctx, created, prompts, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_lead' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_lead', agent: 'agentsy' });
    }
    await done;

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('harvests without the lookup, because the harvest does not need one', async () => {
    // The reason the check is left out: the archivist stands on its own, so
    // the cascade the lookup guarded against does not happen. The adapter
    // does not claim a check it did not make.
    const { ctx, created, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    expect('get' in ctx.session).toBe(false);
    expect(created).toHaveLength(1);
  });

  it('leaves a session it does not know alone', async () => {
    const { ctx, created, prompts, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_unknown' } },
    ]);
    await setupV2(ctx);
    await done;

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('puts a failure on the record instead of killing the subscription', async () => {
    // The rung file cannot be written, so the idle handler throws. The
    // subscription has to survive it: a dead loop is a silent stall, which
    // is the one failure the fault cases exist to catch.
    // The builder climbed a rung, so the idle handler has a rung to give
    // back, and the file cannot be written.
    const rungs = join(root, '.openagentsy', 'rungs.json');
    await writeFile(
      rungs,
      JSON.stringify({ ses_1: { role: 'builder', rungIndex: 1, reason: 'x', updatedAt: 'now' } }),
      'utf8',
    );
    await chmod(rungs, 0o444);

    const { ctx, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('oa.events.failed');
  });

  it('deletes the harvest children that are older than a week', async () => {
    // The janitor is the one place the plugin deletes a session, and the
    // rule is a conjunction: the title, the agent and the age. A session of
    // a person is never one of ours.
    const { ctx, removed, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;
    // The prune runs beside the harvest and is never awaited.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(removed).toEqual(['ses_old']);
  });

  it('records a report that contradicts the board', async () => {
    // The report is the end of the round, and the board holds the status the
    // round was persisted with. A report that claims another status is a
    // finding, and the finding goes on the record.
    await writeFile(join(root, '.openagentsy', 'harvest'), 'off', 'utf8');
    const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
    migrate(db);
    createRecord(db, {
      bean: '2c-2',
      kind: 'status',
      from: 'agentsy',
      action: 'the round is over',
      state: 'complete',
      confidence: 'verified',
    });
    closeDatabase(db);

    const { ctx, contextHooks, done } = fakeContext(
      [{ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } }],
      root,
      [{ parts: [{ type: 'text', text: 'The round status is running.' }] }],
    );
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'agentsy' });
    }
    await done;

    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('oa.round.status');
    expect(audit).toContain('complete');
  });
});

describe('the rules of the package on the v2 path', () => {
  it('refuses a call that skips the git hooks', async () => {
    // The seven blocking rules of the package run in the V2 tool hook, and
    // a rule that blocks a call blocks it there: the V2 before hook stops
    // the call when it throws (measured on a live OpenCode 2.2.0 server).
    const { ctx, toolHooks } = fakeContext([]);
    await setupV2(ctx);

    const before = toolHook(toolHooks, 'execute.before');
    await expect(
      before({
        tool: 'shell',
        sessionID: 'ses_1',
        id: 'call_1',
        input: { command: 'git commit -n -m wip' },
      }),
    ).rejects.toThrow(/Git hooks/);
  });

  it('lets a call through that breaks no rule', async () => {
    const { ctx, toolHooks } = fakeContext([]);
    await setupV2(ctx);

    const before = toolHook(toolHooks, 'execute.before');
    await expect(
      before({
        tool: 'shell',
        sessionID: 'ses_1',
        id: 'call_1',
        input: { command: 'echo hello' },
      }),
    ).resolves.toBeUndefined();
  });

  it('runs the quality check after a write', async () => {
    // The quality check is the whole phase-2d line, and it needs the after
    // hook of the tool. The rules it runs are the ones that need no
    // compiler, so the plugin does not carry the compiler.
    await writeFile(join(root, 'style.css'), '.a { transition: all 0.2s; }\n', 'utf8');
    const { ctx, toolHooks } = fakeContext([]);
    await setupV2(ctx);

    const after = toolHook(toolHooks, 'execute.after');
    const result = { content: [{ type: 'text', text: 'the file was written' }] };
    await after({
      tool: 'write',
      sessionID: 'ses_1',
      id: 'call_1',
      input: { path: 'style.css', content: '.a { transition: all 0.2s; }' },
      status: 'completed',
      result,
    });

    expect(result.content[0]?.text).toContain('transition');
  });
});

describe('the permission decisions on the v2 path', () => {
  it('asks a person about a command the project named', async () => {
    // The V1 path wrote the commands into the permission map of the host.
    // The V2 path has no map to write, so the approval is asked for where
    // the decision is made.
    await writeFile(
      join(root, 'openagentsy.jsonc'),
      JSON.stringify({ hooks: { approvalFor: ['git push'] } }),
      'utf8',
    );
    const { ctx, permissionHooks } = fakeContext([]);
    await setupV2(ctx);

    const evaluate = permissionHook(permissionHooks);
    const event: V2PermissionEvent = {
      sessionID: 'ses_1',
      agent: 'oa-builder',
      action: 'shell',
      resources: ['git push --force origin main'],
      effect: 'allow',
    };
    await evaluate(event);

    expect(event.effect).toBe('ask');
    expect(event.message).toContain('git push');
  });

  it('leaves a command nobody asked about alone', async () => {
    const { ctx, permissionHooks } = fakeContext([]);
    await setupV2(ctx);

    const evaluate = permissionHook(permissionHooks);
    const event: V2PermissionEvent = {
      sessionID: 'ses_1',
      agent: 'oa-builder',
      action: 'shell',
      resources: ['echo hello'],
      effect: 'allow',
    };
    await evaluate(event);

    expect(event.effect).toBe('allow');
  });

  it('takes the agent of the session when the event names none', async () => {
    // The permission event carries the agent of the request, and a request
    // that names no agent takes the agent of the session the context hook
    // resolved. A write with neither is refused.
    const { ctx, permissionHooks, contextHooks } = fakeContext([]);
    await setupV2(ctx);
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }

    const evaluate = permissionHook(permissionHooks);
    const event: V2PermissionEvent = {
      sessionID: 'ses_1',
      action: 'edit',
      resources: ['src/index.ts'],
      effect: 'allow',
    };
    await evaluate(event);

    // No lease covers the path, so the write is refused, and the refusal
    // names the agent of the session: the rule ran with an agent.
    expect(event.effect).toBe('deny');
    expect(event.message).toContain('lease');
  });

  it('refuses a write when neither the event nor the session names an agent', async () => {
    const { ctx, permissionHooks } = fakeContext([]);
    await setupV2(ctx);

    const evaluate = permissionHook(permissionHooks);
    const event: V2PermissionEvent = {
      sessionID: 'ses_1',
      action: 'edit',
      resources: ['src/index.ts'],
      effect: 'allow',
    };
    await evaluate(event);

    expect(event.effect).toBe('deny');
    expect(event.message).toContain('named no agent');
  });
});

describe('the output checks on the v2 path', () => {
  it('records the findings of a reply', async () => {
    // The V2 path has no `experimental.text.complete` hook: the text of a
    // reply arrives with the `session.text.ended` event, which is after the
    // reply is out. The checks run on that text and their findings are
    // recorded.
    const { ctx, done } = fakeContext([
      {
        type: 'session.text.ended',
        data: { sessionID: 'ses_1', text: 'Great point, you are absolutely right.' },
      },
    ]);
    await setupV2(ctx);
    await done;

    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('oa.output.flagged');
  });
});
