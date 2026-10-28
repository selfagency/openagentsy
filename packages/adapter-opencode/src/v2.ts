import { join } from 'node:path';
import { defineTool, type V2ToolDefinition, v2Tool } from '@openagentsy/core';
import { applyShellEnvPolicy } from '@openagentsy/hooks/shell-env';
import { closeLedger, openLedger } from '@openagentsy/ledger';
import { z } from 'zod';
import { boardRoundStatus } from './board-status.js';
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
import {
  type HarvestSession,
  harvest,
  harvestEnabled,
  type PruneSessionRow,
  pruneHarvestChildren,
  recordHarvestFailure,
} from './harvest.js';
import { recordIdleFailure } from './idle-failure.js';
import { claimedStatusOf, observeSessionIdle, recordNoProgressRounds } from './idle-observer.js';
import { assistantMessageOf, bridgeToLedger } from './ledger-bridge.js';
import { readApprovalFor } from './project-config.js';
import { type Roots, resolveRoots } from './roots.js';
import { applyApproval, SHELL_ACTION } from './v2-approval.js';
import { createV2Bridge, type V2Bridge, type V2ToolEvent } from './v2-bridge.js';
import { checkWrite } from './write-guard.js';

/**
 * The OpenCode 2 plugin path.
 *
 * OpenCode 2 has a real plugin API: a plugin default-exports a definition
 * with an `id` and a `setup(ctx)`, and `setup` registers hooks, transforms,
 * tools and subscriptions on the context. The V1 hook map does not run here.
 *
 * The mapping from the V1 hooks this plugin uses, measured on a live
 * OpenCode 2.2.0 server (2026-10-27):
 *
 * | V1                    | V2                                        |
 * | --------------------- | ----------------------------------------- |
 * | `tool.execute.before` | `ctx.tool.hook("execute.before", ...)`     |
 * | `tool.execute.after`  | `ctx.tool.hook("execute.after", ...)`      |
 * | `tool.execute.before` | `ctx.permission.hook("evaluate", ...)`     |
 * | `chat.params`         | `ctx.session.hook("context", ...)`         |
 * | `event`               | `ctx.event.subscribe({ signal })`          |
 * | `tool` map            | `ctx.tool.transform(...)`                  |
 * | `shell.env`           | `ctx.shell.hook("create.before", ...)`      |
 *
 * The V2 tool hook fires with the V1 hook names and carries the tool name,
 * the arguments, the agent and the call id, and it has the two powers the
 * V1 hook had: a throw stops the call, and the arguments of the event are
 * the arguments the tool runs with. So the rules of the package run in the
 * same places they run on V1, and the bridge is the adapter between the two
 * shapes rather than a second copy of the rules.
 *
 * The write guard uses the permission hook and not the tool hook, because
 * the permission event carries the agent and the paths, and the tool event
 * carries neither. The rule is the same one the V1 path applies: only
 * `checkWrite` decides.
 *
 * One V1 hook has no V2 home, and the record says so:
 *
 *   - `config` has no domain: the V2 context has no way to write the
 *     permission map of the host, so the commands a person has to approve
 *     are asked for through the permission hook instead.
 *
 * The `shell.env` hook has a home after all. The V2 shell domain takes a
 * `create.before` hook, and the event carries the environment the child
 * would get; the server spawns the child with that object after the hook
 * returns, so a key taken out of it is a key the child does not see
 * (measured on a live OpenCode 2.2.0 server, 2026-10-27). The policy runs
 * there, so the shell of an agent runs with the environment of the host
 * minus the keys that belong to the board.
 *
 * This path is verified against `@opencode/cli@2.1.3`.
 */

/** The message shape the V2 context returns. */
export type V2SessionMessage = {
  parts?: { type: string; text?: string }[];
  /** The V2 way of the same thing: the parts of an assistant message. */
  content?: { type: string; text?: string }[];
  /** A user message is flat: its text is on the message itself. */
  text?: string;
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
    /** The sessions of the project. The janitor reads them. */
    list: () => Promise<unknown>;
    /** Delete a session. The janitor deletes the harvest children. */
    remove: (input: { sessionID: string }) => Promise<unknown>;
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
  shell: {
    hook: (
      name: string,
      callback: (event: V2ShellEvent) => Promise<void> | void,
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
  model?: unknown;
  options?: Record<string, unknown>;
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
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

/**
 * The event of a shell that is about to be spawned.
 *
 * It carries the environment the child would get, and the server spawns the
 * child with that object after the hook returns. A key taken out of the
 * environment is a key the child does not see.
 */
export type V2ShellEvent = {
  /** The command the child runs. */
  command: string;
  /** Where the child runs. */
  cwd: string;
  /** How long the child may run. */
  timeout: number;
  /** The shell the child runs under. */
  shell: string;
  /** The environment the child gets. */
  env: Record<string, string | undefined>;
};

export type V2Event = {
  type: string;
  /**
   * The v1 shape: the payload of the event under `properties`.
   *
   * The 1.x server sends `{type, properties}` and the 2.x server sends the
   * envelope `{id, created, type, data}`. The plugin context hands the
   * plugin the 2.x shape (measured on a live OpenCode 2.2.0 server,
   * 2026-10-27), so the payload is under `data` and the reader below reads
   * both, the way the harness reader does.
   */
  properties?: { sessionID?: string; info?: unknown; status?: unknown };
  /** The v2 shape: the payload of the event under `data`. */
  data?: {
    sessionID?: string;
    info?: unknown;
    status?: unknown;
    /** The text of a reply, on `session.text.ended`. */
    text?: string;
  };
};

/** The permission actions that write. The names are the permission map keys. */
const WRITE_ACTIONS = new Set(['edit', 'write', 'patch', 'apply_patch']);

export type { V2ToolDefinition, V2ToolEvent };

/**
 * The effort ladder tool.
 *
 * The V1 tool helper takes a Zod schema. V2 takes JSON Schema, and the tool
 * returns structured content. The definition holds the Zod schema, and the
 * V2 registration takes the JSON schema out of it.
 */
function effortTool(roots: Roots, ctx: V2Context) {
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
      const role = await roleKeyForAgent(roots.workspace, context.agent);
      const plan = await planClimb(roots, role, context.sessionID, args.reason);

      if (!plan.ok) {
        await refuseClimb(roots.stateRoot, role, args.reason);
        return plan.message;
      }

      await recordClimb(roots.stateRoot, context.sessionID, role, plan.rungIndex, args.reason);

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
  roots: Roots,
  ctx: V2Context,
  sessionID: string,
  agent: string,
): Promise<void> {
  const role = await roleKeyForAgent(roots.workspace, agent);
  const target = await rungTarget(roots.stateRoot, role, sessionID);
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
  roots: Roots,
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
    await applyRung(roots, ctx, event.sessionID, event.agent);
  });
}

/**
 * The events that say a turn is over.
 *
 * The 2.x server says it with the execution events, and it says nothing
 * with the v1 `session.idle`: the stream of a live OpenCode 2.2.0 server
 * carried `session.execution.started`, `session.execution.succeeded` and
 * `session.execution.failed`, and no idle event at all (measured
 * 2026-10-27). A plugin that waits for `session.idle` waits forever, and
 * the archivist never runs.
 *
 * The v1 spellings are read as well: a server that sends `session.idle` or
 * a `session.status` that says `idle` is a server the plugin must still
 * work on, and the two cost nothing to read.
 */
const TURN_ENDED = new Set(['session.execution.succeeded', 'session.execution.failed']);

/**
 * Whether an event says that a turn is over.
 */
function isTurnEnd(event: V2Event): boolean {
  if (TURN_ENDED.has(event.type)) return true;
  if (event.type === 'session.idle') return true;
  if (event.type !== 'session.status') return false;
  const status = event.data?.status ?? event.properties?.status;
  return isRecord(status) && status.type === 'idle';
}

/**
 * The session an event names, wherever the server put it.
 */
function sessionOf(event: V2Event): string | undefined {
  const data = event.data?.sessionID;
  if (typeof data === 'string') return data;
  const properties = event.properties?.sessionID;
  return typeof properties === 'string' ? properties : undefined;
}

/** Whether a value is an object and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An assistant message finished, on the V2 path.
 *
 * The V2 context has no way to look a session up, so the session is its own
 * root here: the usage lands on the session that is known rather than on a
 * parent the context cannot name.
 */
async function onMessageUpdated(
  roots: Roots,
  event: V2Event,
  sessionAgents: Map<string, string>,
): Promise<void> {
  const message = assistantMessageOf(event);
  if (message === undefined) return;
  const sessionID = sessionOf(event);
  if (sessionID === undefined) return;
  const agent = sessionAgents.get(sessionID);
  if (agent === undefined) return;
  await bridgeToLedger(roots, { raw: message, sessionID, rootSessionID: sessionID, agent });
}

/**
 * The tool hook, on the V2 path.
 *
 * The V2 tool hook fires with the V1 hook names, so the rules of the package
 * run in the same places they run on V1: before the call and after it. A
 * rule that blocks a call throws, and a throw in the V2 before hook stops
 * the call; a rule that rewrites the arguments rewrites the arguments the
 * tool runs with. Both measured on a live OpenCode 2.2.0 server.
 */
async function registerToolHooks(ctx: V2Context, bridge: V2Bridge): Promise<void> {
  await ctx.tool.hook('execute.before', async (event) => {
    await bridge.before(event);
  });
  await ctx.tool.hook('execute.after', async (event) => {
    await bridge.after(event);
  });
}

/**
 * The environment of the shell of an agent, on the V2 path.
 *
 * The V1 path had a `shell.env` hook that filled an object and the shell read
 * it. The V2 shell domain takes a hook of its own, `create.before`, and the
 * event carries the environment the child would get; the server spawns the
 * child with that object after the hook returns. So the policy runs there:
 * the keys that belong to the board never reach the shell of an agent.
 *
 * The command is not touched. The command is the resource of the permission
 * event, so a person is asked about the command that was written, and a
 * compound command behaves as it was written.
 */
async function registerShellEnvHook(ctx: V2Context): Promise<void> {
  await ctx.shell.hook('create.before', async (event) => {
    applyShellEnvPolicy(event.env);
  });
}

/**
 * A permission decision, on the V2 path.
 *
 * Two things are decided here. The lease rule decides whether a write may
 * happen, and the approval list decides whether a person is asked about a
 * command first.
 */
async function onPermission(
  roots: Roots,
  event: V2PermissionEvent,
  sessionAgents: Map<string, string>,
  approvalFor: readonly string[],
): Promise<void> {
  // The V1 path wrote the commands a person has to approve into the
  // permission map of the host. The V2 path has no map to write, so the
  // approval is asked for here, where the decision is made.
  if (event.action === SHELL_ACTION) {
    applyApproval(event, approvalFor);
    return;
  }
  if (!WRITE_ACTIONS.has(event.action)) return;
  await guardWriteDecision(roots, event, sessionAgents);
}

/**
 * The lease rule, on the V2 path.
 *
 * The agent of a decision is the agent of the session. The permission event
 * carries the agent of the request, and a request that names no agent takes
 * the agent of the session the context hook resolved. A write that has
 * neither is refused: a lease needs a holder, and a write nobody can be
 * held to is a write the rule cannot judge.
 */
async function guardWriteDecision(
  roots: Roots,
  event: V2PermissionEvent,
  sessionAgents: Map<string, string>,
): Promise<void> {
  const agent = event.agent ?? sessionAgents.get(event.sessionID);
  if (agent === undefined) {
    event.effect = 'deny';
    event.message =
      'OpenAgentsy blocked this write. The permission event named no agent and the session names none either, so the lease rule cannot be applied. Ask the Lead to run this session under a role.';
    await appendAudit(roots.stateRoot, {
      policyId: POLICIES.leaseWrite.id,
      policyVersion: POLICIES.leaseWrite.version,
      actor: 'unknown',
      action: event.action,
      resource: '(unidentified session)',
      effect: 'deny',
      detail:
        'the permission event named no agent and the session names none either, so no lease can be attributed to it',
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
    await appendAudit(roots.stateRoot, {
      policyId: POLICIES.leaseWrite.id,
      policyVersion: POLICIES.leaseWrite.version,
      actor: agent,
      action: event.action,
      resource: '(no readable path)',
      effect: 'deny',
      detail: 'the action names no path, so no lease can be checked',
      sessionID: event.sessionID,
    });
    return;
  }

  for (const resource of event.resources) {
    const result = await checkWrite(roots, {
      toolName: event.action,
      path: resource,
      agent,
      sessionID: event.sessionID,
    });
    if (result?.effect === 'deny') {
      event.effect = 'deny';
      event.message = `OpenAgentsy blocked this write. ${result.reason} Ask the Lead for a lease, then retry.`;
      return;
    }
  }
}

/**
 * The text of a reply, on the V2 path.
 *
 * The V2 path has no `experimental.text.complete` hook: the text of a reply
 * arrives with the `session.text.ended` event, which is after the reply is
 * out. The output checks run on that text and their findings are recorded,
 * but the note the V1 path added to the reply cannot be added to a reply
 * that is already out.
 */
async function onTextEnded(bridge: V2Bridge, event: V2Event): Promise<void> {
  const text = event.data?.text;
  if (typeof text !== 'string' || text === '') return;
  const sessionID = sessionOf(event);
  if (sessionID === undefined) return;
  await bridge.reply(sessionID, text);
}

/**
 * The OpenCode 2 entry point.
 *
 * The cleanup function aborts the event subscription when the plugin
 * unloads, which is what the V2 documentation asks for.
 */
export async function setupV2(ctx: V2Context): Promise<(() => void) | undefined> {
  // The session's own directory is the workspace, and the state root is the
  // directory that owns the shared state: the board, the leases, the audit
  // log, the rungs and the ledger. In a linked worktree the state root is
  // the MAIN repository root, so a builder in a worktree reads the Lead's
  // board and not a board of its own.
  const roots = resolveRoots(ctx.location.directory);
  const { workspace, stateRoot } = roots;
  const sessionAgents = new Map<string, string>();
  const switched = new Set<string>();

  await registerContextHook(roots, ctx, sessionAgents, switched);

  // The environment of the shell of an agent, before the first command runs.
  await registerShellEnvHook(ctx);

  // The rules of the package, on the V2 hook points.
  const bridge = await createV2Bridge({
    roots,
    sessionAgents,
    onFindings: async (findings, sessionID) => {
      const agent = sessionAgents.get(sessionID) ?? 'unknown';
      await appendAudit(stateRoot, {
        policyId: POLICIES.outputFlagged.id,
        policyVersion: POLICIES.outputFlagged.version,
        actor: agent,
        action: 'output-check',
        resource: sessionID,
        effect: 'allow',
        detail: findings.map((finding) => `${finding.name}: ${finding.type}`).join(', '),
        sessionID,
      });
    },
  });
  await registerToolHooks(ctx, bridge);

  // The write guard and the approval of a command.
  const approvalFor = await readApprovalFor(workspace);
  await ctx.permission.hook('evaluate', async (event) => {
    await onPermission(roots, event, sessionAgents, approvalFor);
  });

  // The effort tool.
  await ctx.tool.transform((editor) => {
    editor.add(v2Tool('oa_effort', effortTool(roots, ctx)));
  });

  // The events. A session that goes idle gives its effort rung back, so the
  // next task in that session starts on the rung the role was given. The
  // archivist takes what the session learned, the same way the V1 path does.
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === 'message.updated') {
        await onMessageUpdated(roots, event, sessionAgents);
        continue;
      }
      if (event.type === 'session.text.ended') {
        await onTextEnded(bridge, event);
        continue;
      }
      // The turn is over. The rungs go back and the archivist takes what the
      // session learned, the same way the V1 path does when a session goes
      // idle.
      if (!isTurnEnd(event)) continue;
      const sessionID = sessionOf(event);
      if (!sessionID) continue;
      const agent = sessionAgents.get(sessionID);
      sessionAgents.delete(sessionID);
      switched.delete(sessionID);
      if (!agent) continue;
      await onIdle(roots, ctx, sessionID, agent);
    }
  })();

  return () => controller.abort();
}

/**
 * The harvest, on the V2 path.
 *
 * The V2 plugin context is not the server client, so the harvest asks the
 * context for the three things it needs: the words of the session, a session
 * for the archivist, and a hand to the archivist.
 *
 * There is no lookup. The context carries `create`, `context`, `prompt` and
 * `switchAgent`, and a message list cannot tell a fresh session from a
 * deleted one, so the adapter does not claim a check it did not make: the
 * `exists` of the harvest is left out, and the harvest says so on the
 * record. The guarantee it gives up is narrow: the archivist used to be
 * created as a child of the session that was ending, and a delete of that
 * session took the child with it. The archivist now stands on its own, so
 * there is no cascade to survive, and the harvest goes on.
 *
 * The janitor is here: the V2 session surface can list the sessions of the
 * project and delete one, so the harvest children that are older than a week
 * are deleted the way the V1 path deletes them.
 *
 * The archivist's turn runs in the background. The V1 path says the same with
 * `promptAsync`, and the reason is the same: the session that is closing must
 * not wait for the archivist's whole run, and the V2 event loop must not
 * stop reading events while it waits.
 */
function v2HarvestSession(stateRoot: string, ctx: V2Context): HarvestSession {
  return {
    messages: async (sessionID) => {
      const messages = await ctx.session.context({ sessionID });
      return messages.map((message) => ({ parts: textPartsOf(message) }));
    },
    create: async (input) => {
      const created = await ctx.session.create({ title: input.title });
      return created.id;
    },
    prompt: async ({ sessionID, agent, text }) => {
      // The agent of a turn is the agent of its session, so the archivist is
      // named on the session before the packet is handed over.
      await ctx.session.switchAgent({ sessionID, agent });
      // The turn runs in the background: the harvest is done when the packet
      // is handed over, not when the archivist answers. A turn that fails
      // afterwards is the archivist's own business, the same as on V1.
      void ctx.session.prompt({ sessionID, text }).catch(() => {});
    },
    prune: async () => {
      await pruneHarvestChildren(
        {
          list: async () => pruneRows(await ctx.session.list()),
          delete: async (sessionID) => {
            // The V2 session surface takes the session under the name the
            // rest of the API uses for it (measured on a live OpenCode 2.2.0
            // server: a delete asked for by an id is refused with a schema
            // error that names the key it wanted).
            await ctx.session.remove({ sessionID });
          },
        },
        stateRoot,
      );
    },
  };
}

/**
 * The rows of a session list, in the shape the janitor reads.
 *
 * The list is read as a list and as a list under `data`, because the two
 * shapes are both a list and the janitor must not care which one it got.
 */
function pruneRows(listed: unknown): PruneSessionRow[] {
  if (Array.isArray(listed)) return listed as PruneSessionRow[];
  if (isRecord(listed) && Array.isArray(listed['data'])) return listed['data'] as PruneSessionRow[];
  return [];
}

/**
 * The text of a message, in the shape the harvest reads.
 *
 * The V2 context carries the words of a message in one of three places: the
 * parts of an assistant message, the content of the same, or the flat text
 * of a user message. The packet is a best reading of what the session said,
 * so all three are read.
 */
function textPartsOf(message: V2SessionMessage): { type: string; text?: string }[] {
  const parts = message.parts ?? message.content ?? [];
  const spoken = parts.filter((part) => part.type === 'text');
  if (spoken.length > 0) return spoken;
  return message.text === undefined ? [] : [{ type: 'text', text: message.text }];
}

/**
 * The text the session said last.
 *
 * The report of a round is the last thing the Lead says, so the status the
 * report claims is read out of it.
 */
async function lastTextOf(ctx: V2Context, sessionID: string): Promise<string> {
  const messages = await ctx.session.context({ sessionID });
  const last = messages.at(-1);
  if (last === undefined) return '';
  const text: string[] = [];
  for (const part of textPartsOf(last)) {
    if (part.type !== 'text') continue;
    if (typeof part.text === 'string') text.push(part.text);
  }
  return text.join('\n');
}

/**
 * The round of the session that went idle (§8.7), on the V2 path.
 *
 * Two things are checked: the status the report claims against the status
 * the board holds, and the rounds that changed nothing.
 *
 * Neither may take the session down. The event loop is not awaited by the
 * host, so a throw there is a broken session and not a failed check: the
 * throw of the ledger is caught here, and every failure goes on the record.
 */
async function observeRound(
  stateRoot: string,
  ctx: V2Context,
  sessionID: string,
  agent: string,
): Promise<void> {
  try {
    const claimed = claimedStatusOf(await lastTextOf(ctx, sessionID));
    const finding = observeSessionIdle(claimed, () => boardRoundStatus(stateRoot), sessionID);
    if (finding !== undefined) {
      await appendAudit(stateRoot, {
        policyId: POLICIES.roundStatusMismatch.id,
        policyVersion: POLICIES.roundStatusMismatch.version,
        actor: agent,
        action: 'round-status',
        resource: sessionID,
        effect: 'deny',
        detail: finding.detail,
        sessionID,
      });
    }
  } catch (error) {
    await recordIdleFailure(stateRoot, { agent, sessionID, error });
  }

  try {
    const ledger = openLedger(stateRoot);
    try {
      recordNoProgressRounds(ledger, join(stateRoot, '.openagentsy', 'board.sqlite'));
    } finally {
      closeLedger(ledger);
    }
  } catch (error) {
    await recordIdleFailure(stateRoot, { agent, sessionID, error });
  }
}

/**
 * A session went idle on the V2 path.
 *
 * The rungs go back, so the next task in that session starts on the rung the
 * role was given, and the archivist takes what the session learned, the same
 * way the V1 path does.
 *
 * A failure here must not kill the subscription: the rungs would stop being
 * given back and the failure would be a silence, which is the one thing the
 * fault cases exist to catch.
 */
async function onIdle(
  roots: Roots,
  ctx: V2Context,
  sessionID: string,
  agent: string,
): Promise<void> {
  try {
    const rungs = await readRungs(roots.stateRoot);
    if (rungs[sessionID]) {
      delete rungs[sessionID];
      await writeRungs(roots.stateRoot, rungs);
    }
  } catch (error) {
    await appendAudit(roots.stateRoot, {
      policyId: POLICIES.eventsFailed.id,
      policyVersion: POLICIES.eventsFailed.version,
      actor: agent,
      action: 'idle',
      resource: sessionID,
      effect: 'deny',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // The round that just finished is checked before the archivist runs: the
  // archivist may open a session of its own, and the round that went
  // nowhere is the one that is still open.
  await observeRound(roots.stateRoot, ctx, sessionID, agent);

  // A harvest that fails must not break the session that is closing, so it
  // is caught here and put on the record. The V1 path keeps the two
  // failures apart, and so does this one: a rung that cannot be given back
  // is a failure of the events, and a harvest that cannot run is a failure
  // of the harvest.
  try {
    if (!(await harvestEnabled(roots.stateRoot))) return;
    const role = await roleKeyForAgent(roots.workspace, agent);
    await harvest({
      session: v2HarvestSession(roots.stateRoot, ctx),
      stateRoot: roots.stateRoot,
      sessionID,
      role,
      agent,
    });
  } catch (error) {
    await recordHarvestFailure(roots.stateRoot, { agent, sessionID, error });
  }
}
