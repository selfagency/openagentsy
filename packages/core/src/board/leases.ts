import { isAbsolute, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { isInsideRoot, matchesGlob, normalizePath, relativeToRoot } from '../paths.js';
import type { BoardDatabase } from './db.js';
import { leases } from './schema.js';
import type { Lease, LeaseDecision } from './types.js';

/**
 * The name an agent is known by.
 *
 * The session's agent name and the name in a lease are the same agent even
 * when they are spelled differently: the session says `OpenCoder` and the
 * role file says `oa-builder`. The comparison is on the lowercased name, so a
 * lease that was granted under one spelling is still the lease of that
 * agent under the other.
 */
export function sameAgent(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export type GrantLeasesInput = {
  bean: string;
  agent: string;
  globs: string[];
};

export type GrantLeasesResult = {
  granted: Lease[];
  conflicts: { glob: string; agent: string; bean: string }[];
  /**
   * The writers already on the board, when the grant would put one more over
   * the cap. The grant is refused: the writers are capped, not suggested.
   */
  capReached?: { writers: number; cap: number } | undefined;
};

/**
 * The number of writers on the board.
 *
 * A writer is an agent that holds at least one lease. A scout that reads
 * holds none, so it never counts.
 */
export function writerCount(db: BoardDatabase): number {
  const rows = db.selectDistinct({ agent: leases.agent }).from(leases).all();
  return rows.length;
}

function holdsAnyLease(db: BoardDatabase, agent: string): boolean {
  const row = db
    .select({ id: leases.id })
    .from(leases)
    .where(eq(leases.agent, agent))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * Record the files one agent owns.
 *
 * A glob already leased to a different agent is refused here. Partial
 * overlaps between two different globs cannot be decided without pattern
 * algebra, so those surface as a conflict in `checkLease` instead. The check
 * is the enforcement point, the grant records intent.
 */
export function grantLeases(
  db: BoardDatabase,
  input: GrantLeasesInput,
  options: { writerCap?: number } = {},
): GrantLeasesResult {
  const granted: Lease[] = [];
  const conflicts: { glob: string; agent: string; bean: string }[] = [];
  const grantedAt = new Date().toISOString();
  const cap = options.writerCap;

  for (const rawGlob of input.globs) {
    const glob = normalizePath(rawGlob);
    if (glob.length === 0) continue;

    const existing = db.select().from(leases).where(eq(leases.glob, glob)).all();
    const taken = existing.find((row) => !sameAgent(row.agent, input.agent));
    if (taken) {
      conflicts.push({ glob, agent: taken.agent, bean: taken.bean });
      continue;
    }

    // The cap counts writers, and only a new writer counts. The Lead grants
    // leases to the writers of the plan, and three is the number the plan
    // allows at once.
    if (cap !== undefined && existing.length === 0) {
      const writers = writerCount(db);
      const alreadyAWriter = writers > 0 && holdsAnyLease(db, input.agent);
      if (!alreadyAWriter && writers >= cap) {
        return { granted, conflicts, capReached: { writers, cap } };
      }
    }

    const inserted = db
      .insert(leases)
      .values({ bean: input.bean, agent: input.agent, glob, grantedAt })
      .onConflictDoNothing()
      .returning()
      .get();
    if (inserted) granted.push(inserted);
  }

  return { granted, conflicts };
}

export type ReleaseLeaseInput = {
  bean: string;
  agent: string;
  glob: string;
};

/**
 * Give a lease back.
 *
 * A lease that is never given back is a file nobody can write, and a session
 * that died holding one leaves its files locked for good. The release names
 * the bean, the agent and the glob, so a release of somebody else's lease is
 * refused: the holder gives it back, not the other way round.
 */
export function releaseLease(
  db: BoardDatabase,
  input: ReleaseLeaseInput,
): { released: boolean; lease?: Lease } {
  const glob = normalizePath(input.glob);
  const held = db
    .select()
    .from(leases)
    .where(and(eq(leases.glob, glob), eq(leases.agent, input.agent), eq(leases.bean, input.bean)))
    .get();
  if (!held) return { released: false };

  db.delete(leases).where(eq(leases.id, held.id)).run();
  return { released: true, lease: held };
}

export function listLeases(db: BoardDatabase, bean?: string): Lease[] {
  const rows =
    bean === undefined
      ? db.select().from(leases).orderBy(leases.id).all()
      : db.select().from(leases).where(eq(leases.bean, bean)).orderBy(leases.id).all();
  return rows as Lease[];
}

export type CheckLeaseInput = {
  path: string;
  root: string;
  agent?: string;
};

export function decideFromLeases(
  leaseList: Lease[],
  path: string,
  root: string,
  agent: string | undefined,
): LeaseDecision {
  const relative = relativeToRoot(root, path);
  const matches = leaseList
    .filter((lease) => matchesGlob(lease.glob, relative))
    .sort((a, b) => b.glob.length - a.glob.length);

  const winner = matches[0];
  if (!winner) {
    return { path: relative, status: 'unleased' };
  }

  return {
    path: relative,
    status: agent !== undefined && !sameAgent(agent, winner.agent) ? 'conflict' : 'leased',
    agent: winner.agent,
    bean: winner.bean,
    glob: winner.glob,
  };
}

/**
 * Decide whether one path may be written, reading the leases from the board.
 *
 * The most specific matching glob wins, so `src/api/**` beats `src/**`. When
 * the holder is a different agent the answer is a conflict, not a permission.
 */
export function checkLease(db: BoardDatabase, input: CheckLeaseInput): LeaseDecision {
  const absolute = isAbsolute(input.path) ? input.path : join(input.root, input.path);
  if (!isInsideRoot(input.root, absolute)) {
    return { path: normalizePath(input.path), status: 'unleased' };
  }
  return decideFromLeases(listLeases(db), absolute, input.root, input.agent);
}
