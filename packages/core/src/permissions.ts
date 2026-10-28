import {
  ACTION_NAMES,
  type ActionName,
  type ActionPermissions,
  type PermissionEffect,
  type RoleDefinition,
} from './types.js';

/**
 * The names the actions carry in OpenCode 2.
 *
 * The spawn tool is the one that is renamed: the role vocabulary says
 * `subagent` and OpenCode 2 calls it `subagent` too, so the map is the
 * place the name is written down rather than repeated in a branch.
 */
const V2_ACTION_NAMES: Record<string, string> = {
  subagent: 'subagent',
};

/** V2 has no action for these, so the rules are dropped rather than renamed. */
const V2_DROPPED_ACTIONS = new Set(['list', 'lsp']);

export type V2PermissionRule = {
  action: string;
  resource: string;
  effect: PermissionEffect;
};

function actionOrder(): string[] {
  return [...ACTION_NAMES];
}

/**
 * Collapse rules that target the same resource, keeping the last one.
 * The last matching rule wins in OpenCode, so a repeated resource is
 * decided by its final occurrence.
 */
function dedupe(rules: ActionPermissions): ActionPermissions {
  const order: string[] = [];
  const byResource = new Map<string, PermissionEffect>();
  for (const rule of rules) {
    if (!byResource.has(rule.resource)) order.push(rule.resource);
    byResource.set(rule.resource, rule.effect);
  }
  return order.map((resource) => {
    const effect = byResource.get(resource);
    if (effect === undefined) throw new Error(`no effect for ${resource}`);
    return { resource, effect };
  });
}

export function toV2Permissions(
  permissions: Record<string, ActionPermissions>,
): V2PermissionRule[] {
  const out: V2PermissionRule[] = [];
  for (const action of actionOrder()) {
    const rules = permissions[action];
    if (!rules || rules.length === 0) continue;
    if (V2_DROPPED_ACTIONS.has(action)) continue;
    const actionName = V2_ACTION_NAMES[action] ?? action;
    for (const rule of dedupe(rules)) {
      out.push({ action: actionName, resource: rule.resource, effect: rule.effect });
    }
  }
  for (const [tool, rules] of Object.entries(permissions)) {
    if (actionOrder().includes(tool as ActionName)) continue;
    for (const rule of dedupe(rules)) {
      out.push({ action: tool, resource: rule.resource, effect: rule.effect });
    }
  }
  return out;
}

/**
 * Append the protected-path rules to the edit permissions of a write-capable
 * role. The general rule stays first so the specific protected path wins the
 * last-match-wins comparison and asks the human instead of allowing the write.
 */
export function withProtectedPaths(
  role: RoleDefinition,
  protectedPaths: string[],
): Record<string, ActionPermissions> {
  if (!role.writes || protectedPaths.length === 0) {
    return role.permissions;
  }

  const edit = role.permissions.edit;
  if (!edit) return role.permissions;

  const deniesEverything = edit.some((rule) => rule.resource === '*' && rule.effect === 'deny');
  if (deniesEverything) return role.permissions;

  return {
    ...role.permissions,
    edit: [...edit, ...protectedPaths.map((path) => ({ resource: path, effect: 'ask' as const }))],
  };
}
