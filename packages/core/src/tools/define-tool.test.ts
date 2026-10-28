import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  type ToolCtx,
  type ToolDef,
  toolMap,
  type V1ToolCtx,
  v2Tool,
} from './define-tool.js';
import type { ToolDefinition } from './tool.js';

/**
 * Whether two types are the same, checked by the compiler.
 *
 * The check asks whether the two types are interchangeable in both
 * directions, so a type that is wider than the other does not pass.
 */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const definition = defineTool({
  description: 'Climb one rung on the reasoning effort ladder.',
  args: z.object({
    reason: z.string().describe('Why you are climbing. Name the trigger that fired.'),
  }),
  execute: async (args, context) => `climbed for ${args.reason} in ${context.sessionID}`,
});

/** The context the V1 plugin hands to a tool. */
const v1Context = {
  sessionID: 'ses_1',
  messageID: 'msg_1',
  agent: 'oa-builder',
  directory: '/tmp/project',
  worktree: '/tmp/project',
  abort: new AbortController().signal,
  metadata: () => {},
};

/** The tool of a map, or a failure that says which one is missing. */
function toolOf(map: Record<string, ToolDefinition>, name: string): ToolDefinition {
  const entry = map[name];
  if (!entry) throw new Error(`the map has no tool named ${name}`);
  return entry;
}

describe('the tool definition helper', () => {
  it('keeps the definition it is given', () => {
    expect(defineTool(definition)).toBe(definition);
  });

  it('builds the V1 tool map out of the definitions', async () => {
    const map = toolMap({ oa_test: definition });
    const entry = toolOf(map, 'oa_test');

    expect(entry.description).toBe('Climb one rung on the reasoning effort ladder.');
    expect(Object.keys(entry.args)).toEqual(['reason']);
    await expect(entry.execute({ reason: 'a test failed twice' }, v1Context)).resolves.toBe(
      'climbed for a test failed twice in ses_1',
    );
  });

  it('gives the V2 plugin the JSON schema of the args', () => {
    const entry = v2Tool('oa_test', definition);

    expect(entry.name).toBe('oa_test');
    expect(entry.description).toBe('Climb one rung on the reasoning effort ladder.');
    expect(entry.input).toEqual({
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why you are climbing. Name the trigger that fired.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    });
  });

  it('wraps the result of the V2 tool in content', async () => {
    const entry = v2Tool('oa_test', definition);

    await expect(
      entry.execute({ reason: 'a test failed twice' }, { sessionID: 'ses_1', agent: 'oa-builder' }),
    ).resolves.toEqual({ content: 'climbed for a test failed twice in ses_1' });
  });

  it('gives the definition the agent of the V2 context, or an empty one', async () => {
    const seen: string[] = [];
    const watched = defineTool({
      description: 'a tool',
      args: z.object({ reason: z.string() }),
      execute: async (_args, context) => {
        seen.push(context.agent);
        return 'ok';
      },
    });

    await v2Tool('oa_test', watched).execute(
      { reason: 'x' },
      { sessionID: 'ses_1', agent: 'oa-builder' },
    );
    await v2Tool('oa_test', watched).execute({ reason: 'x' }, { sessionID: 'ses_1' });

    expect(seen).toEqual(['oa-builder', '']);
  });

  it('serializes an object result, so the model does not read [object Object]', async () => {
    const task = defineTool({
      description: 'a tool',
      args: z.object({ title: z.string() }),
      execute: async () => ({ id: 'tsk_1', title: 'a task' }),
    });

    const entry = toolOf(toolMap({ oa_test: task }), 'oa_test');
    await expect(entry.execute({ title: 'a task' }, v1Context)).resolves.toBe(
      '{"id":"tsk_1","title":"a task"}',
    );

    const v2 = v2Tool('oa_test', task);
    await expect(v2.execute({ title: 'a task' }, { sessionID: 'ses_1' })).resolves.toEqual({
      content: '{"id":"tsk_1","title":"a task"}',
    });
  });

  it('counts on the session and the agent, and on nothing else', async () => {
    // The context a definition is written against is the one the memory and
    // the task packages are written against too, so the type has to be the
    // same one the move carried over. It is checked at the type level and
    // at the run level.
    const seen: ToolCtx[] = [];
    const watched = defineTool({
      description: 'a tool',
      args: z.object({ reason: z.string() }),
      execute: async (_args, context) => {
        seen.push(context);
        return 'ok';
      },
    });

    await watched.execute({ reason: 'x' }, { sessionID: 'ses_1', agent: 'oa-builder' });

    const same: Same<Parameters<ToolDef<typeof watched.args>['execute']>[1], ToolCtx> = true;
    const derived: Same<ToolCtx, Pick<V1ToolCtx, 'sessionID' | 'agent'>> = true;
    expect(same).toBe(true);
    expect(derived).toBe(true);
    expect(seen).toEqual([{ sessionID: 'ses_1', agent: 'oa-builder' }]);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['agent', 'sessionID']);
  });
});
