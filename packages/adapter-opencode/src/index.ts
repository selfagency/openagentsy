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
import { assistantMessageOf, bridgeToLedger, rootSessionOf } from './ledger-bridge.js';
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

export type ServerHooks = {
  'chat.params'?: (
    input: { sessionID: string; agent: string },
    output: { options: Record<string, unknown> },
  ) => Promise<void>;
  'chat.message'?: (
    input: { sessionID: string; agent?: string | undefined },
    output: unknown,
  ) => Promise<void>;
  'tool.execute.before'?: (
    input: { tool: string; sessionID: string },
    output: { args: unknown },
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
      const agent = sessionAgents.get(input.sessionID);
      await guardWrite(root, input.tool, output.args, agent, input.sessionID);
    },

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
