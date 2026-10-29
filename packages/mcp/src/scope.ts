import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadRoles,
  loadShippedScopeBlocks,
  type RolesFile,
  roleScope,
  type ScopeBlocks,
} from '@openagentsy/core';
import { z } from 'zod';
import { failure, type McpToolResult, text } from './mcp-tool.js';

/**
 * The scope tool.
 *
 * It answers one question: what is this role for, and what does it refuse.
 * It decides nothing. An agent may call it on itself to see its own
 * limits, and a person may call it on a role before they dispatch it.
 *
 * A role with no declaration is reported as a role with no declaration.
 * The tool never invents a scope, and it never guesses one from the
 * description of the role.
 */

/** The name the tool is registered under. */
export const SCOPE_TOOL_NAME = 'oa_scope' as const;

const scopeArgs = z.object({
  role: z
    .string()
    .optional()
    .describe('The role to report on, by its role key or its agent id. Omit for every role.'),
});

/** The tool, in the shape the server registers it in. */
export type ScopeToolDefs = {
  oa_scope: {
    description: string;
    inputSchema: typeof scopeArgs.shape;
    handler: (input: z.infer<typeof scopeArgs>) => Promise<McpToolResult>;
  };
};

/**
 * The roles file of the project, when it has one.
 *
 * A project without a roles file is a project that has not written one
 * yet, and that is not an error: the declarations the package ships answer
 * for the first-party roles on their own. A roles file that is there and
 * broken is an error, and it is reported.
 */
async function loadWorkspaceRoles(workspace: string): Promise<RolesFile | undefined> {
  const path = join(workspace, 'roles.yaml');
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return loadRoles(path);
}

/**
 * Every role that is known, and the declaration each one has.
 *
 * The roles of the project's own file come first, and the roles the package
 * ships come after, so a project that renamed a role sees its own name.
 */
function everyRole(
  roles: RolesFile | undefined,
  blocks: ScopeBlocks | undefined,
): {
  role: string;
  display: string;
  found: boolean;
  source?: string;
  declaration?: unknown;
  message?: string;
}[] {
  const keys = new Set<string>();
  for (const key of Object.keys(roles?.roles ?? {})) keys.add(key);
  for (const key of Object.keys(blocks ?? {})) keys.add(key);
  return [...keys].sort().map((key) => {
    const scope = roleScope(roles, blocks, key);
    if (scope === undefined) {
      return {
        role: key,
        display: key,
        found: false,
        message: 'no scope declared for this role',
      };
    }
    return {
      role: scope.role,
      display: scope.display,
      found: true,
      source: scope.source,
      declaration: scope.declaration,
    };
  });
}

/**
 * The tool, bound to a project.
 *
 * The workspace is where the project's roles file sits; the declarations
 * the package ships are read from the package.
 */
export function createScopeTools(roots: { workspace: string }): ScopeToolDefs {
  return {
    oa_scope: {
      description:
        'The scope of a role: what it is for, what it does, and what it refuses. Name a role, or name none for every role. It decides nothing: an agent may read its own limits with it. A role with no scope declared is reported as such.',
      inputSchema: scopeArgs.shape,
      async handler(input) {
        try {
          const blocks = await loadShippedScopeBlocks();
          const roles = await loadWorkspaceRoles(roots.workspace);

          if (input.role !== undefined) {
            const scope = roleScope(roles, blocks, input.role);
            if (scope === undefined) {
              return text({
                found: false,
                role: input.role,
                message: `no scope declared for this role (${input.role})`,
              });
            }
            return text({ found: true, ...scope });
          }

          return text({ roles: everyRole(roles, blocks) });
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
  };
}
