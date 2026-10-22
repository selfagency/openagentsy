import {
  agentId,
  type RoleDefinition,
  type RolesFile,
  type Target,
  toV1Permissions,
  toV2Permissions,
  withProtectedPaths,
} from '@openagentsy/core';
import { stringify } from 'yaml';
import { renderPrompt } from './prompt.js';

export type AgentRenderOptions = {
  target: Target;
  model?: string;
  modelVariant?: string;
  effort?: { start?: string; ceiling?: string };
};

type Frontmatter = Record<string, unknown>;

function v1Frontmatter(
  role: RoleDefinition,
  permissions: Record<string, ReturnType<typeof toV1Permissions>[string]>,
  model: string | undefined,
): Frontmatter {
  const frontmatter: Frontmatter = {
    description: role.description,
    mode: role.mode,
  };
  if (model) frontmatter.model = model;
  frontmatter.steps = role.steps;
  if (role.hidden) frontmatter.hidden = true;
  frontmatter.permission = permissions;
  return frontmatter;
}

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
 * Render one agent file for one OpenCode target.
 *
 * V1 takes a `permission` map and calls the spawn tool `task`. V2 takes an
 * ordered `permissions` list and calls it `subagent`. The role definition is
 * identical for both, so the mapping lives here and nowhere else.
 */
export function renderAgent(
  role: RoleDefinition,
  roles: RolesFile,
  options: AgentRenderOptions,
): string {
  const permissions = withProtectedPaths(role, roles.protectedPaths);

  const frontmatter =
    options.target === 'v1'
      ? v1Frontmatter(role, toV1Permissions(permissions), options.model)
      : v2Frontmatter(role, toV2Permissions(permissions), options.model, options.modelVariant);

  return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${renderPrompt(role, options.effort ?? {})}`;
}

export function agentFileName(role: RoleDefinition): string {
  return `${role.agentName ?? agentId(role.name)}.md`;
}
