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
  ledgerFailed: { id: 'oa.ledger.failed', version: 'v1' },
  stateUnreadable: { id: 'oa.state.unreadable', version: 'v1' },
  eventsFailed: { id: 'oa.events.failed', version: 'v1' },
} as const;

export async function appendAudit(root: string, entry: AuditInput): Promise<void> {
  const path = auditPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

export type Rung = {
  /** The role the session runs under, for the lock lookup. */
  role: string;
  rungIndex: number;
  reason: string;
  updatedAt: string;
};

/**
 * The rungs, one per session.
 *
 * The state is keyed by the session and not by the role: the board allows
 * three writers at once, and two builders climbing would move each other's
 * effort level and give it back when either of them ended.
 */
export type RungState = Record<string, Rung>;

export async function readRungs(root: string): Promise<RungState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(rungsPath(root), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const state = parsed as Record<string, Partial<Rung> & { rungIndex?: number }>;
    // A file in the old shape is keyed by role and has no role in it. The
    // rungs are ephemeral, and a session rarely spans an upgrade, so the
    // old file is read as empty rather than guessed at.
    for (const rung of Object.values(state)) {
      if (typeof rung.role !== 'string') return {};
    }
    return state as RungState;
  } catch (error) {
    // A file that cannot be read is not a failure: a project that never
    // climbed has no file. A file that cannot be parsed is a failure, and
    // saying so saves a session of guessing.
    await reportUnreadable(root, rungsPath(root), error);
    return {};
  }
}

/**
 * The state files that could not be read, already reported.
 *
 * The rung file is read on every model request, so a file that cannot be
 * parsed would otherwise put the same line in the audit log on every turn.
 */
const reported = new Set<string>();

/**
 * Put an unreadable state file on the record.
 *
 * The audit log is the project's channel for anything that has to be
 * noticed, and a state file the guard cannot read is exactly that.
 *
 * The root comes from the caller. It used to be cut out of the path by
 * string surgery, and the lock file does not live under `.openagentsy/`, so
 * the cut produced a root of the file name minus its last character, and
 * the audit line landed in a directory nobody reads.
 */
async function reportUnreadable(root: string, path: string, error: unknown): Promise<void> {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
  if (reported.has(path)) return;
  reported.add(path);
  await appendAudit(root, {
    policyId: POLICIES.stateUnreadable.id,
    policyVersion: POLICIES.stateUnreadable.version,
    actor: 'guard',
    action: 'read',
    resource: path,
    effect: 'deny',
    detail: `the state file could not be read: ${(error as Error).message}`,
  });
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
 * The role key an agent id names.
 *
 * The Lead's agent id is 'agentsy' and its role key is 'lead'. A lock, a
 * rung and a trigger are all stored under the role key, so a lookup under
 * the agent id finds nothing at all. A name that is not a role keeps its own
 * spelling, so a custom agent still works.
 */
export async function roleKeyForAgent(root: string, agent: string): Promise<string> {
  try {
    const roles = await loadRoles(join(root, 'roles.yaml'));
    return roleKeyOf(roles, agent);
  } catch {
    return roleNameOf(agent);
  }
}

/**
 * The role key of every name, in one read of the roles file.
 *
 * A lease and a session name the same agent in different spellings, so both
 * are resolved to the role key before they are compared. The file is read
 * once for all of them.
 */
async function roleKeysOf(root: string, names: string[]): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  let roles: { roles: Record<string, RoleDefinition> };
  try {
    roles = await loadRoles(join(root, 'roles.yaml'));
  } catch {
    for (const name of names) keys.set(name, roleNameOf(name));
    return keys;
  }
  for (const name of names) keys.set(name, roleKeyOf(roles, name));
  return keys;
}

/**
 * The bean a session is working on.
 *
 * The board's bean id is the ledger's task id (§6.7), and the board is where
 * the adapter can learn the bean: a lease carries the bean and the agent
 * that holds it, and a session whose agent holds a lease is on that bean's
 * work.
 *
 * A session that holds no lease, or that holds leases on more than one
 * bean, has no bean that can be named: the answer is nothing rather than a
 * guess, because a wrong task id puts the usage on the wrong bean's bill.
 */
export async function activeBean(root: string, agent: string): Promise<string | undefined> {
  const leases = readLeases(root);
  if (leases.length === 0) return undefined;
  const keys = await roleKeysOf(root, [agent, ...leases.map((lease) => lease.agent)]);
  const role = keys.get(agent);
  if (role === undefined) return undefined;
  const beans = new Set<string>();
  for (const lease of leases) {
    if (keys.get(lease.agent) !== role) continue;
    beans.add(lease.bean);
  }
  if (beans.size !== 1) return undefined;
  const [bean] = [...beans];
  return bean;
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
export async function planClimb(
  root: string,
  role: string,
  sessionID: string,
  reason: string,
): Promise<ClimbPlan> {
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
  const current = rungs[sessionID]?.rungIndex ?? 0;
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
  sessionID: string,
  role: string,
  rungIndex: number,
  reason: string,
): Promise<void> {
  const rungs = await readRungs(root);
  rungs[sessionID] = { role, rungIndex, reason, updatedAt: new Date().toISOString() };
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
  const path = join(root, 'openagentsy.models.lock.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as LockFile;
  } catch (error) {
    await reportUnreadable(root, path, error);
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
  sessionID: string,
): Promise<{ model: string; variant?: string } | undefined> {
  const rungs = await readRungs(root);
  const rung = rungs[sessionID];
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
