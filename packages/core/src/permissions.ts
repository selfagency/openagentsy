import {
  ACTION_NAMES,
  type ActionName,
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

/**
 * The catch-all of the V1 spawn-tool map is written with two asterisks.
 *
 * The magic-context plugin rewrites an agent's own `permission.task` map: a
 * literal `*` key with effect deny is dropped and re-appended last. OpenCode
 * takes the last matching rule, so the catch-all then beats the named allows
 * and the Task tool leaves the toolset. Measured on 2026-10-24 with two probe
 * agents: an asterisk catch-all deny plus one named allow produced no task
 * tool at all, and the same map with a double asterisk catch-all dispatched
 * the named agent and refused an unlisted one. An OpenCode permission pattern
 * is a wildcard where a single asterisk matches zero or more of any
 * character, so a double asterisk matches every agent id as well.
 *
 * Upstream fixed the plugin in 0.49.24 (cortexkit/magic-context#777): it now
 * moves the wildcard only when it stands alone, so a named allow survives.
 * The workaround stays on purpose. A single asterisk is the canonical shape
 * and this is not: but the double asterisk behaves identically under both the
 * fixed and the unfixed plugin, the OpenCode server caches the agent
 * definitions it reads, and an agent that loses its Task tool cannot dispatch
 * anything at all - so the shape that is safe on every version wins until the
 * plugin version in use is known to be 0.49.24 or newer. Changing this back
 * is a one-line edit plus `openagentsy build`, and it wants a server restart
 * and a dispatch that works, in that order.
 */
const V1_TASK_CATCH_ALL = '**';

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

/**
 * Collapse one action's rules to its OpenCode value: a single rule becomes
 * its effect, several become a resource-to-effect map.
 */
function collapsedValue(rules: ActionPermissions): V1PermissionValue | undefined {
  const collapsed = dedupe(rules);
  const first = collapsed[0];
  if (!first) return undefined;
  if (collapsed.length === 1) return first.effect;
  const map: Record<string, PermissionEffect> = {};
  for (const rule of collapsed) map[rule.resource] = rule.effect;
  return map;
}

/**
 * Write the catch-all of a spawn-tool map so the plugin leaves it in place.
 *
 * Only a map of several rules is rewritten: the shorthand form of a single
 * rule is the effect alone and carries no catch-all to move. The order of the
 * rules is kept, so a catch-all written first stays first and the named
 * allows still win the last-match-wins comparison.
 */
function withTaskCatchAll(value: V1PermissionValue): V1PermissionValue {
  if (typeof value === 'string') return value;
  if (!('*' in value)) return value;
  const out: Record<string, PermissionEffect> = {};
  for (const [resource, effect] of Object.entries(value)) {
    out[resource === '*' ? V1_TASK_CATCH_ALL : resource] = effect;
  }
  return out;
}

export function toV1Permissions(permissions: Record<string, ActionPermissions>): V1PermissionBlock {
  const out: V1PermissionBlock = {};
  for (const [action, rules] of Object.entries(permissions)) {
    if (!rules || rules.length === 0) continue;
    const value = collapsedValue(rules);
    if (value === undefined) continue;
    // A key that is not an action names a tool, and a tool keeps its name in
    // both versions. The renamed actions stay renamed.
    const key = V1_ACTION_NAMES[action] ?? action;
    // The spawn tool is the one the plugin rewrites, so its catch-all is the
    // one written with two asterisks. Every other action keeps a single one.
    out[key] = key === 'task' ? withTaskCatchAll(value) : value;
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
