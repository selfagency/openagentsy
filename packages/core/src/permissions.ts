import {
  ACTION_NAMES,
  type ActionPermissions,
  type PermissionEffect,
  type RoleDefinition,
} from './types.js';

/**
 * OpenCode V1 permission keys differ from V2 in two places:
 *   - V1 calls the shell tool `bash` and the spawn tool `task`. V2 calls them
 *     `shell` and `subagent`.
 *   - V2 has no `list` and no `lsp` action.
 * Everything else keeps its name, so the mapping stays small on purpose.
 *
 * The V1 `bash` key is not a guess. The live V1 docs describe `shell`, but
 * OpenCode 1.19.3 silently drops a `shell` key in agent frontmatter and only
 * honours `bash`. Verified with `opencode agent list`: the shell patterns of
 * a generated agent are absent from the resolved permissions until the key
 * is `bash`.
 */
const V1_ACTION_NAMES: Record<string, string> = {
  shell: 'bash',
  subagent: 'task',
};

const V2_ACTION_NAMES: Record<string, string> = {
  subagent: 'subagent',
};

/** V2 has no action for these, so the rules are dropped rather than renamed. */
const V2_DROPPED_ACTIONS = new Set(['list', 'lsp']);

export type V1PermissionValue = PermissionEffect | Record<string, PermissionEffect>;

export type V1PermissionBlock = Record<string, V1PermissionValue>;

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
 * The last matching rule wins in both OpenCode versions, so a repeated
 * resource is decided by its final occurrence.
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

export function toV1Permissions(permissions: Record<string, ActionPermissions>): V1PermissionBlock {
  const out: V1PermissionBlock = {};
  for (const action of actionOrder()) {
    const rules = permissions[action];
    if (!rules || rules.length === 0) continue;
    const actionName = V1_ACTION_NAMES[action] ?? action;
    const collapsed = dedupe(rules);
    const first = collapsed[0];
    if (!first) continue;
    if (collapsed.length === 1) {
      out[actionName] = first.effect;
      continue;
    }
    const map: Record<string, PermissionEffect> = {};
    for (const rule of collapsed) map[rule.resource] = rule.effect;
    out[actionName] = map;
  }
  return out;
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
