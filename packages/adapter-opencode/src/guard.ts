import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  decideFromLeases,
  type Lease,
  listLeases,
  loadRoles,
  openDatabase,
  type RoleDefinition,
} from '@openagentsy/core';

function stateDir(root: string): string {
  return join(root, '.openagentsy');
}

function auditPath(root: string): string {
  return join(stateDir(root), 'audit.jsonl');
}

function rungsPath(root: string): string {
  return join(stateDir(root), 'rungs.json');
}

/**
 * The leases, read from the board's database.
 *
 * The plugin runtime is Bun, and bun:sqlite is a Bun builtin, so the plugin
 * opens the same database the board server writes. No snapshot file, no
 * staleness window: the guard always sees the leases as they are.
 */
function readLeases(root: string): Lease[] {
  try {
    const db = openDatabase(join(stateDir(root), 'board.sqlite'));
    try {
      return listLeases(db);
    } finally {
      closeDatabase(db);
    }
  } catch {
    // A project with no board yet has no leases.
    return [];
  }
}

export type AuditEffect = 'allow' | 'ask' | 'deny';

export type AuditInput = {
  policyId: string;
  policyVersion: string;
  actor: string;
  action: string;
  resource: string;
  effect: AuditEffect;
  detail?: string | undefined;
  /** The session the decision was taken in, for the harvest packet. */
  sessionID?: string | undefined;
};

export const POLICIES = {
  leaseWrite: { id: 'oa.lease.write', version: 'v1' },
  scopeViolation: { id: 'oa.scope.violation', version: 'v1' },
  effortClimb: { id: 'oa.effort.climb', version: 'v1' },
  effortRefused: { id: 'oa.effort.refused', version: 'v1' },
  harvestFailed: { id: 'oa.harvest.failed', version: 'v1' },
} as const;

export async function appendAudit(root: string, entry: AuditInput): Promise<void> {
  const path = auditPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

export type Rung = {
  rungIndex: number;
  reason: string;
  updatedAt: string;
};

export type RungState = Record<string, Rung>;

export async function readRungs(root: string): Promise<RungState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(rungsPath(root), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as RungState;
  } catch {
    return {};
  }
}

export async function writeRungs(root: string, state: RungState): Promise<void> {
  const path = rungsPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export type WriteDecision = {
  effect: 'allow' | 'deny';
  reason: string;
  owner?: string | undefined;
  glob?: string | undefined;
};

/**
 * The role behind a name, in whichever spelling the name uses.
 *
 * A role is known by its key in the roles file and by the agent name it
 * carries: the Lead's key is 'lead' and its agent name is 'agentsy'. A lease
 * that names one and a session that names the other are the same agent, so
 * both sides are resolved to the role key before they are compared. A name
 * that is not a role at all keeps its own spelling, so a custom agent's
 * lease still works.
 */
function roleKeyOf(roles: { roles: Record<string, RoleDefinition> }, name: string): string {
  const lower = name.toLowerCase();
  for (const [key, role] of Object.entries(roles.roles)) {
    if (key.toLowerCase() === lower) return key;
    if (role.agentName?.toLowerCase() === lower) return key;
  }
  // The agent files are named after the role with an 'oa-' prefix, and the
  // role key is without it.
  if (lower.startsWith('oa-')) {
    const stripped = lower.slice(3);
    for (const key of Object.keys(roles.roles)) {
      if (key.toLowerCase() === stripped) return key;
    }
  }
  return name;
}

/**
 * Decide whether one path may be written.
 *
 * The rules are the ones in the core package, not a second copy.
 */
export async function decideWrite(
  root: string,
  path: string,
  agent: string,
): Promise<WriteDecision> {
  const leases = readLeases(root);
  if (leases.length === 0) {
    return {
      effect: 'deny',
      reason: 'the board has published no leases, so no file is leased. Ask the Lead for a lease.',
    };
  }

  const roles = await loadRoles(join(root, 'roles.yaml'));
  const resolve = (name: string) => roleKeyOf(roles, name);
  const decision = decideFromLeases(leases, path, root, agent, resolve);
  if (decision.status === 'unleased') {
    return {
      effect: 'deny',
      reason: `no lease covers ${decision.path}. Ask the Lead for a lease before writing it.`,
    };
  }
  if (decision.status === 'conflict') {
    return {
      effect: 'deny',
      reason: `${decision.path} is leased to ${decision.agent} on ${decision.bean}, not to ${agent}.`,
      owner: decision.agent,
      glob: decision.glob,
    };
  }
  return {
    effect: 'allow',
    reason: `leased to ${decision.agent} on ${decision.bean}`,
    owner: decision.agent,
    glob: decision.glob,
  };
}

export type LadderRung = { model: string; variant?: string };

export type ClimbPlan =
  | { ok: false; message: string }
  | { ok: true; message: string; target: LadderRung; rungIndex: number };

/**
 * Validate a climb against the lock file and the role definition.
 *
 * A climb moves one rung, needs a reason that names a trigger, and stays
 * inside the ladder the lock file recorded.
 */
export async function planClimb(root: string, role: string, reason: string): Promise<ClimbPlan> {
  const lock = await loadLock(root);
  const entry = lock?.roles[role];
  if (!entry) {
    return { ok: false, message: `no model lock for ${role}. Run: openagentsy models init` };
  }
  if (entry.ladder.length < 2) {
    return {
      ok: false,
      message: `${role} runs on one rung and does not climb. ${entry.model} offers no higher effort level.`,
    };
  }

  const roleDef = await loadRole(root, role);
  const triggers = roleDef?.effort.climbTriggers ?? [];
  if (triggers.length === 0) {
    return { ok: false, message: `${role} has no climb triggers, so it does not climb.` };
  }

  const lowered = reason.toLowerCase();
  const named = triggers.some((trigger) => {
    const plain = trigger.toLowerCase();
    const spaced = plain.replace(/_/g, ' ');
    return lowered.includes(plain) || lowered.includes(spaced);
  });
  if (!named) {
    return {
      ok: false,
      message: `the reason must name a trigger. Valid triggers: ${triggers.join(', ')}`,
    };
  }

  const rungs = await readRungs(root);
  const current = rungs[role]?.rungIndex ?? 0;
  const next = current + 1;
  const target = entry.ladder[next];
  if (next >= entry.ladder.length || target === undefined) {
    return { ok: false, message: `${role} is already at its ceiling.` };
  }

  return {
    ok: true,
    message: `climbed to rung ${next}`,
    target,
    rungIndex: next,
  };
}

export async function recordClimb(
  root: string,
  role: string,
  rungIndex: number,
  reason: string,
): Promise<void> {
  const rungs = await readRungs(root);
  rungs[role] = { rungIndex, reason, updatedAt: new Date().toISOString() };
  await writeRungs(root, rungs);
  await appendAudit(root, {
    policyId: POLICIES.effortClimb.id,
    policyVersion: POLICIES.effortClimb.version,
    actor: role,
    action: 'oa_effort',
    resource: `rung ${rungIndex}`,
    effect: 'allow',
    detail: reason,
  });
}

export async function refuseClimb(root: string, role: string, reason: string): Promise<void> {
  await appendAudit(root, {
    policyId: POLICIES.effortRefused.id,
    policyVersion: POLICIES.effortRefused.version,
    actor: role,
    action: 'oa_effort',
    resource: role,
    effect: 'deny',
    detail: reason,
  });
}

type LockFile = {
  roles: Record<
    string,
    { model: string; ladder: LadderRung[]; evidence?: { label?: string; rank?: number } }
  >;
};

async function loadLock(root: string): Promise<LockFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(root, 'openagentsy.models.lock.json'), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as LockFile;
  } catch {
    return undefined;
  }
}

/**
 * The rung a role climbed to, if it climbed.
 *
 * The rung lives in the state file, the ladder in the lock file, and the
 * rung says which rung of it the role is on. Both runtimes ask this the same
 * way, so the answer is computed once.
 */
export async function rungTarget(
  root: string,
  role: string,
): Promise<{ model: string; variant?: string } | undefined> {
  const rungs = await readRungs(root);
  const rung = rungs[role];
  if (!rung || rung.rungIndex === 0) return undefined;

  const lock = await loadLock(root);
  return lock?.roles[role]?.ladder[rung.rungIndex];
}

async function loadRole(root: string, name: string): Promise<RoleDefinition | undefined> {
  try {
    const roles = await loadRoles(join(root, 'roles.yaml'));
    const byKey = roles.roles[name];
    if (byKey) return byKey;
    // An agent may carry its own name, which the Lead does so the selector
    // shows the project's name. That name resolves back to its role here.
    return Object.values(roles.roles).find(
      (role) => role.agentName !== undefined && role.agentName === name,
    );
  } catch {
    return undefined;
  }
}

/** The role name behind an OpenCode agent id, so oa-builder maps to builder. */
export function roleNameOf(agentId: string): string {
  return agentId.startsWith('oa-') ? agentId.slice(3) : agentId;
}
