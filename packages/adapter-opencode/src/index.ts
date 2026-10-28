import { setupV2, type V2Context } from './v2.js';

export type { ToolCtx, ToolDef, V2ToolDefinition } from '@openagentsy/core';
/**
 * The tool definition helper.
 *
 * A package that registers tools of its own defines them once and hands
 * them to the runtime through this.
 */
export { defineTool, toolMap, v2Tool } from '@openagentsy/core';

/**
 * OpenAgentsy for OpenCode 2.
 *
 * The plugin default-exports `{ id, setup }`, and OpenCode 2 calls `setup`
 * with the plugin context. The context registers hooks, transforms, tools
 * and a subscription on the host, and the v2 path in `v2.ts` does the
 * registering.
 *
 * What the plugin does:
 *   - refuses a write to a file that no lease covers, or that another agent
 *     owns, and writes the decision to the audit log
 *   - applies the reasoning effort level of the rung a role climbed to
 *   - offers the oa_effort tool, which is the only way to climb
 */

/**
 * OpenCode 2. The same rules, reached through the V2 plugin API.
 *
 * The V2 path lives in its own module because the API is a different shape:
 * a plugin registers hooks and transforms on a context, where V1 returned a
 * map of hook names.
 */
const setup = async (ctx: V2Context): Promise<(() => void) | undefined> => setupV2(ctx);

export default { id: 'openagentsy', setup };
