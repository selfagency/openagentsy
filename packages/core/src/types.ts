export type PermissionEffect = 'allow' | 'ask' | 'deny';

export type PermissionRule = {
  resource: string;
  effect: PermissionEffect;
};

/**
 * Internal action names. These are the keys used in roles.yaml and they are
 * mapped to version-specific permission keys at generation time, so one role
 * definition covers both OpenCode versions.
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
  description: string;
  mode: 'primary' | 'subagent';
  hidden: boolean;
  writes: boolean;
  steps: number;
  scope: string;
  guidance: string;
  permissions: Record<string, ActionPermissions>;
  skills: string[];
  modelProfile: ModelProfile;
  effort: EffortLadder;
};

export type RolesFile = {
  version: number;
  protectedPaths: string[];
  roles: Record<string, RoleDefinition>;
};

export type Target = 'v1' | 'v2';
