import { join } from 'node:path';
import {
  closeDatabase,
  isRoundStatus,
  listRecords,
  openDatabase,
  type RoundStatus,
} from '@openagentsy/core';
import { closeLedger, openLedger } from '@openagentsy/ledger';
import { type BridgeHooks, createBridge } from './bridge.js';
import { type ClientLike, type ProviderInventory, sessionAdapter } from './client.js';
import { defineTool, toolMap } from './define-tool.js';
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
import { harvest, harvestEnabled, recordHarvestFailure } from './harvest.js';
import { claimedStatusOf, observeSessionIdle, recordNoProgressRounds } from './idle-observer.js';
import { assistantMessageOf, bridgeToLedger, rootSessionOf } from './ledger-bridge.js';
import { readApprovalFor } from './project-config.js';
import { tool } from './tool.js';
import { setupV2, type V2Context } from './v2.js';
import { guardWrite } from './write-guard.js';

export type { ToolCtx, ToolDef, V2ToolDefinition } from './define-tool.js';
/**
 * The tool definition helper.
 *
 * A package that registers tools of its own defines them once and hands
 * them to the two runtimes through this.
 */
export { defineTool, toolMap, v2Tool } from './define-tool.js';

/**
 * OpenAgentsy for OpenCode.
 *
 * One file, two runtimes. OpenCode 1 reads `{ id, server }` and never looks
 * at `setup`; OpenCode 2 reads `{ id, setup }` and never looks at `server`.
 * Both ignore the other key, so a single installed file works on either
 * side of the version boundary.
 *
 * What the plugin does:
 *   - refuses a write to a file that no lease covers, or that another agent
 *     owns, and writes the decision to the audit log
 *   - applies the reasoning effort level of the rung a role climbed to
 *   - offers the oa_effort tool, which is the only way to climb
 */

async function variantOptions(
  client: ClientLike,
  modelId: string,
  variant: string | undefined,
  inventory?: Promise<ProviderInventory>,
): Promise<Record<string, unknown> | undefined> {
  if (!variant) return undefined;
  const separator = modelId.indexOf('/');
  if (separator === -1) return undefined;
  const providerID = modelId.slice(0, separator);
  const modelID = modelId.slice(separator + 1);

  // The inventory changes rarely and the request happens on every model
  // call of a climbed session, so it is asked for once.
  const providers = await (inventory ?? client.provider.list());
  const provider = providers.data?.all?.find((entry) => entry.id === providerID);
  const model = provider?.models?.[modelID];
  return model?.variants?.[variant];
}

const effortTool = (root: string, client: ClientLike) =>
  defineTool({
    description:
      'Climb one rung on the reasoning effort ladder. Only call this when a trigger fired, for example a test failed twice or the change touches concurrency, auth or migrations. The reason must name the trigger.',
    args: tool.schema.object({
      reason: tool.schema.string().describe('Why you are climbing. Name the trigger that fired.'),
    }),
    async execute(args, context) {
      const role = await roleKeyForAgent(root, context.agent);
      const plan = await planClimb(root, role, context.sessionID, args.reason);

      if (!plan.ok) {
        await refuseClimb(root, role, args.reason);
        return plan.message;
      }

      await recordClimb(root, context.sessionID, role, plan.rungIndex, args.reason);

      const target = plan.target;
      const separator = target.model.indexOf('/');
      if (separator === -1) {
        // The lock entry has no provider, so there is no model to switch
        // to. The rung is recorded, and saying it climbed would be a lie.
        await appendAudit(root, {
          policyId: POLICIES.effortRefused.id,
          policyVersion: POLICIES.effortRefused.version,
          actor: context.agent,
          action: 'effort',
          resource: target.model,
          effect: 'deny',
          detail:
            'the lock entry has no provider/model id, so the climb was recorded but not applied',
        });
        return `Recorded rung ${plan.rungIndex} for ${target.model}, but the lock entry has no provider/model id, so no model was switched.`;
      }
      const providerID = target.model.slice(0, separator);
      const modelID = target.model.slice(separator + 1);
      await client.session.promptAsync({
        path: { id: context.sessionID },
        body: {
          noReply: true,
          agent: context.agent,
          model: { providerID, modelID },
          parts: [
            {
              type: 'text',
              text: `effort ladder: ${target.model} ${target.variant ?? 'default'}`,
              synthetic: true,
              ignored: true,
            },
          ],
        },
      });

      return `Climbed to rung ${plan.rungIndex}: ${target.model} ${target.variant ?? 'default'}. Say which rung you are on and why you climbed, in your reply and in your board record.`;
    },
  });

export type ServerHooks = BridgeHooks & {
  'chat.params'?: (
    input: { sessionID: string; agent: string },
    output: { options: Record<string, unknown> },
  ) => Promise<void>;
  event?: (input: {
    event: {
      type: string;
      properties?: { sessionID?: string; info?: unknown };
    };
  }) => Promise<void>;
  tool?: Record<string, unknown>;
};

/**
 * A session ended. It gives its effort rung back, and the archivist takes
 * what it learned.
 */
async function onSessionIdle(
  client: ClientLike,
  root: string,
  sessionID: string,
  agent: string,
): Promise<void> {
  const role = await roleKeyForAgent(root, agent);

  const rungs = await readRungs(root);
  if (rungs[sessionID]) {
    delete rungs[sessionID];
    await writeRungs(root, rungs);
  }

  // The round the session just finished is checked before the archivist
  // runs: the archivist may open a session of its own, and the round that
  // went nowhere is the one that is still open.
  await observeIdle(client, root, sessionID, agent);

  // A harvest that fails must not break the session that is closing, so it
  // is caught here and put on the record.
  if (!(await harvestEnabled(root))) return;
  try {
    await harvest({
      session: sessionAdapter(client, root),
      root,
      sessionID,
      role,
      agent,
    });
  } catch (error) {
    await recordHarvestFailure(root, { agent, sessionID, error });
  }
}

/**
 * The text the session said last.
 *
 * The report of a round is the last thing the Lead says, so the status the
 * report claims is read out of it.
 */
async function lastTextOf(client: ClientLike, root: string, sessionID: string): Promise<string> {
  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory: root },
  });
  const last = messages.data?.at(-1);
  const parts = last?.parts ?? [];
  const text: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    if (typeof part.text === 'string') text.push(part.text);
  }
  return text.join('\n');
}

/**
 * The status the board holds.
 *
 * The board has no table of round statuses, so the status a round was
 * persisted with is the one a record carries: the Lead writes the state of
 * its round down before it reports it. A board that holds no such record
 * holds no status, and the observer finds nothing to contradict.
 */
function boardRoundStatus(root: string): RoundStatus | undefined {
  const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
  try {
    const { records } = listRecords(db, { limit: 100, markRead: false });
    for (const record of [...records].reverse()) {
      if (isRoundStatus(record.state)) return record.state;
    }
    return undefined;
  } finally {
    closeDatabase(db);
  }
}

/**
 * A failure of the idle path, on the record.
 *
 * The `event` hook is not awaited by OpenCode, so a throw there is a broken
 * session and not a failed check. The failure is written down and the
 * session goes on.
 */
async function recordIdleFailure(
  root: string,
  input: { agent: string; sessionID: string; error: unknown },
): Promise<void> {
  try {
    await appendAudit(root, {
      policyId: POLICIES.eventsFailed.id,
      policyVersion: POLICIES.eventsFailed.version,
      actor: input.agent,
      action: 'idle',
      resource: input.sessionID,
      effect: 'deny',
      detail: input.error instanceof Error ? input.error.message : String(input.error),
      sessionID: input.sessionID,
    });
  } catch {
    // Nowhere left to record it. The session stays silent rather than throw.
  }
}

/**
 * The round of the session that went idle (§8.7).
 *
 * Two things are checked: the status the report claims against the status
 * the board holds, and the rounds that changed nothing.
 *
 * Neither may take the session down. The `event` hook is not awaited by
 * OpenCode, so a throw there is a broken session and not a failed check:
 * the throw of the ledger is caught here, and every failure goes on the
 * record.
 */
async function observeIdle(
  client: ClientLike,
  root: string,
  sessionID: string,
  agent: string,
): Promise<void> {
  try {
    const claimed = claimedStatusOf(await lastTextOf(client, root, sessionID));
    const finding = observeSessionIdle(claimed, () => boardRoundStatus(root), sessionID);
    if (finding !== undefined) {
      await appendAudit(root, {
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
    await recordIdleFailure(root, { agent, sessionID, error });
  }

  try {
    const ledger = openLedger(root);
    try {
      recordNoProgressRounds(ledger, join(root, '.openagentsy', 'board.sqlite'));
    } finally {
      closeLedger(ledger);
    }
  } catch (error) {
    await recordIdleFailure(root, { agent, sessionID, error });
  }
}

/**
 * An assistant message finished. The ledger counts it.
 *
 * The board's cap is compared against what the session really cost, and the
 * ledger is fed here: the plugin is the only part that knows a message was
 * written.
 */
async function onMessageUpdated(
  client: ClientLike,
  root: string,
  event: { type: string; properties?: { sessionID?: string; info?: unknown } },
  sessionAgents: Map<string, string>,
): Promise<void> {
  const message = assistantMessageOf(event);
  if (message === undefined) return;
  const sessionID = event.properties?.sessionID;
  if (sessionID === undefined) return;
  const agent = sessionAgents.get(sessionID);
  // A message with no agent behind it cannot be attributed to a role, and
  // the ledger never guesses a role.
  if (agent === undefined) return;
  const rootSessionID = await rootSessionOf(client, sessionID, root);
  await bridgeToLedger(root, { raw: message, sessionID, rootSessionID, agent });
}

async function setupServer(
  client: ClientLike,
  directory: string,
  worktree: string,
): Promise<ServerHooks> {
  const root = worktree || directory;
  const sessionAgents = new Map<string, string>();
  // The provider inventory changes rarely, and the variant lookup happens on
  // every model call of a climbed session, so it is asked for once.
  let inventory: Promise<ProviderInventory> | undefined;

  // The guardrails of the package, at the hook points the pinned binary
  // fires (§8.2).
  const bridge = createBridge({
    workspace: root,
    stateRoot: root,
    roleForSession: async (sessionID) => {
      const agent = sessionAgents.get(sessionID);
      return agent === undefined ? undefined : roleKeyForAgent(root, agent);
    },
    approvalFor: await readApprovalFor(root),
    onFindings: async (findings, sessionID) => {
      const agent = sessionAgents.get(sessionID) ?? 'unknown';
      await appendAudit(root, {
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
    onPermissionRefusal: async (error) => {
      await appendAudit(root, {
        policyId: POLICIES.permissionRefused.id,
        policyVersion: POLICIES.permissionRefused.version,
        actor: 'openagentsy',
        action: 'permission',
        resource: 'config',
        effect: 'deny',
        detail: error.message,
      });
    },
  });

  return {
    'chat.params': async (input, output) => {
      sessionAgents.set(input.sessionID, input.agent);
      const role = await roleKeyForAgent(root, input.agent);
      const target = await rungTarget(root, role, input.sessionID);
      if (!target) return;
      inventory ??= client.provider.list();

      const options = await variantOptions(client, target.model, target.variant, inventory);
      if (options) Object.assign(output.options, options);
    },

    'tool.execute.before': async (input, output) => {
      // The lease guard is the security property: it decides who may write,
      // and it is the layer that does not depend on a hook firing. The rules
      // of the package are the second layer, and they run after it.
      const agent = sessionAgents.get(input.sessionID);
      await guardWrite(root, input.tool, output.args, agent, input.sessionID);
      await bridge['tool.execute.before'](input, output);
    },

    'tool.execute.after': bridge['tool.execute.after'],
    'chat.message': bridge['chat.message'],
    'experimental.session.compacting': bridge['experimental.session.compacting'],
    'experimental.text.complete': bridge['experimental.text.complete'],
    'shell.env': bridge['shell.env'],
    config: bridge.config,

    event: async ({ event }) => {
      if (event.type === 'message.updated') {
        await onMessageUpdated(client, root, event, sessionAgents);
        return;
      }
      if (event.type !== 'session.idle') return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;
      const agent = sessionAgents.get(sessionID);
      // The map is per server, and a server lives for the whole project, so
      // an entry that is never dropped grows for as long as it runs.
      sessionAgents.delete(sessionID);
      if (!agent) return;
      await onSessionIdle(client, root, sessionID, agent);
    },

    tool: toolMap({ oa_effort: effortTool(root, client) }),
  };
}

const server = async (input: {
  client: unknown;
  directory: string;
  worktree: string;
}): Promise<ServerHooks> => {
  return setupServer(input.client as ClientLike, input.directory, input.worktree);
};

/**
 * OpenCode 2. The same rules, reached through the V2 plugin API.
 *
 * The V2 path lives in its own module because the API is a different shape:
 * a plugin registers hooks and transforms on a context, where V1 returns a
 * map of hook names.
 */
const setup = async (ctx: V2Context): Promise<(() => void) | undefined> => setupV2(ctx);

export default { id: 'openagentsy', setup, server };
