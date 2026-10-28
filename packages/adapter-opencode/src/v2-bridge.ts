import type { OutputFinding } from '@openagentsy/hooks/output-checks';
import { type BridgeHooks, createBridge } from './bridge.js';
import { activeBean, roleKeyForAgent, statedPathsOf } from './guard.js';
import { readQualityMode } from './project-config.js';

/**
 * The bridge, on the V2 path.
 *
 * The rules are the package's, and the V1 path reaches them through the
 * hook map of the OpenCode 1 plugin API. The V2 path reaches the same rules
 * through the V2 tool hook, which fires with the V1 hook names —
 * `tool.execute.before` and `tool.execute.after` — and carries the tool
 * name, the arguments, the agent and the call id (measured on a live
 * OpenCode 2.2.0 server, 2026-10-27).
 *
 * So the V2 path is an adapter and not a second copy of the rules: the
 * registry is built once, by `createBridge`, and the V2 events are shaped
 * into the calls the bridge answers. The rules are the same rules, and a
 * rule that was written for V1 holds on V2.
 *
 * Two powers the V1 hook had and the V2 hook has too, both measured on the
 * same server:
 *
 *   - a throw in `tool.execute.before` stops the call, so a rule that
 *     blocks a call blocks it on V2 as well;
 *   - the arguments of the event are the arguments the tool runs with, so a
 *     rule that rewrites them rewrites them on V2 as well.
 */

/** The event of a tool call, as the V2 context hands it over. */
export type V2ToolEvent = {
  /** The name of the tool, as the host calls it. */
  tool: string;
  /** The session the call is made in. */
  sessionID: string;
  /** The agent the call is made for. */
  agent?: string;
  /** The message the call belongs to. */
  messageID?: string;
  /** The id of the call. The V1 path calls it the call id. */
  id: string;
  /** The arguments of the call. */
  input: unknown;
  /** How the call ended: `completed` or `error`. The after hook carries it. */
  status?: string;
  /** What the call produced. The after hook carries it. */
  result?: V2ToolResult;
  /** Why the call failed. The after hook carries it. */
  error?: unknown;
};

/** What a finished tool call produced. */
export type V2ToolResult = {
  /** What the tool reported. */
  output?: unknown;
  /** The parts the model reads. */
  content?: { type?: string; text?: string }[];
  /** Whatever the tool reported about itself. */
  metadata?: unknown;
};

/** What the bridge needs to know. */
export type V2BridgeOptions = {
  /** The project the agent works in. */
  root: string;
  /** The agent of every session, from the context hook. */
  sessionAgents: Map<string, string>;
  /** Where the findings of the output checks go. */
  onFindings?: (findings: OutputFinding[], sessionID: string) => void | Promise<void>;
};

/** The bridge, on the V2 path. */
export type V2Bridge = {
  /** The rules of a call, before the call runs. */
  before: (event: V2ToolEvent) => Promise<void>;
  /** The rules of a finished call, and the quality check. */
  after: (event: V2ToolEvent) => Promise<void>;
  /** The output checks, on the text of a reply. */
  reply: (sessionID: string, text: string) => Promise<void>;
};

/** Whether a value is an object and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text a finished call produced.
 *
 * The result carries the text twice: in the parts the model reads and, for
 * a shell call, in the output of the command. The parts come first, because
 * they are what the model is shown.
 */
function resultText(result: V2ToolResult | undefined): string {
  if (result === undefined) return '';
  const text: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type !== 'text') continue;
    if (typeof part.text === 'string') text.push(part.text);
  }
  if (text.length > 0) return text.join('\n');
  const output = result.output;
  if (isRecord(output) && typeof output['output'] === 'string') return output['output'];
  return '';
}

/**
 * Write the text of a call back into its result.
 *
 * The quality check tells the agent what to fix by adding its findings to
 * what the call produced, and the host reads the result after the hook, so
 * the text is written where the host looks for it.
 */
function applyResultText(result: V2ToolResult | undefined, text: string): void {
  if (result === undefined) return;
  const first = result.content?.[0];
  if (first !== undefined && first.type === 'text') first.text = text;
  const output = result.output;
  if (isRecord(output) && typeof output['output'] === 'string') output['output'] = text;
}

/**
 * The bridge, on the V2 path.
 *
 * The registry is the one `createBridge` builds, with the same options the
 * V1 path gives it: the same rules, the same quality mode, the same
 * findings sink.
 */
export async function createV2Bridge(options: V2BridgeOptions): Promise<V2Bridge> {
  const { root, sessionAgents } = options;

  /** The role of a session, when the session has one. */
  const roleForSession = async (sessionID: string): Promise<string | undefined> => {
    const agent = sessionAgents.get(sessionID);
    return agent === undefined ? undefined : roleKeyForAgent(root, agent);
  };

  const hooks: BridgeHooks = createBridge({
    workspace: root,
    stateRoot: root,
    roleForSession,
    statedPathsForSession: async (sessionID) => {
      // The scope of the task is the set of files the task holds a lease
      // on, and the leases are read from the board.
      const agent = sessionAgents.get(sessionID);
      if (agent === undefined) return [];
      return statedPathsOf(root, agent);
    },
    quality: {
      mode: await readQualityMode(root),
      taskIdForSession: async (sessionID) => {
        // The task of a session is the bean its agent holds a lease on, so
        // the findings of a write land on the task that asked for it.
        const agent = sessionAgents.get(sessionID);
        if (agent === undefined) return undefined;
        return await activeBean(root, agent);
      },
    },
    ...(options.onFindings === undefined ? {} : { onFindings: options.onFindings }),
  });

  return {
    before: async (event) => {
      await hooks['tool.execute.before'](
        { tool: event.tool, sessionID: event.sessionID, callID: event.id },
        { args: event.input },
      );
    },

    after: async (event) => {
      const result = event.result;
      const output = {
        title: event.tool,
        output: resultText(result),
        metadata: result?.metadata,
      };
      await hooks['tool.execute.after'](
        { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input },
        output,
      );
      applyResultText(result, output.output);
    },

    reply: async (sessionID, text) => {
      // The output checks flag a reply; they never stop it. The V1 path
      // added its note to the text of the reply, and the V2 path has no hook
      // that reaches the text before it is delivered: the text of a reply
      // arrives with the `session.text.ended` event, which is after the
      // reply is out. So the findings are recorded and the note is not
      // delivered, and the record says so.
      const output = { text };
      await hooks['experimental.text.complete']({ sessionID }, output);
    },
  };
}
