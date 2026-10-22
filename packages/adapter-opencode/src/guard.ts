import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decideFromLeases, type Lease, loadRoles, type RoleDefinition } from '@openagentsy/core';

export function stateDir(root: string): string {
  return join(root, '.openagentsy');
}

export function auditPath(root: string): string {
  return join(stateDir(root), 'audit.jsonl');
}

export function rungsPath(root: string): string {
  return join(stateDir(root), 'rungs.json');
}

/**
 * The leases, as the board published them.
 *
 * The board owns the database. The plugin cannot read it: the plugin runtime
 * has no sqlite module, and a plugin that imports one fails to load at all.
 * The board writes this file instead.
 */
export function leaseSnapshotPath(root: string): string {
  return join(stateDir(root), 'leases.json');
}

export async function readLeases(root: string): Promise<Lease[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(leaseSnapshotPath(root), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const leases = (parsed as { leases?: Lease[] }).leases;
    return Array.isArray(leases) ? leases : [];
  } catch {
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
  detail?: string;
};

export const POLICIES = {
  leaseWrite: { id: 'oa.lease.write', version: 'v1' },
  scopeViolation: { id: 'oa.scope.violation', version: 'v1' },
  effortClimb: { id: 'oa.effort.climb', version: 'v1' },
  effortRefused: { id: 'oa.effort.refused', version: 'v1' },
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
 * Decide whether one path may be written.
 *
 * The rules are the ones in the core package, not a second copy.
 */
export async function decideWrite(
  root: string,
  path: string,
  agent: string,
): Promise<WriteDecision> {
  const leases = await readLeases(root);
  if (leases.length === 0) {
    return {
      effect: 'deny',
      reason: 'the board has published no leases, so no file is leased. Ask the Lead for a lease.',
    };
  }

  const decision = decideFromLeases(leases, path, root, agent);
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

export type LockFile = {
  roles: Record<
    string,
    { model: string; ladder: LadderRung[]; evidence?: { label?: string; rank?: number } }
  >;
};

export async function loadLock(root: string): Promise<LockFile | undefined> {
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

export async function loadRole(root: string, name: string): Promise<RoleDefinition | undefined> {
  try {
    const roles = await loadRoles(join(root, 'roles.yaml'));
    return roles.roles[name];
  } catch {
    return undefined;
  }
}

/** The role name behind an OpenCode agent id, so oa-builder maps to builder. */
export function roleNameOf(agentId: string): string {
  return agentId.startsWith('oa-') ? agentId.slice(3) : agentId;
}
