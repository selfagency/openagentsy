import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { parseScopeBlock, type ScopeBlock } from './scope/block.js';
import {
  ACTION_NAMES,
  type ActionName,
  type ActionPermissions,
  type CostStance,
  type EffortLadder,
  type ModelProfile,
  type ModelSignal,
  type PermissionEffect,
  type PermissionRule,
  type RoleDefinition,
  type RolesFile,
} from './types.js';

export class RolesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RolesError';
  }
}

/**
 * Agent ids are prefixed so they never collide with the built-in OpenCode
 * agents. V1 ships a built-in `scout`, so an unprefixed role name would
 * silently shadow or be shadowed by it.
 */
export const AGENT_PREFIX = 'oa-';

export function agentId(roleName: string): string {
  return `${AGENT_PREFIX}${roleName}`;
}

/**
 * The names an agent answers to.
 *
 * The Lead has two: the role key `lead` and the agent id `agentsy` (the
 * agent file a person picks in the selector). Every other role's two names
 * differ only by the `oa-` prefix. A record addressed to one of these names
 * reaches a session that reads under the other: the archivist addresses the
 * Lead as `Lead` and the Lead session reads as `lead`, and the finding
 * stayed on the board (measured 2026-10-27, the fault case's own board).
 */
export function agentAliases(name: string): string[] {
  const lower = name.toLowerCase();
  if (lower === 'lead' || lower === 'agentsy') return ['lead', 'agentsy'];
  if (lower.startsWith(AGENT_PREFIX)) return [lower, lower.slice(AGENT_PREFIX.length)];
  return [lower, `${AGENT_PREFIX}${lower}`];
}

/**
 * The id an agent is known by. A role may name its own agent, which the Lead
 * does so a person picks the project's name in the selector.
 */
export function agentIdOf(role: RoleDefinition): string {
  return role.agentName ?? agentId(role.name);
}

/**
 * The agent id of a role, by role name.
 *
 * A command names the role it runs as, not the agent id, so a role that
 * renames itself in `roles.yaml` renames the command with it.
 */
export function agentIdFor(roles: RolesFile, roleName: string): string {
  const role = roles.roles[roleName];
  if (!role) throw new RolesError(`no role "${roleName}" in the roles file`);
  return agentIdOf(role);
}

const EFFECTS: readonly PermissionEffect[] = ['allow', 'ask', 'deny'];
const SIGNALS: readonly ModelSignal[] = ['agentic', 'coding', 'overall', 'long_context'];
const COST_STANCES: readonly CostStance[] = [
  'quality_first',
  'balanced',
  'cheapest',
  'ignore_cost',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RolesError(`${where}: expected a non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RolesError(`${where}: expected true or false`);
  }
  return value;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RolesError(`${where}: expected a number`);
  }
  return value;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new RolesError(`${where}: expected a list of strings`);
  }
  return value.map((entry, index) => asString(entry, `${where}[${index}]`));
}

function parseEffect(value: unknown, where: string): PermissionEffect {
  const effect = asString(value, where);
  if (!EFFECTS.includes(effect as PermissionEffect)) {
    throw new RolesError(`${where}: expected one of ${EFFECTS.join(', ')}, got "${effect}"`);
  }
  return effect as PermissionEffect;
}

/**
 * Normalise one action's permission block.
 *
 * A bare string is shorthand for one rule against every resource. A list
 * holds ordered rules, because the last matching rule wins.
 */
function parseRules(value: unknown, where: string): ActionPermissions {
  if (typeof value === 'string') {
    return [{ resource: '*', effect: parseEffect(value, where) }];
  }
  if (!Array.isArray(value)) {
    throw new RolesError(`${where}: expected a string or a list of rules`);
  }
  return value.map((raw, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(raw)) {
      throw new RolesError(`${at}: expected a rule object`);
    }
    const resource = raw.resource === undefined ? '*' : asString(raw.resource, `${at}.resource`);
    return { resource, effect: parseEffect(raw.effect, `${at}.effect`) };
  });
}

function parsePermissions(value: unknown, where: string): Record<string, ActionPermissions> {
  if (!isRecord(value)) {
    throw new RolesError(`${where}: expected a mapping of action to rules`);
  }
  const out: Record<string, ActionPermissions> = {};
  for (const [action, rules] of Object.entries(value)) {
    if (!ACTION_NAMES.includes(action as ActionName) && !isToolName(action)) {
      throw new RolesError(
        `${where}.${action}: unknown action. Known actions: ${ACTION_NAMES.join(', ')}. A key that is not an action must name a tool, as in openagentsy_board_lease_grant.`,
      );
    }
    out[action] = parseRules(rules, `${where}.${action}`);
  }
  return out;
}

/**
 * A permission key that is not an action names a tool.
 *
 * OpenCode's agent permission map takes any tool name as a key, and that is
 * how a role is kept away from a tool it must not call. The board's lease
 * grant is the case that matters: only the Lead may widen a lease, so every
 * other role denies that tool by name.
 *
 * An MCP tool is always `server_tool`, so the name carries an underscore. A
 * key without one is a typo, not a tool.
 */
function isToolName(name: string): boolean {
  return /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(name);
}

function parseModelProfile(value: unknown, where: string): ModelProfile {
  if (!isRecord(value)) {
    throw new RolesError(`${where}: expected a mapping`);
  }
  const signal = asString(value.primarySignal, `${where}.primarySignal`);
  if (!SIGNALS.includes(signal as ModelSignal)) {
    throw new RolesError(`${where}.primarySignal: expected one of ${SIGNALS.join(', ')}`);
  }
  const stance = asString(value.costStance, `${where}.costStance`);
  if (!COST_STANCES.includes(stance as CostStance)) {
    throw new RolesError(`${where}.costStance: expected one of ${COST_STANCES.join(', ')}`);
  }

  const profile: ModelProfile = {
    primarySignal: signal as ModelSignal,
    hardRequirements: asStringArray(value.hardRequirements ?? [], `${where}.hardRequirements`),
    costStance: stance as CostStance,
  };
  if (value.minimumRank !== undefined) {
    profile.minimumRank = asNumber(value.minimumRank, `${where}.minimumRank`);
  }
  if (value.minimumContext !== undefined) {
    profile.minimumContext = asNumber(value.minimumContext, `${where}.minimumContext`);
  }
  if (value.expectedCallsPer5h !== undefined) {
    profile.expectedCallsPer5h = asNumber(value.expectedCallsPer5h, `${where}.expectedCallsPer5h`);
  }
  if (value.benchmark !== undefined) {
    profile.benchmark = asString(value.benchmark, `${where}.benchmark`);
  }
  if (value.differentCreatorThan !== undefined) {
    profile.differentCreatorThan = asString(
      value.differentCreatorThan,
      `${where}.differentCreatorThan`,
    );
  }
  return profile;
}

function parseEffort(value: unknown, where: string): EffortLadder {
  if (!isRecord(value)) {
    throw new RolesError(`${where}: expected a mapping`);
  }
  const effort: EffortLadder = {
    startVariant: asString(value.startVariant, `${where}.startVariant`),
    ceilingVariant: asString(value.ceilingVariant, `${where}.ceilingVariant`),
    climbTriggers: asStringArray(value.climbTriggers ?? [], `${where}.climbTriggers`),
  };
  if (value.ceilingModelRole !== undefined) {
    effort.ceilingModelRole = asString(value.ceilingModelRole, `${where}.ceilingModelRole`);
  }
  return effort;
}

/**
 * The skill allowlist is the single source of truth for skill access.
 * The `skill` permission block is derived from it, never read from the file.
 */
function skillRules(skills: string[]): ActionPermissions {
  if (skills.length === 0) {
    return [{ resource: '*', effect: 'allow' }];
  }
  return [
    { resource: '*', effect: 'deny' },
    ...skills.map((skill) => ({ resource: skill, effect: 'allow' as const })),
  ];
}

/**
 * The skills a role may load, and the routing that says when.
 *
 * The field is a list of skill names, or a mapping with the list under
 * `allow` and the routing under `routing`. A role with no list loads
 * every skill, so the list stays the single source of truth for the
 * `skill` permission, and the routing is the text that says which
 * skill a change loads.
 */
function parseSkills(
  value: unknown,
  where: string,
): { allow: string[]; routing?: string | undefined } {
  if (value === undefined) return { allow: [] };
  if (Array.isArray(value)) return { allow: asStringArray(value, where) };
  if (!isRecord(value)) {
    throw new RolesError(`${where}: expected a list of skill names or a mapping`);
  }
  const allow = value.allow === undefined ? [] : asStringArray(value.allow, `${where}.allow`);
  const routing =
    value.routing === undefined ? undefined : asString(value.routing, `${where}.routing`);
  return { allow, routing };
}

/**
 * The scope of a role.
 *
 * A role's `scope:` is either a sentence or a block. The sentence says what
 * the role is for in prose, and it is what the agent's prompt carries. The
 * block says it in the shape the scope check matches a request against, and
 * it is what the declaration of the role is built from. A role with a block
 * has both: the block's purpose is the sentence the prompt carries.
 */
function parseScope(
  value: unknown,
  where: string,
): { text: string; block: ScopeBlock | undefined } {
  if (typeof value === 'string') {
    return { text: asString(value, where), block: undefined };
  }
  if (isRecord(value)) {
    try {
      const block = parseScopeBlock(value, where);
      return { text: block.purpose, block };
    } catch (error) {
      throw new RolesError(error instanceof Error ? error.message : String(error));
    }
  }
  throw new RolesError(`${where}: expected a sentence or a scope block`);
}

/**
 * The permissions of a role: the defaults, with the role's own rules over them.
 *
 * The last rule wins, so a role's own rule about an action is the one that
 * applies, and a rule the role does not mention keeps the default.
 */
function mergePermissions(
  defaults: Record<string, ActionPermissions>,
  rolePermissions: Record<string, ActionPermissions>,
): Record<string, ActionPermissions> {
  const merged: Record<string, ActionPermissions> = {};
  for (const [action, rules] of Object.entries(defaults)) {
    merged[action] = rules;
  }
  for (const [action, rules] of Object.entries(rolePermissions)) {
    merged[action] = rules;
  }
  return merged;
}

/**
 * The agent id of a role, when it has one.
 *
 * The id is what the agent is called, and it has to be a lowercase agent id
 * with a dash in it, because that is what the host accepts.
 */
function parseAgentName(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  const agentName = asString(value, where);
  if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
    throw new RolesError(`${where}: expected a lowercase agent id, got "${agentName}"`);
  }
  return agentName;
}

function parseRole(
  name: string,
  raw: unknown,
  defaults: Record<string, ActionPermissions>,
  defaultsMeta: { hidden: boolean; steps: number },
): RoleDefinition {
  const where = `roles.${name}`;
  if (!isRecord(raw)) {
    throw new RolesError(`${where}: expected a mapping`);
  }

  const mode = asString(raw.mode, `${where}.mode`);
  if (mode !== 'primary' && mode !== 'subagent') {
    throw new RolesError(`${where}.mode: expected "primary" or "subagent"`);
  }

  const merged = mergePermissions(
    defaults,
    parsePermissions(raw.permissions ?? {}, `${where}.permissions`),
  );

  const skills = parseSkills(raw.skills, `${where}.skills`);
  merged.skill = skillRules(skills.allow);

  const agentName = parseAgentName(raw.agentName, `${where}.agentName`);

  const scope = parseScope(raw.scope, `${where}.scope`);

  return {
    name,
    ...(agentName !== undefined ? { agentName } : {}),
    description: asString(raw.description, `${where}.description`),
    mode,
    hidden:
      raw.hidden === undefined ? defaultsMeta.hidden : asBoolean(raw.hidden, `${where}.hidden`),
    writes: asBoolean(raw.writes, `${where}.writes`),
    steps: raw.steps === undefined ? defaultsMeta.steps : asNumber(raw.steps, `${where}.steps`),
    scope: scope.text,
    ...(scope.block !== undefined ? { scopeBlock: scope.block } : {}),
    guidance: asString(raw.guidance, `${where}.guidance`),
    permissions: merged,
    skills: skills.allow,
    ...(skills.routing !== undefined ? { skillRouting: skills.routing } : {}),
    modelProfile: parseModelProfile(raw.modelProfile, `${where}.modelProfile`),
    effort: parseEffort(raw.effort, `${where}.effort`),
  };
}

export function parseRoles(text: string): RolesFile {
  const raw: unknown = parse(text);
  if (!isRecord(raw)) {
    throw new RolesError('roles file: expected a mapping at the top level');
  }

  const version = asNumber(raw.version, 'version');
  if (version !== 1) {
    throw new RolesError(`version: expected 1, got ${version}`);
  }

  const protectedPaths = asStringArray(raw.protectedPaths ?? [], 'protectedPaths');

  const rawDefaults = isRecord(raw.defaults) ? raw.defaults : {};
  const defaultPermissions = parsePermissions(
    rawDefaults.permissions ?? {},
    'defaults.permissions',
  );
  const defaultsMeta = {
    hidden:
      rawDefaults.hidden === undefined ? false : asBoolean(rawDefaults.hidden, 'defaults.hidden'),
    steps: rawDefaults.steps === undefined ? 40 : asNumber(rawDefaults.steps, 'defaults.steps'),
  };

  const rawRoles = raw.roles;
  if (!isRecord(rawRoles)) {
    throw new RolesError('roles: expected a mapping of role name to definition');
  }

  const roles: Record<string, RoleDefinition> = {};
  for (const [name, definition] of Object.entries(rawRoles)) {
    roles[name] = parseRole(name, definition, defaultPermissions, defaultsMeta);
  }

  if (Object.keys(roles).length === 0) {
    throw new RolesError('roles: at least one role is required');
  }

  return { version, protectedPaths, roles };
}

export async function loadRoles(path: string): Promise<RolesFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new RolesError(`cannot read roles file at ${path}: ${(error as Error).message}`);
  }
  return parseRoles(text);
}

/** Rule helpers shared by the generator and the board. */
export function firstRule(rules: ActionPermissions): PermissionRule | undefined {
  return rules[0];
}
