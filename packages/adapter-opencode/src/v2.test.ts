import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupV2, type V2Context, type V2ContextEvent } from './v2.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-'));
  await mkdir(join(root, '.openagentsy'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A context that records what the plugin asked of it. */
function fakeContext(events: { type: string; properties?: { sessionID?: string } }[]) {
  const created: { title?: string; parentID?: string }[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  const contextHooks: ((event: V2ContextEvent) => Promise<void> | void)[] = [];
  const rungs = new Map<string, string>();

  const ctx: V2Context = {
    location: { directory: root },
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
        for (const event of events) yield event;
      },
    },
  };

  return { ctx, created, prompts, contextHooks, rungs };
}

/** Let the event loop turn, so the idle handler can finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('the OpenCode 2 path', () => {
  it('harvests a session that goes idle', async () => {
    const { ctx, created, prompts, contextHooks } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    await setupV2(ctx);

    // The session is known to be the builder's, the way the context hook
    // learns it.
    for (const hook of contextHooks) {
      await hook({ sessionID: 'ses_1', agent: 'oa-builder' });
    }
    await settle();

    expect(created).toHaveLength(1);
    // The archivist session is a child of the session it harvests.
    expect(created[0]?.parentID).toBe('ses_1');
    expect(created[0]?.title).toBe('harvest builder');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe('ses_archivist');
    expect(prompts[0]?.text).toContain('what the session said');
  });

  it('leaves a session it does not know alone', async () => {
    const { ctx, created, prompts } = fakeContext([
      { type: 'session.idle', properties: { sessionID: 'ses_unknown' } },
    ]);
    await setupV2(ctx);
    await settle();

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });
});
