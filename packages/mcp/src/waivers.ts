import { waive } from '@openagentsy/hooks/quality/waive';
import { z } from 'zod';
import { failure, type McpToolResult, text } from './mcp-tool.js';

/**
 * The waiver tool.
 *
 * A waiver is a decision a person makes, and the permission map denies this
 * tool to every agent role (roles.yaml). The command a person runs calls
 * the same code, so the decision has one implementation and one audit
 * trail.
 *
 * The map is the primary enforcement and this tool is the reason for it:
 * the hook cannot see an MCP call on the pinned binary, so the tool is
 * taken away from the agents rather than trusted. The hook rule is the
 * second layer, for a host that fires it.
 */

/** The name the tool is registered under. */
export const WAIVER_TOOL_NAME = 'oa_quality_waive' as const;

const waiveArgs = z.object({
  ruleId: z.string().min(1).describe('The rule the waiver is for'),
  path: z.string().min(1).describe('The path the waiver covers'),
  reason: z.string().min(10).describe('Why the rule does not apply here. Ten characters at least'),
  decidedBy: z.string().min(1).describe('Who decided. A person, never an agent'),
});

/** The tool, in the shape the server registers it in. */
export type WaiverToolDefs = {
  oa_quality_waive: {
    description: string;
    inputSchema: typeof waiveArgs.shape;
    handler: (input: z.infer<typeof waiveArgs>) => Promise<McpToolResult>;
  };
};

/**
 * The tool, bound to a project.
 *
 * The root is the state root the waivers live under, the same root the
 * board uses.
 */
export function createWaiverTools(root: string): WaiverToolDefs {
  return {
    oa_quality_waive: {
      description:
        'Record a quality waiver: this rule is not a problem in this file, and here is why. A person decides, and the permission map denies this tool to every agent role. A floor rule cannot be waived at all.',
      inputSchema: waiveArgs.shape,
      async handler(input) {
        try {
          const waiver = await waive({
            stateRoot: root,
            ruleId: input.ruleId,
            path: input.path,
            reason: input.reason,
            decidedBy: input.decidedBy,
          });
          return text({
            ruleId: waiver.ruleId,
            path: waiver.path,
            decidedBy: waiver.decidedBy,
            ts: waiver.ts,
          });
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
  };
}
