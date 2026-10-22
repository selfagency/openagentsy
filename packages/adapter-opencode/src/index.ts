import {
  loadLock,
  planClimb,
  readRungs,
  recordClimb,
  refuseClimb,
  roleNameOf,
  writeRungs,
} from './guard.js';
import { tool } from './tool.js';
import { setupV2, type V2Context } from './v2.js';
import { guardWrite } from './write-guard.js';

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

type ProviderModelInfo = {
  variants?: Record<string, Record<string, unknown>>;
};

type ClientLike = {
  provider: {
    list: () => Promise<{
      data?: { all?: { id: string; models: Record<string, ProviderModelInfo> }[] };
    }>;
  };
  session: {
    promptAsync: (options: {
      path: { id: string };
      body: {
        noReply?: boolean;
        agent?: string;
        model?: { providerID: string; modelID: string };
        parts: { type: 'text'; text: string; synthetic?: boolean; ignored?: boolean }[];
      };
    }) => Promise<unknown>;
  };
};

async function variantOptions(
  client: ClientLike,
  modelId: string,
  variant: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!variant) return undefined;
  const separator = modelId.indexOf('/');
  if (separator === -1) return undefined;
  const providerID = modelId.slice(0, separator);
  const modelID = modelId.slice(separator + 1);

  const providers = await client.provider.list();
  const provider = providers.data?.all?.find((entry) => entry.id === providerID);
  const model = provider?.models?.[modelID];
  return model?.variants?.[variant];
}

const effortTool = (root: string, client: ClientLike) =>
  tool({
    description:
      'Climb one rung on the reasoning effort ladder. Only call this when a trigger fired, for example a test failed twice or the change touches concurrency, auth or migrations. The reason must name the trigger.',
    args: {
      reason: tool.schema.string().describe('Why you are climbing. Name the trigger that fired.'),
    },
    async execute(args, context) {
      const role = roleNameOf(context.agent);
      const plan = await planClimb(root, role, args.reason);

      if (!plan.ok) {
        await refuseClimb(root, role, args.reason);
        return plan.message;
      }

      await recordClimb(root, role, plan.rungIndex, args.reason);

      const target = plan.target;

      const separator = target.model.indexOf('/');
      if (separator !== -1) {
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
      }

      return `Climbed to rung ${plan.rungIndex}: ${target.model} ${target.variant ?? 'default'}. Say why in your board record.`;
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
    event: { type: string; properties?: { sessionID?: string } };
  }) => Promise<void>;
  tool?: Record<string, unknown>;
};

async function setupServer(
  client: ClientLike,
  directory: string,
  worktree: string,
): Promise<ServerHooks> {
  const root = worktree || directory;
  const sessionAgents = new Map<string, string>();

  return {
    'chat.message': async (_input) => {},
    'chat.params': async (input, output) => {
      sessionAgents.set(input.sessionID, input.agent);
      const role = roleNameOf(input.agent);
      const rungs = await readRungs(root);
      const rung = rungs[role];
      if (!rung || rung.rungIndex === 0) return;

      const lock = await loadLock(root);
      const target = lock?.roles[role]?.ladder[rung.rungIndex];
      if (!target) return;

      const options = await variantOptions(client, target.model, target.variant);
      if (options) Object.assign(output.options, options);
    },

    'tool.execute.before': async (input, output) => {
      const agent = sessionAgents.get(input.sessionID);
      await guardWrite(root, input.tool, output.args, agent);
    },

    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;
      const agent = sessionAgents.get(sessionID);
      if (!agent) return;
      const role = roleNameOf(agent);
      const rungs = await readRungs(root);
      if (!rungs[role]) return;
      delete rungs[role];
      await writeRungs(root, rungs);
    },

    tool: {
      oa_effort: effortTool(root, client),
    },
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
