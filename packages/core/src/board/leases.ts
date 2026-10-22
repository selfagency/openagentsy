import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isInsideRoot, matchesGlob, normalizePath, relativeToRoot } from '../paths.js';
import type { Lease, LeaseDecision } from './types.js';

type LeaseRow = {
  id: number;
  bean: string;
  agent: string;
  glob: string;
  granted_at: string;
};

function toLease(row: LeaseRow): Lease {
  return {
    id: row.id,
    bean: row.bean,
    agent: row.agent,
    glob: row.glob,
    grantedAt: row.granted_at,
  };
}

export type GrantLeasesInput = {
  bean: string;
  agent: string;
  globs: string[];
};

export type GrantLeasesResult = {
  granted: Lease[];
  conflicts: { glob: string; agent: string; bean: string }[];
};

/**
 * Record the files one agent owns.
 *
 * A glob already leased to a different agent is refused here. Partial
 * overlaps between two different globs cannot be decided without pattern
 * algebra, so those surface as a conflict in `checkLease` instead. The check
 * is the enforcement point, the grant records intent.
 */
export function grantLeases(db: DatabaseSync, input: GrantLeasesInput): GrantLeasesResult {
  const granted: Lease[] = [];
  const conflicts: { glob: string; agent: string; bean: string }[] = [];
  const grantedAt = new Date().toISOString();

  const findExact = db.prepare(
    `SELECT id, bean, agent, glob, granted_at FROM leases WHERE glob = ?`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO leases (bean, agent, glob, granted_at) VALUES (?, ?, ?, ?)`,
  );

  for (const rawGlob of input.globs) {
    const glob = normalizePath(rawGlob);
    if (glob.length === 0) continue;

    const existing = findExact.all(glob) as unknown as LeaseRow[];
    const taken = existing.find((row) => row.agent !== input.agent);
    if (taken) {
      conflicts.push({ glob, agent: taken.agent, bean: taken.bean });
      continue;
    }

    const result = insert.run(input.bean, input.agent, glob, grantedAt);
    if (result.changes > 0) {
      granted.push({
        id: Number(result.lastInsertRowid),
        bean: input.bean,
        agent: input.agent,
        glob,
        grantedAt,
      });
    }
  }

  return { granted, conflicts };
}

export function listLeases(db: DatabaseSync, bean?: string): Lease[] {
  const rows = (bean === undefined
    ? db.prepare(`SELECT id, bean, agent, glob, granted_at FROM leases ORDER BY id`)
    : db.prepare(`SELECT id, bean, agent, glob, granted_at FROM leases WHERE bean = ? ORDER BY id`)
  ).all(...(bean === undefined ? [] : [bean])) as unknown as LeaseRow[];
  return rows.map(toLease);
}

export type LeaseSnapshot = {
  updatedAt: string;
  leases: Lease[];
};

/**
 * Publish the leases as a plain file.
 *
 * The board owns the database, but the OpenCode plugin cannot read it: the
 * plugin runtime has no sqlite module, so a plugin that opens the database
 * fails to load at all. The plugin reads this file instead. The database stays
 * the source of truth and this file is written from it.
 */
export async function writeLeaseSnapshot(path: string, leases: Lease[]): Promise<void> {
  const snapshot: LeaseSnapshot = { updatedAt: new Date().toISOString(), leases };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export type CheckLeaseInput = {
  path: string;
  root: string;
  agent?: string;
};

export function decideFromLeases(
  leases: Lease[],
  path: string,
  root: string,
  agent: string | undefined,
): LeaseDecision {
  const relative = relativeToRoot(root, path);
  const matches = leases
    .filter((lease) => matchesGlob(lease.glob, relative))
    .sort((a, b) => b.glob.length - a.glob.length);

  const winner = matches[0];
  if (!winner) {
    return { path: relative, status: 'unleased' };
  }

  return {
    path: relative,
    status: agent !== undefined && agent !== winner.agent ? 'conflict' : 'leased',
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
export function checkLease(db: DatabaseSync, input: CheckLeaseInput): LeaseDecision {
  const absolute = isAbsolute(input.path) ? input.path : join(input.root, input.path);
  if (!isInsideRoot(input.root, absolute)) {
    return { path: normalizePath(input.path), status: 'unleased' };
  }
  return decideFromLeases(listLeases(db), absolute, input.root, input.agent);
}
