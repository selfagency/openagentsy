import { z } from 'zod';
import { defineTool, type V2ToolDefinition, v2Tool } from './define-tool.js';
import {
  appendAudit,
  POLICIES,
  planClimb,
  readRungs,
  recordClimb,
  refuseClimb,
  roleKeyForAgent,
  rungTarget,
  writeRungs,
} from './guard.js';
import { checkWrite } from './write-guard.js';

/**
 * The OpenCode 2 plugin path.
 *
 * OpenCode 2 has a real plugin API: a plugin default-exports a definition
 * with an `id` and a `setup(ctx)`, and `setup` registers hooks, transforms,
 * tools and subscriptions on the context. The V1 hook map does not run here.
 *
 * The mapping from the V1 hooks this plugin uses:
 *
 * | V1                    | V2                                        |
 * | --------------------- | ----------------------------------------- |
 * | `tool.execute.before` | `ctx.permission.hook("evaluate", ...)`    |
 * | `chat.params`         | `ctx.session.hook("context", ...)`        |
 * | `event`               | `ctx.event.subscribe({ signal })`         |
 * | `tool` map            | `ctx.tool.transform(...)`                 |
 *
 * The write guard uses the permission hook and not the tool hook, because
 * the permission event carries the agent and the paths, and the tool event
 * carries neither. The rule is the same one the V1 path applies: only
 * `checkWrite` decides.
 *
 * This path is verified against `@opencode/cli@2.1.3`.
 */

/** The message shape the V2 context returns. */
export type V2SessionMessage = {
  parts?: { type: string; text?: string }[];
};

/** The V2 context, as far as this plugin uses it. */
export type V2Context = {
  location: { directory: string };
  session: {
    hook: (
      name: string,
      callback: (event: V2ContextEvent) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> }>;
    switchModel: (input: {
      sessionID: string;
      model: { providerID: string; id: string; variant?: string };
    }) => Promise<void>;
    /** Open a session. A parent makes it a child of that session. */
    create: (input?: { title?: string; parentID?: string }) => Promise<{ id?: string }>;
    /** The messages of a session. */
    context: (input: { sessionID: string }) => Promise<readonly V2SessionMessage[]>;
    /** Hand a session a prompt and wait for the answer. */
    prompt: (input: { sessionID: string; text: string }) => Promise<unknown>;
    /** Change the agent a session runs under. */
    switchAgent: (input: { sessionID: string; agent: string }) => Promise<void>;
  };
  tool: {
    hook: (
      name: string,
      callback: (event: V2ToolEvent) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> }>;
    transform: (
      callback: (editor: { add: (definition: V2ToolDefinition) => void }) => void,
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
  permission: {
    hook: (
      name: string,
      callback: (event: V2PermissionEvent) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event>;
  };
};

/** The event of a model request, the V2 form of `chat.params`. */
export type V2ContextEvent = {
  sessionID?: string;
  agent?: string;
  options?: Record<string, unknown>;
};

/** The event of a tool call, the V2 form of `tool.execute.before`. */
export type V2ToolEvent = {
  tool: string;
  input?: unknown;
  sessionID?: string;
};

/**
 * The event of a permission decision, the V2 place a write is refused.
 *
 * It carries the session, the agent, the action and the paths, which is
 * everything the lease rule needs.
 */
export type V2PermissionEvent = {
  sessionID: string;
  agent?: string;
  action: string;
  resources: readonly string[];
  effect: 'allow' | 'ask' | 'deny';
  message?: string;
};

export type V2Event = {
  type: string;
  properties?: { sessionID?: string };
};

/** The permission actions that write. The names are the permission map keys. */
const WRITE_ACTIONS = new Set(['edit', 'write', 'patch', 'apply_patch']);

export type { V2ToolDefinition };

/**
 * The effort ladder tool.
 *
 * The V1 tool helper takes a Zod schema. V2 takes JSON Schema, and the tool
 * returns structured content. The definition holds the Zod schema, and the
 * V2 registration takes the JSON schema out of it.
 */
function effortTool(root: string, ctx: V2Context) {
  return defineTool({
    description:
      'Climb one rung on the reasoning effort ladder. Only call this when a trigger fired, for example a test failed twice or the change touches concurrency, auth or migrations. The reason must name the trigger.',
    args: z.object({
      reason: z.string().describe('Why you are climbing. Name the trigger that fired.'),
    }),
    async execute(args, context) {
      if (typeof args.reason !== 'string') {
        return 'The reason must be a string that names the trigger.';
      }
      const role = await roleKeyForAgent(root, context.agent);
      const plan = await planClimb(root, role, context.sessionID, args.reason);

      if (!plan.ok) {
        await refuseClimb(root, role, args.reason);
        return plan.message;
      }

      await recordClimb(root, context.sessionID, role, plan.rungIndex, args.reason);

      const target = plan.target;
      const separator = target.model.indexOf('/');
      if (separator !== -1) {
        // In V2 the variant is part of the model reference, so the ladder
        // moves the session to the model and the effort level together.
        await ctx.session.switchModel({
          sessionID: context.sessionID,
          model: {
            providerID: target.model.slice(0, separator),
            id: target.model.slice(separator + 1),
            ...(target.variant !== undefined ? { variant: target.variant } : {}),
          },
        });
      }

      return `Climbed to rung ${plan.rungIndex}: ${target.model} ${target.variant ?? 'default'}. Say why in your board record.`;
    },
  });
}

/**
 * Apply the effort rung a role climbed to.
 *
 * In V2 the variant is part of the model reference, so the ladder moves the
 * session to the model and the effort level together.
 */
async function applyRung(
  root: string,
  ctx: V2Context,
  sessionID: string,
  agent: string,
): Promise<void> {
  const role = await roleKeyForAgent(root, agent);
  const target = await rungTarget(root, role, sessionID);
  if (!target) return;
  const separator = target.model.indexOf('/');
  if (separator === -1) return;

  await ctx.session.switchModel({
    sessionID,
    model: {
      providerID: target.model.slice(0, separator),
      id: target.model.slice(separator + 1),
      ...(target.variant !== undefined ? { variant: target.variant } : {}),
    },
  });
}

/**
 * The model request. It carries the session's agent, which the write guard
 * needs, and it is where the effort rung of a role is applied.
 */
async function registerContextHook(
  root: string,
  ctx: V2Context,
  sessionAgents: Map<string, string>,
  switched: Set<string>,
): Promise<void> {
  await ctx.session.hook('context', async (event) => {
    if (event.sessionID === undefined) return;
    if (event.agent !== undefined) sessionAgents.set(event.sessionID, event.agent);
    if (event.agent === undefined) return;
    if (switched.has(event.sessionID)) return;

    switched.add(event.sessionID);
    await applyRung(root, ctx, event.sessionID, event.agent);
  });
}

/**
 * The OpenCode 2 entry point.
 *
 * The cleanup function aborts the event subscription when the plugin
 * unloads, which is what the V2 documentation asks for.
 */
export async function setupV2(ctx: V2Context): Promise<(() => void) | undefined> {
  const root = ctx.location.directory;
  const sessionAgents = new Map<string, string>();
  const switched = new Set<string>();

  await registerContextHook(root, ctx, sessionAgents, switched);

  // The write guard. The permission event carries the agent and the paths,
  // so the lease rule can be applied before the action runs.
  await ctx.permission.hook('evaluate', async (event) => {
    if (!WRITE_ACTIONS.has(event.action)) return;

    // A write from a session whose agent is not known is a write nobody can
    // be held to. The rule is a lease rule, and a lease needs a holder.
    if (event.agent === undefined) {
      event.effect = 'deny';
      event.message =
        'OpenAgentsy blocked this write. The session carries no agent, so the lease rule cannot be applied. Ask the Lead to run this session under a role.';
      await appendAudit(root, {
        policyId: POLICIES.leaseWrite.id,
        policyVersion: POLICIES.leaseWrite.version,
        actor: 'unknown',
        action: event.action,
        resource: '(unidentified session)',
        effect: 'deny',
        detail: 'the session carries no agent, so no lease can be attributed to it',
        sessionID: event.sessionID,
      });
      return;
    }

    if (event.resources.length === 0) {
      // A write action with no resource is a write whose path cannot be
      // checked. It is refused for the same reason an unknown agent is.
      event.effect = 'deny';
      event.message =
        'OpenAgentsy blocked this write. The action names no path, so the lease rule cannot be applied.';
      await appendAudit(root, {
        policyId: POLICIES.leaseWrite.id,
        policyVersion: POLICIES.leaseWrite.version,
        actor: event.agent,
        action: event.action,
        resource: '(no readable path)',
        effect: 'deny',
        detail: 'the action names no path, so no lease can be checked',
        sessionID: event.sessionID,
      });
      return;
    }

    for (const resource of event.resources) {
      const result = await checkWrite(root, {
        toolName: event.action,
        path: resource,
        agent: event.agent,
        sessionID: event.sessionID,
      });
      if (result?.effect === 'deny') {
        event.effect = 'deny';
        event.message = `OpenAgentsy blocked this write. ${result.reason} Ask the Lead for a lease, then retry.`;
        return;
      }
    }
  });

  // The effort tool.
  await ctx.tool.transform((editor) => {
    editor.add(v2Tool('oa_effort', effortTool(root, ctx)));
  });

  // The events. A session that goes idle gives its effort rung back, so the
  // next task in that session starts on the rung the role was given. The
  // archivist takes what the session learned, the same way the V1 path does.
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type !== 'session.idle') continue;
      const sessionID = event.properties?.sessionID;
      if (!sessionID) continue;
      const agent = sessionAgents.get(sessionID);
      sessionAgents.delete(sessionID);
      switched.delete(sessionID);
      if (!agent) continue;
      await onIdle(root, sessionID, agent);
    }
  })();

  return () => controller.abort();
}

/**
 * A session went idle on the V2 path.
 *
 * The rungs go back, so the next task in that session starts on the rung the
 * role was given.
 *
 * The V2 harvest is off. The context this plugin is given has no way to ask
 * whether a session still exists: `session` carries hook, switchModel,
 * create, context, prompt and switchAgent, and a message list cannot tell a
 * fresh session from a deleted one. The archivist child is created and then
 * prompted, and a parent delete cascades the child away in between, which is
 * the failure the V1 path now checks for. Prompting anyway would claim a
 * check that did not happen; recording a failure would say so once per
 * session. The probe script (scripts/probe-v2.mjs) is what can show what the
 * context answers for a missing session, but it needs a live V2 server and
 * this path is not verified against one yet, so the harvest stays off until
 * the context has a lookup.
 *
 * A failure here must not kill the subscription: the rungs would stop being
 * given back and the failure would be a silence, which is the one thing the
 * fault cases exist to catch.
 */
async function onIdle(root: string, sessionID: string, agent: string): Promise<void> {
  try {
    const rungs = await readRungs(root);
    if (rungs[sessionID]) {
      delete rungs[sessionID];
      await writeRungs(root, rungs);
    }
  } catch (error) {
    await appendAudit(root, {
      policyId: POLICIES.eventsFailed.id,
      policyVersion: POLICIES.eventsFailed.version,
      actor: agent,
      action: 'idle',
      resource: sessionID,
      effect: 'deny',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
