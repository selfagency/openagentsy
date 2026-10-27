import { check, type Finding } from '@openagentsy/quality';
import { z } from 'zod';
import { readDesignMd } from './rule.js';

/**
 * The tools a session reads the findings with.
 *
 * The rule shows the agent eight lines, so that a check cannot flood the
 * context of the session that wrote the file. The tool returns all of
 * them: the cap is for the context, not for the answer.
 */

/** The names of the quality tools. */
export const qualityToolNames = ['oa_quality_check'] as const;

/** A tool, in the shape the server registers it in. */
export interface QualityTool {
  /** What the tool does, for the model that may call it. */
  description: string;
  /** The arguments the tool takes. */
  args: z.ZodType;
  /** What the tool answers. */
  execute(args: unknown, context: { sessionID: string; agent: string }): Promise<unknown>;
}

/** The quality tools, bound to a project. */
export function qualityTools(options: { workspace: string }): Record<string, QualityTool> {
  return {
    oa_quality_check: {
      description:
        'Check files for the quality rules and return every finding. The paths are relative to the project root.',
      args: z.object({
        paths: z.array(z.string().min(1)).default([]),
      }),
      execute: async (args) => {
        const design = await readDesignMd(options.workspace);
        const ctx = design === undefined ? {} : { design };
        const findings = await check(pathsOf(args), ctx, { root: options.workspace });
        return { findings };
      },
    },
  };
}

/** The paths the call named. */
function pathsOf(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  const paths = (args as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((path): path is string => typeof path === 'string' && path !== '');
}

/** The findings of a check, for the tool to answer with. */
export type QualityFindingList = { findings: Finding[] };
