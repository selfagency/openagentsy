import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupV2, type V2Context, type V2ContextEvent } from './v2.js';

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
    data?: { sessionID?: string };
  }[],
  directory = root,
) {
  const created: { title?: string; parentID?: string }[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  const agents: { sessionID: string; agent: string }[] = [];
  const contextHooks: ((event: V2ContextEvent) => Promise<void> | void)[] = [];
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
      context: async () => [{ parts: [{ type: 'text', text: 'what the session said' }] }],
      prompt: async (input) => {
        prompts.push({ sessionID: input.sessionID, text: input.text });
        return {};
      },
    },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async () => ({ dispose: async () => {} }),
    },
    permission: {
      hook: async () => ({ dispose: async () => {} }),
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

  return { ctx, created, prompts, agents, contextHooks, done };
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

  it('harvests without the lookup, because the context cannot answer it', async () => {
    // The reason the check is left out: the context the plugin is given has
    // no session lookup, and a message list cannot tell a fresh session from
    // a deleted one. The adapter does not claim a check it did not make.
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
});
