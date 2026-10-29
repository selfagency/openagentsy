import type { ScopeBlock } from './scope/block.js';

export type PermissionEffect = 'allow' | 'ask' | 'deny';

export type PermissionRule = {
  resource: string;
  effect: PermissionEffect;
};

/**
 * Internal action names. These are the keys used in roles.yaml and they are
 * mapped to the OpenCode permission keys at generation time, so the role
 * definition carries the vocabulary of the project and not the vocabulary of
 * the host.
 */
export const ACTION_NAMES = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'shell',
  'subagent',
  'skill',
  'webfetch',
  'websearch',
  'external_directory',
  'lsp',
  'question',
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export type ActionPermissions = PermissionRule[];

export type ModelSignal = 'agentic' | 'coding' | 'overall' | 'long_context';

export type CostStance = 'quality_first' | 'balanced' | 'cheapest' | 'ignore_cost';

export type ModelProfile = {
  primarySignal: ModelSignal;
  hardRequirements: string[];
  costStance: CostStance;
  minimumRank?: number;
  minimumContext?: number;
  /** Expected calls in a five hour window, used for the quota check. */
  expectedCallsPer5h?: number;
  benchmark?: string;
  differentCreatorThan?: string;
};

export type EffortLadder = {
  startVariant: string;
  ceilingVariant: string;
  climbTriggers: string[];
  /** Role whose model the ceiling rung uses. Defaults to the role itself. */
  ceilingModelRole?: string;
};

export type RoleDefinition = {
  name: string;
  /**
   * The agent's id, when it is not the default `oa-<role>`. The Lead is the
   * one a person picks in the agent selector, so it carries the project's
   * name instead of a role name.
   */
  agentName?: string;
  description: string;
  mode: 'primary' | 'subagent';
  hidden: boolean;
  writes: boolean;
  steps: number;
  scope: string;
  /**
   * The scope block of the role, when its `scope:` is a block and not a
   * sentence.
   *
   * A role that declares a block says what it is for, and the block is what
   * the scope check matches a request against. A role that declares a
   * sentence has no block, and the scope of such a role is whatever the
   * sentence says.
   */
  scopeBlock?: ScopeBlock;
  guidance: string;
  permissions: Record<string, ActionPermissions>;
  /** The skills the role may load. Empty means every skill. */
  skills: string[];
  /**
   * The routing that says when a skill loads, when the role has one.
   *
   * The text belongs to the role: it names the conditions, so the token
   * test can check them and the agent can act on them.
   */
  skillRouting?: string;
  modelProfile: ModelProfile;
  effort: EffortLadder;
};

export type RolesFile = {
  version: number;
  protectedPaths: string[];
  roles: Record<string, RoleDefinition>;
};

/**
 * The OpenCode version the project targets.
 *
 * There is one: OpenCode 2. The type is kept because the doctor reports the
 * target and the generator writes for it, and a project that grows a second
 * runtime gets a second member here.
 */
export type Target = 'v2';
