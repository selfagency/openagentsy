import {
  agentId,
  type RoleDefinition,
  type RolesFile,
  toV2Permissions,
  withProtectedPaths,
} from '@openagentsy/core';
import { stringify } from 'yaml';
import { renderPrompt } from './prompt.js';

export type AgentRenderOptions = {
  model?: string;
  modelVariant?: string;
  effort?: { start?: string; ceiling?: string };
};

type Frontmatter = Record<string, unknown>;

function v2Frontmatter(
  role: RoleDefinition,
  permissions: ReturnType<typeof toV2Permissions>,
  model: string | undefined,
  modelVariant: string | undefined,
): Frontmatter {
  const frontmatter: Frontmatter = {
    description: role.description,
    mode: role.mode,
  };
  if (model) frontmatter.model = modelVariant ? `${model}#${modelVariant}` : model;
  frontmatter.steps = role.steps;
  if (role.hidden) frontmatter.hidden = true;
  frontmatter.permissions = permissions;
  return frontmatter;
}

function renderFrontmatter(frontmatter: Frontmatter): string {
  return stringify(frontmatter, { lineWidth: 0 }).trimEnd();
}

/**
 * Render one agent file for OpenCode 2.
 *
 * The frontmatter takes an ordered `permissions` list and calls the spawn
 * tool `subagent`. The role definition carries the vocabulary of the
 * project, and the mapping onto the host lives in `@openagentsy/core`.
 */
export function renderAgent(
  role: RoleDefinition,
  roles: RolesFile,
  options: AgentRenderOptions,
): string {
  const permissions = withProtectedPaths(role, roles.protectedPaths);

  const frontmatter = v2Frontmatter(
    role,
    toV2Permissions(permissions),
    options.model,
    options.modelVariant,
  );

  return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${renderPrompt(role, options.effort ?? {})}`;
}

export function agentFileName(role: RoleDefinition): string {
  return `${role.agentName ?? agentId(role.name)}.md`;
}
