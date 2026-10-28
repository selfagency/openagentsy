import { buildConformanceReport } from '@openagentsy/core';
import { z } from 'zod';
import { failure, type McpToolResult, text } from './mcp-tool.js';

/**
 * The conformance tool (§11).
 *
 * The plan says `oa conformance` is a command and a tool, and the two
 * report the same thing: what is proven, observed or unverified, one
 * capability of the host at a time.
 *
 * The tool reads. It never writes, because a capability becomes `observed`
 * only when a live session has seen it working, and a caller that could
 * write the evidence could make a capability observed without anything
 * having been observed. The write path is in the evidence store, and a
 * session's event listener is what calls it.
 */

/** The name the tool is registered under. */
export const CONFORMANCE_TOOL_NAME = 'oa_conformance_report' as const;

const reportArgs = z.object({});

/** The tool, in the shape the server registers it in. */
export type ConformanceToolDefs = {
  oa_conformance_report: {
    description: string;
    inputSchema: typeof reportArgs.shape;
    handler: (input: z.infer<typeof reportArgs>) => Promise<McpToolResult>;
  };
};

/**
 * The tool, bound to a project.
 *
 * The workspace is where the probes read the project's own files, and the
 * state root is where the evidence of the project lives.
 */
export function createConformanceTools(roots: {
  workspace: string;
  stateRoot: string;
}): ConformanceToolDefs {
  return {
    oa_conformance_report: {
      description:
        'What is proven, observed or unverified: one capability of the OpenCode host at a time, with the state it is in and the evidence of an observed one. A capability is observed only when a live session has seen it working, and the tool never writes the evidence.',
      inputSchema: reportArgs.shape,
      async handler() {
        try {
          const report = await buildConformanceReport({
            workspace: roots.workspace,
            stateRoot: roots.stateRoot,
          });
          return text({
            generatedAt: report.generatedAt,
            counts: report.counts,
            capabilities: report.capabilities.map((entry) => ({
              id: entry.id,
              host: entry.host,
              state: entry.state,
              title: entry.title,
              ...(entry.verifyRef === undefined ? {} : { verifyRef: entry.verifyRef }),
              observeOn: entry.observeOn,
              evidence: entry.evidence.map((observation) => ({
                eventType: observation.eventType,
                at: observation.at,
                kind: observation.kind,
                source: observation.source,
                note: observation.note,
              })),
            })),
            pluginOrderWarnings: report.pluginOrderWarnings,
            voided: report.voided,
          });
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
  };
}
