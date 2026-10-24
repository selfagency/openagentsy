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
  events: { type: string; properties?: { sessionID?: string } }[],
  directory = root,
) {
  const created: { title?: string; parentID?: string }[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
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
      switchAgent: async () => {},
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

  return { ctx, created, prompts, contextHooks, done };
}

describe('the OpenCode 2 path', () => {
  it('harvests a session that goes idle', async () => {
    const { ctx, created, prompts, contextHooks, done } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);

    // The session is known to be the builder's, the way the context hook
    // learns it.
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await done;

    expect(created).toHaveLength(1);
    // The archivist session is a child of the session it harvests.
    expect(created[0]?.parentID).toBe('ses_1');
    expect(created[0]?.title).toBe('harvest builder');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe('ses_archivist');
    expect(prompts[0]?.text).toContain('what the session said');
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
